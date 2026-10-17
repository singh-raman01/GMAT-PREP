import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema, Semaphore } from "effect"
import { Named, SessionId } from "../../api/Practice.ts"
import {
  DailyLogDay,
  DailyLogView,
  DaySettingsView,
  DiagnosticView,
  PlanDayView,
  PlanItemId,
  PlanItemIsLesson,
  PlanItemNotFound,
  PlanItemNotOpen,
  PlanItemView,
  PlanSettingsInvalid,
  type PlanSettingsInput,
  PlanSettingsView,
  PlanStarted,
  PlanView,
  TargetsView
} from "../../api/Plan.ts"
import { InvalidTimeZone } from "../../api/Profiles.ts"
import { type DayRule, nextRolloverUnder, studyDaysUnder, studyDayStartUnder } from "../../api/studyDay.ts"
import { DefaultTargetSeconds } from "../../api/targetTimes.ts"
import { Analytics } from "../analytics/Analytics.ts"
import { Db } from "../db/Database.ts"
import { dailyNotes, lessonViews, planItems, planSettings, planVersions, profileDays, sessions } from "../db/schema.ts"
import { Retries } from "../learning/Retries.ts"
import { Lessons, minutesFor } from "../lessons/Lessons.ts"
import { CheckCount } from "../lessons/pick.ts"
import { namesOf } from "../practice/content.ts"
import { type Caller, Practice } from "../practice/Practice.ts"
import { dayRulesOf, DefaultRules } from "../profiles/days.ts"
import { sectionTargetOf } from "../ratings/scale.ts"
import { Scores } from "../ratings/Scores.ts"
import { Mocks } from "../sections/Mocks.ts"
import { Sectionals } from "../sections/Sectionals.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import {
  buildPlan,
  dayNumber,
  dayOfNumber,
  type DiagnosticState,
  type LessonState,
  MockMinutes,
  type Plan,
  type PlanDay,
  type PlanInputs,
  type PlannedItem,
  setMinutes,
  WarmUpRated
} from "./build.ts"

// The Study Plan service (docs/design.md, "Study Plan, Diagnostic and Daily
// Log", decisions 81 to 91): reads the Profile's settings and state, writes a
// new plan version when what it was built on has changed, starts its items
// and keeps the Daily Log.

// The Daily Log looks back this many Study Days.
const LogDays = 90

const PlannedJson = Schema.fromJsonString(Schema.Unknown)
const decodeJson = Schema.decodeUnknownSync(PlannedJson)
const readJson = <A>(text: string) => decodeJson(text) as A

interface Outline {
  readonly notes: ReadonlyArray<string>
  readonly days: ReadonlyArray<Omit<PlanDay, "items">>
}

// When to build again (decision 90): a new Study Day, new settings, a Mock
// finished, the Diagnostic's state, or a Section reaching 20 Rated Responses.
interface Basis {
  readonly day: string
  readonly settings: string
  readonly mocks: number
  readonly diagnostic: DiagnosticState
  readonly diagnosticSections: ReadonlyArray<string>
  readonly warm: ReadonlyArray<boolean>
  // The Weak Areas' approved Lessons, and whether each is done.
  readonly lessons: ReadonlyArray<readonly [string, boolean, boolean]>
}

const isTimeZone = (timeZone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone })
    return true
  } catch {
    return false
  }
}

export class Plans extends Context.Service<Plans, {
  view(profileId: string): Effect.Effect<PlanView>
  saveSettings(profileId: string, input: PlanSettingsInput): Effect.Effect<PlanView, PlanSettingsInvalid | InvalidTimeZone>
  skipDiagnostic(profileId: string): Effect.Effect<PlanView>
  start(
    caller: Caller,
    id: PlanItemId,
    order: ReadonlyArray<string> | undefined
  ): Effect.Effect<PlanStarted, PlanStartError>
  dailyLog(profileId: string): Effect.Effect<DailyLogView>
  writeNote(profileId: string, day: string, note: string): Effect.Effect<DailyLogDay>
}>()("gmat-prep/server/Plans") {
  static readonly layer = Layer.effect(
    Plans,
    Effect.gen(function*() {
      const db = yield* Db
      const analytics = yield* Analytics
      const retries = yield* Retries
      const lessons = yield* Lessons
      const practice = yield* Practice
      const sectionals = yield* Sectionals
      const mocks = yield* Mocks
      const scores = yield* Scores
      const taxonomy = (yield* Taxonomy).view
      const names = namesOf(taxonomy)
      const sectionIds = taxonomy.sections.map((section) => section.id)
      const named = (id: string) => names.named(id)
      const run = <A, E>(effect: Effect.Effect<A, E, Db>) => effect.pipe(Effect.provideService(Db, db), Effect.orDie)
      // One build at a time, so two reads at once write one version.
      const oneAtATime = (yield* Semaphore.make(1)).withPermits(1)

      const settingsRowOf = (profileId: string) =>
        db.select().from(planSettings).where(eq(planSettings.profileId, profileId))
          .orderBy(desc(planSettings.setAt), desc(sql`${planSettings}.rowid`)).limit(1)
          .pipe(Effect.orDie, Effect.map((rows) => rows[0]))

      const rulesOf = (profileId: string) => run(dayRulesOf(profileId)).pipe(Effect.map((rules) => rules ?? DefaultRules))

      // The Sessions started from plan items: each item's latest, and
      // whether it ended.
      const startedOf = (profileId: string) =>
        db.select({ id: sessions.id, planItemId: sessions.planItemId, status: sessions.status, kind: sessions.kind, finishedAt: sessions.finishedAt })
          .from(sessions).where(and(eq(sessions.profileId, profileId), isNotNull(sessions.planItemId)))
          .orderBy(asc(sessions.createdAt))
          .pipe(
            Effect.orDie,
            Effect.map((rows) => new Map(rows.map((row) => [row.planItemId!, row] as const)))
          )

      // A Lesson item's page opened, or marked read, from the item.
      const lessonMarksOf = (profileId: string) =>
        db.select({ planItemId: lessonViews.planItemId, kind: lessonViews.kind, at: lessonViews.viewedAt }).from(lessonViews)
          .where(and(eq(lessonViews.profileId, profileId), isNotNull(lessonViews.planItemId)))
          .pipe(
            Effect.orDie,
            Effect.map((rows) => {
              const marks = new Map<string, { opened: boolean; readAt: number | null }>()
              for (const row of rows) {
                const mark = marks.get(row.planItemId!) ?? { opened: false, readAt: null }
                if (row.kind === "read") mark.readAt = Math.min(mark.readAt ?? row.at, row.at)
                else mark.opened = true
                marks.set(row.planItemId!, mark)
              }
              return marks as ReadonlyMap<string, { readonly opened: boolean; readonly readAt: number | null }>
            })
          )

      // Where each item stands: the Sessions started from items, and the
      // Lesson pages opened from them.
      const progressOf = (profileId: string) =>
        Effect.gen(function*() {
          return { sessions: yield* startedOf(profileId), marks: yield* lessonMarksOf(profileId) }
        })
      type Progress = Effect.Success<ReturnType<typeof progressOf>>

      // An item's state: a Session's from it ends it, as does marking a
      // Lesson's methods read from it; a whole Lesson ends with its check.
      const statusOf = (row: { readonly id: string; readonly item: string; readonly status: string }, progress: Progress) => {
        if (row.status === "dropped") return "dropped" as const
        const item = readJson<PlannedItem>(row.item)
        const session = progress.sessions.get(row.id)
        const mark = progress.marks.get(row.id)
        if (item.kind === "lesson" && item.lesson?.part === "methods") {
          return mark?.readAt != null ? "done" as const : mark?.opened === true ? "started" as const : "planned" as const
        }
        if (session !== undefined) return session.status === "finished" ? "done" as const : "started" as const
        return mark?.opened === true ? "started" as const : "planned" as const
      }

      // When an item was done, if it was.
      const doneAt = (row: { readonly id: string; readonly item: string; readonly status: string }, progress: Progress) => {
        if (statusOf(row, progress) !== "done") return undefined
        return progress.sessions.get(row.id)?.finishedAt ?? progress.marks.get(row.id)?.readAt ?? undefined
      }

      // What the Profile has done with the approved Lessons on these
      // subjects (decision 101): the whole Lesson once a check of it ended,
      // the methods once any part was marked read.
      const lessonStatesOf = (profileId: string, subjects: ReadonlySet<string>) =>
        Effect.gen(function*() {
          const approved = [...(yield* lessons.approved).values()].filter((lesson) => subjects.has(lesson.subjectId))
          if (approved.length === 0) return [] as ReadonlyArray<LessonState>
          const ids = approved.map((lesson) => lesson.id)
          const checked = new Set(
            (yield* db.select({ lessonId: sql<string | null>`json_extract(${sessions.config}, '$.lesson.id')` }).from(sessions)
              .where(and(eq(sessions.profileId, profileId), eq(sessions.kind, "practice"), eq(sessions.status, "finished")))
              .pipe(Effect.orDie)).flatMap((row) => (row.lessonId === null ? [] : [row.lessonId]))
          )
          const read = new Set(
            (yield* db.select({ lessonId: lessonViews.lessonId }).from(lessonViews)
              .where(and(eq(lessonViews.profileId, profileId), eq(lessonViews.kind, "read"), inArray(lessonViews.lessonId, ids)))
              .pipe(Effect.orDie)).map((row) => row.lessonId)
          )
          return approved.map((lesson): LessonState => {
            const section = lesson.subjectId.slice(0, lesson.subjectId.indexOf("."))
            return {
              subject: lesson.subjectId,
              lessonId: lesson.id,
              minutes: minutesFor(lesson.words) + setMinutes(CheckCount, (DefaultTargetSeconds[section] ?? 120) * 1000),
              methodsMinutes: minutesFor(lesson.methodsWords),
              done: checked.has(lesson.id),
              methodsDone: checked.has(lesson.id) || read.has(lesson.id)
            }
          })
        })

      // How many more times each Section's Questions can be served in a Mock
      // or Sectional: the fewest of its Blueprint groups' unseen over needed.
      const allowedOf = (profileId: string) =>
        sectionals.readinessAll(profileId).pipe(
          Effect.map((sections) =>
            Object.fromEntries(sections.map((section) => [
              section.section.id,
              Math.min(...section.groups.map((group) => Math.floor(group.unseen / Math.max(1, group.needed))))
            ]))
          )
        )

      // The Diagnostic (decision 89): done once a Mock is finished, or the
      // three Diagnostic Sectionals; else skipped, blocked while no Mock can
      // start, or pending with the Sections still to take.
      const diagnosticOf = (
        profileId: string,
        skipped: boolean,
        allowed: Readonly<Record<string, number>>,
        started: ReadonlyMap<string, { readonly status: string; readonly kind: string }>
      ) =>
        Effect.gen(function*() {
          const finishedMocks = yield* db.select({ id: sessions.id }).from(sessions)
            .where(and(eq(sessions.profileId, profileId), eq(sessions.kind, "mock"), eq(sessions.status, "finished")))
            .pipe(Effect.orDie)
          const sectionalIds = [...started].filter(([, session]) => session.kind === "sectional" && session.status === "finished")
            .map(([itemId]) => itemId)
          const diagnosticSectionals = sectionalIds.length === 0
            ? []
            : yield* db.select({ item: planItems.item }).from(planItems).where(inArray(planItems.id, sectionalIds)).pipe(Effect.orDie)
          const sectionsDone = new Set(
            diagnosticSectionals.map((row) => readJson<PlannedItem>(row.item)).filter((each) => each.diagnostic).map((each) => each.section!)
          )
          const left = sectionIds.filter((section) => !sectionsDone.has(section))
          const state: DiagnosticState = finishedMocks.length > 0 || left.length === 0
            ? "done"
            : skipped
            ? "skipped"
            : sectionIds.some((section) => (allowed[section] ?? 0) < 1)
            ? "blocked"
            : "pending"
          return { state, sectionsLeft: state === "pending" ? left : [], mocks: finishedMocks.length }
        })

      // What the plan is built from now (decision 83).
      const snapshot = (profileId: string, row: typeof planSettings.$inferSelect) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const rules = yield* rulesOf(profileId)
          const dayOf = studyDaysUnder(rules)
          const today = dayOf(now)
          const found = yield* analytics.planAnalytics(profileId)
          const forecast = yield* retries.forecast(profileId)
          const allowed = yield* allowedOf(profileId)
          const progress = yield* progressOf(profileId)
          const started = progress.sessions
          const diagnostic = yield* diagnosticOf(profileId, row.diagnosticSkipped, allowed, started)
          // Today's planned work already done, from any version: Sessions
          // ended today, and Lesson methods marked read today.
          const doneIds = [
            ...[...started].filter(([, session]) =>
              session.status === "finished" && session.finishedAt !== null && dayOf(session.finishedAt) === today
            ).map(([itemId]) => itemId),
            ...[...progress.marks].filter(([, mark]) => mark.readAt !== null && dayOf(mark.readAt) === today).map(([itemId]) => itemId)
          ]
          const doneItems = (doneIds.length === 0
            ? []
            : yield* db.select({ id: planItems.id, item: planItems.item, status: planItems.status, minutes: planItems.minutes })
              .from(planItems).where(inArray(planItems.id, doneIds)).pipe(Effect.orDie))
            .filter((each) => statusOf(each, progress) === "done")
          const lessonStates = yield* lessonStatesOf(profileId, new Set(found.weakAreas.map((area) => area.id)))
          const mockToday = (yield* db.select({ finishedAt: sessions.finishedAt }).from(sessions)
            .where(and(eq(sessions.profileId, profileId), eq(sessions.kind, "mock"), eq(sessions.status, "finished")))
            .pipe(Effect.orDie)).some((mock) => mock.finishedAt !== null && dayOf(mock.finishedAt) === today)
          const inputs: PlanInputs = {
            settings: {
              testDate: row.testDate,
              targetTotal: row.targetTotal,
              weeklyMinutes: row.weeklyMinutes,
              daysOff: readJson<ReadonlyArray<number>>(row.daysOff)
            },
            state: {
              today: dayOfNumber(today),
              sections: found.sections.map((section) => ({
                id: section.id,
                ability: section.ability === null ? null : Math.round(section.ability * 1000) / 1000,
                rated: section.rated,
                paceMs: (DefaultTargetSeconds[section.id] ?? 120) * 1000
              })),
              weakAreas: found.weakAreas.map((area) => ({ ...area, ability: Math.round(area.ability * 1000) / 1000 })),
              retries: forecast.map((retry) => ({
                day: dayOfNumber(Math.max(today, retry.dueDay)),
                timed: retry.timed,
                minutes: retry.minutes,
                priority: retry.priority
              })),
              allowed,
              diagnostic: diagnostic.state,
              diagnosticSections: diagnostic.sectionsLeft,
              doneToday: doneItems.reduce((sum, item) => sum + item.minutes, 0),
              mockToday,
              lessons: lessonStates
            }
          }
          const basis: Basis = {
            day: dayOfNumber(today),
            settings: row.id,
            mocks: diagnostic.mocks,
            diagnostic: diagnostic.state,
            diagnosticSections: diagnostic.sectionsLeft,
            warm: found.sections.map((section) => section.rated >= WarmUpRated),
            lessons: lessonStates.map((lesson) => [lesson.lessonId, lesson.done, lesson.methodsDone] as const)
          }
          return { inputs, basis, today, rules, now, started, progress }
        })

      // The latest version, built again first when its basis has changed.
      const ensure = (profileId: string) =>
        Effect.gen(function*() {
          const row = yield* settingsRowOf(profileId)
          if (row === undefined) return undefined
          const found = yield* snapshot(profileId, row)
          const [latest] = yield* db.select().from(planVersions).where(eq(planVersions.profileId, profileId))
            .orderBy(desc(planVersions.version)).limit(1).pipe(Effect.orDie)
          const basis = JSON.stringify(found.basis)
          if (latest !== undefined && latest.basis === basis) return { version: latest, ...found }
          const plan = buildPlan(found.inputs)
          const version = {
            id: crypto.randomUUID(),
            profileId,
            version: (latest?.version ?? 0) + 1,
            builtAt: found.now,
            fromDay: found.inputs.state.today,
            basis,
            inputs: JSON.stringify(found.inputs),
            outline: JSON.stringify({
              notes: plan.notes,
              days: plan.days.map(({ items: _, ...day }) => day)
            } satisfies Outline)
          }
          yield* db.transaction(() =>
            Effect.gen(function*() {
              yield* db.insert(planVersions).values(version)
              const rows = [
                ...plan.days.flatMap((day) =>
                  day.items.map((each, position) => ({ each, position, status: "planned" as const, reason: null }))
                ),
                ...plan.dropped.map((each, position) => ({ each, position: 1000 + position, status: "dropped" as const, reason: each.reason }))
              ]
              if (rows.length > 0) {
                yield* db.insert(planItems).values(rows.map(({ each, position, status, reason }) => ({
                  id: crypto.randomUUID(),
                  versionId: version.id,
                  day: each.day,
                  position,
                  kind: each.kind,
                  item: JSON.stringify(each),
                  minutes: each.minutes,
                  status,
                  reason
                })))
              }
            })
          ).pipe(Effect.orDie)
          return { version, ...found }
        }).pipe(oneAtATime)

      const sectionName = (id: string) => named(id)

      const titleOf = (item: PlannedItem) => {
        switch (item.kind) {
          case "mock":
            return item.diagnostic ? "Diagnostic Mock" : "Mock"
          case "sectional":
            return `${item.diagnostic ? "Diagnostic: " : ""}${sectionName(item.section!).name} Sectional`
          case "retries":
            return `${item.timed ? "Timed Retries" : "Retries"}, ${item.count} ${item.count === 1 ? "Question" : "Questions"}`
          case "lesson":
            return item.lesson!.part === "methods"
              ? `Lesson: ${named(item.lesson!.subject).name}, the ways to solve it`
              : `Lesson: ${named(item.lesson!.subject).name}`
          case "practice": {
            const params = item.practice!
            const what = params.trapPattern !== undefined
              ? `Trap Pattern: ${named(params.trapPattern).name}`
              : params.skill !== undefined
              ? named(params.skill).name
              : params.questionType !== undefined
              ? named(params.questionType).name
              : sectionName(params.section).name
            return `${what}, ${params.size} Questions, ${params.timed ? "timed" : "untimed"}`
          }
        }
      }

      const remedyName = (remedy: string | null) =>
        remedy === null ? null : remedy === "slow" ? new Named({ id: "slow", name: "Slow" }) : named(remedy)

      const itemView = (
        row: { readonly id: string; readonly item: string; readonly status: string; readonly reason: string | null },
        progress: Progress
      ) => {
        const item = readJson<PlannedItem>(row.item)
        const session = progress.sessions.get(row.id)
        const status = statusOf(row, progress)
        return new PlanItemView({
          id: PlanItemId.make(row.id),
          day: item.day,
          kind: item.kind,
          diagnostic: item.diagnostic,
          title: titleOf(item),
          timed: item.timed,
          section: item.section !== null
            ? sectionName(item.section)
            : item.practice !== null
            ? sectionName(item.practice.section)
            : null,
          questions: item.kind === "retries" ? item.count : item.practice?.size ?? null,
          weakArea: item.weakArea === null
            ? null
            : { kind: item.weakArea.kind, scope: named(item.weakArea.id), priority: item.weakArea.priority },
          remedy: remedyName(item.remedy),
          minutes: item.minutes,
          status,
          reason: row.reason,
          sessionId: session === undefined ? null : SessionId.make(session.id),
          lesson: item.lesson === null || item.lesson === undefined
            ? null
            : { subject: named(item.lesson.subject), part: item.lesson.part }
        })
      }

      const daySettingsOf = (rules: ReadonlyArray<DayRule>, now: number) => {
        const current = [...rules].reverse().find((rule) => rule.from <= now) ?? rules[0]!
        const pending = rules.at(-1)!.from > now ? rules.at(-1)! : undefined
        return new DaySettingsView({
          timeZone: current.timeZone,
          rolloverHour: current.rolloverHour,
          pending: pending === undefined ? null : { timeZone: pending.timeZone, rolloverHour: pending.rolloverHour, from: pending.from }
        })
      }

      const targetsOf = (profileId: string, total: number | null) =>
        Effect.gen(function*() {
          if (total === null) return null
          const estimates = yield* scores.estimates(profileId)
          const target = sectionTargetOf(total)
          return new TargetsView({
            total,
            sections: sectionIds.map((section) => ({
              section: sectionName(section),
              target,
              estimate: estimates.sections.find((each) => each.section.id === section)?.score ?? null
            }))
          })
        })

      const view = (profileId: string) =>
        Effect.gen(function*() {
          const ensured = yield* ensure(profileId)
          const now = yield* Clock.currentTimeMillis
          const rules = yield* rulesOf(profileId)
          if (ensured === undefined) {
            const today = studyDaysUnder(rules)(now)
            const allowed = yield* allowedOf(profileId)
            const diagnostic = yield* diagnosticOf(profileId, false, allowed, yield* startedOf(profileId))
            return new PlanView({
              today: dayOfNumber(today),
              settings: null,
              days: daySettingsOf(rules, now),
              version: null,
              builtAt: null,
              plan: [],
              dropped: [],
              notes: [],
              diagnostic: new DiagnosticView({ state: diagnostic.state, form: "mock", sectionsLeft: diagnostic.sectionsLeft.map(sectionName) }),
              targets: null
            })
          }
          const { version, inputs, progress } = ensured
          const settingsRow = (yield* settingsRowOf(profileId))!
          const outline = readJson<Outline>(version.outline)
          const rows = yield* db.select().from(planItems).where(eq(planItems.versionId, version.id))
            .orderBy(asc(planItems.day), asc(planItems.position)).pipe(Effect.orDie)
          const today = inputs.state.today
          // Today's items done from an earlier version stay on today's list.
          const earlierToday = yield* db.select({ id: planItems.id, item: planItems.item, status: planItems.status, reason: planItems.reason })
            .from(planItems).innerJoin(planVersions, eq(planVersions.id, planItems.versionId))
            .where(and(eq(planVersions.profileId, profileId), eq(planItems.day, today), eq(planItems.status, "planned")))
            .pipe(Effect.orDie)
          const doneEarlier = earlierToday.filter((row) => statusOf(row, progress) === "done" && !rows.some((each) => each.id === row.id))
          const planned = rows.filter((row) => row.status === "planned")
          const days = outline.days.filter((day) => day.day >= today).map((day) =>
            new PlanDayView({
              ...day,
              items: [
                ...(day.day === today ? doneEarlier : []).map((row) => itemView(row, progress)),
                ...planned.filter((row) => row.day === day.day).map((row) => itemView(row, progress))
              ]
            })
          )
          const weekly = inputs.settings.weeklyMinutes
          return new PlanView({
            today,
            settings: new PlanSettingsView({
              testDate: settingsRow.testDate,
              targetTotal: settingsRow.targetTotal,
              weeklyMinutes: settingsRow.weeklyMinutes,
              daysOff: readJson<ReadonlyArray<number>>(settingsRow.daysOff),
              diagnosticSkipped: settingsRow.diagnosticSkipped
            }),
            days: daySettingsOf(rules, now),
            version: version.version,
            builtAt: version.builtAt,
            plan: days,
            dropped: rows.filter((row) => row.status === "dropped").map((row) => itemView(row, progress)),
            notes: outline.notes,
            diagnostic: new DiagnosticView({
              state: inputs.state.diagnostic,
              form: weekly >= MockMinutes && inputs.state.diagnosticSections.length === sectionIds.length ? "mock" : "sectionals",
              sectionsLeft: inputs.state.diagnosticSections.map(sectionName)
            }),
            targets: yield* targetsOf(profileId, settingsRow.targetTotal)
          })
        })

      const saveSettings = (profileId: string, input: PlanSettingsInput) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          if (!isTimeZone(input.timeZone)) return yield* new InvalidTimeZone({ timeZone: input.timeZone })
          const rules = yield* rulesOf(profileId)
          const today = studyDaysUnder(rules)(now)
          const problems = [
            ...(new Set(input.daysOff).size >= 7 ? ["Keep at least one day of the week for study."] : []),
            ...(input.testDate !== null && dayNumber(input.testDate) <= today ? ["Choose a test date after today."] : [])
          ]
          if (problems.length > 0) return yield* new PlanSettingsInvalid({ problems })
          const previous = yield* settingsRowOf(profileId)
          yield* db.insert(planSettings).values({
            id: crypto.randomUUID(),
            profileId,
            testDate: input.testDate,
            targetTotal: input.targetTotal,
            weeklyMinutes: input.weeklyMinutes,
            daysOff: JSON.stringify([...new Set(input.daysOff)].toSorted()),
            diagnosticSkipped: previous?.diagnosticSkipped ?? false,
            setAt: now
          }).pipe(Effect.orDie)
          // A time zone or rollover change applies from the next rollover.
          const current = [...rules].reverse().find((rule) => rule.from <= now) ?? rules[0]!
          const latest = rules.at(-1)!
          if (latest.timeZone !== input.timeZone || latest.rolloverHour !== input.rolloverHour) {
            const settled = rules.filter((rule) => rule.from <= now)
            const back = current.timeZone === input.timeZone && current.rolloverHour === input.rolloverHour
            yield* db.insert(profileDays).values({
              id: crypto.randomUUID(),
              profileId,
              timeZone: input.timeZone,
              rolloverHour: input.rolloverHour,
              // Undoing a change still waiting puts the current rule back at
              // that same rollover.
              from: back && latest.from > now ? latest.from : nextRolloverUnder(settled, now),
              setAt: now
            }).pipe(Effect.orDie)
          }
          return yield* view(profileId)
        })

      const skipDiagnostic = (profileId: string) =>
        Effect.gen(function*() {
          const row = yield* settingsRowOf(profileId)
          const now = yield* Clock.currentTimeMillis
          if (row !== undefined && !row.diagnosticSkipped) {
            yield* db.insert(planSettings).values({ ...row, id: crypto.randomUUID(), diagnosticSkipped: true, setAt: now })
              .pipe(Effect.orDie)
          }
          return yield* view(profileId)
        })

      const start = (caller: Caller, id: PlanItemId, order: ReadonlyArray<string> | undefined) =>
        Effect.gen(function*() {
          const [found] = yield* db.select({ item: planItems, version: planVersions }).from(planItems)
            .innerJoin(planVersions, eq(planVersions.id, planItems.versionId))
            .where(and(eq(planItems.id, id), eq(planVersions.profileId, caller.profileId))).pipe(Effect.orDie)
          if (found === undefined) return yield* new PlanItemNotFound()
          const item = readJson<PlannedItem>(found.item.item)
          if (item.kind === "lesson") return yield* new PlanItemIsLesson()
          const planView = yield* view(caller.profileId)
          const started = (yield* startedOf(caller.profileId)).get(id)
          // A Session started from it and not ended is the one to go back to.
          if (started !== undefined && started.status !== "finished") {
            return new PlanStarted({
              kind: started.kind === "mock" ? "mock" : started.kind === "sectional" ? "sectional" : "practice",
              id: SessionId.make(started.id)
            })
          }
          const current = planView.plan.find((day) => day.day === planView.today)?.items.find((each) => each.id === id)
          if (current === undefined || current.status !== "planned") {
            return yield* new PlanItemNotOpen({
              status: current?.status ?? (found.item.status === "dropped" ? "dropped" : started !== undefined ? "done" : "planned"),
              day: item.day,
              plan: planView
            })
          }
          switch (item.kind) {
            case "mock": {
              const mock = yield* mocks.start(caller, order ?? sectionIds, id)
              return new PlanStarted({ kind: "mock", id: mock.id })
            }
            case "sectional": {
              const sectional = yield* sectionals.start(caller, item.section!, id)
              return new PlanStarted({ kind: "sectional", id: sectional.id })
            }
            case "retries": {
              const set = yield* retries.start(caller, item.timed, { ...(item.count === null ? {} : { limit: item.count }), planItemId: id })
              return new PlanStarted({ kind: "practice", id: set.id })
            }
            case "practice": {
              const params = item.practice!
              const set = yield* practice.start(caller, {
                kind: "filters",
                status: "any",
                size: params.size,
                section: params.section,
                near: params.near,
                ...(params.timed ? { timed: true } : {}),
                ...(params.skill === undefined ? {} : { skill: params.skill }),
                ...(params.questionType === undefined ? {} : { questionType: params.questionType }),
                ...(params.trapPattern === undefined ? {} : { trapPattern: params.trapPattern })
              }, id)
              return new PlanStarted({ kind: "practice", id: set.id })
            }
          }
        })

      // The Daily Log (decision 91).
      const dailyLog = (profileId: string) =>
        Effect.gen(function*() {
          // Building first keeps today's items current.
          yield* ensure(profileId)
          const now = yield* Clock.currentTimeMillis
          const rules = yield* rulesOf(profileId)
          const today = studyDaysUnder(rules)(now)
          const from = today - LogDays + 1
          const study = yield* analytics.study(profileId)
          const progress = yield* progressOf(profileId)
          const versions = yield* db.select().from(planVersions).where(eq(planVersions.profileId, profileId))
            .orderBy(asc(planVersions.version)).pipe(Effect.orDie)
          const rows = versions.length === 0
            ? []
            : yield* db.select().from(planItems)
              .where(and(inArray(planItems.versionId, versions.map((version) => version.id)), eq(planItems.status, "planned")))
              .orderBy(asc(planItems.position)).pipe(Effect.orDie)
          const notes = yield* db.select().from(dailyNotes).where(eq(dailyNotes.profileId, profileId))
            .orderBy(asc(dailyNotes.writtenAt), asc(sql`${dailyNotes}.rowid`)).pipe(Effect.orDie)
          const noteOf = new Map(notes.map((note) => [note.day, note.note] as const))
          const days = new Set<number>([
            today,
            ...study.days.map((day) => dayNumber(day.day)),
            ...rows.map((row) => dayNumber(row.day)).filter((day) => day <= today),
            ...notes.map((note) => dayNumber(note.day))
          ])
          const logDay = (day: number) => {
            const text = dayOfNumber(day)
            // The last version built before the day ended, among those that
            // plan it; the day's done items from any version join it.
            const ends = studyDayStartUnder(rules, day + 1)
            const version = versions.filter((each) => each.builtAt < ends && each.fromDay <= text).at(-1)
            const forDay = rows.filter((row) => row.day === text)
            const shown = forDay.filter((row) => row.versionId === version?.id || statusOf(row, progress) === "done")
            const work = study.days.find((each) => each.day === text)
            const note = noteOf.get(text)
            return new DailyLogDay({
              day: text,
              minutes: work?.minutes ?? 0,
              questions: work?.questions ?? 0,
              sections: work?.sections ?? [],
              mocks: work?.mocks ?? 0,
              items: shown.map((row) => itemView(row, progress)),
              note: note === undefined || note === "" ? null : note
            })
          }
          return new DailyLogView({
            today: dayOfNumber(today),
            days: [...days].filter((day) => day >= from && day <= today).toSorted((a, b) => b - a).map(logDay)
          })
        })

      const writeNote = (profileId: string, day: string, note: string) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          yield* db.insert(dailyNotes).values({ id: crypto.randomUUID(), profileId, day, note: note.trim(), writtenAt: now })
            .pipe(Effect.orDie)
          const log = yield* dailyLog(profileId)
          return log.days.find((each) => each.day === day) ??
            new DailyLogDay({ day, minutes: 0, questions: 0, sections: [], mocks: 0, items: [], note: note.trim() === "" ? null : note.trim() })
        })

      return Plans.of({ view, saveSettings, skipDiagnostic, start, dailyLog, writeNote })
    })
  )
}

export type PlanStartError = Effect.Error<
  | ReturnType<Practice["Service"]["start"]>
  | ReturnType<Retries["Service"]["start"]>
  | ReturnType<Sectionals["Service"]["start"]>
  | ReturnType<Mocks["Service"]["start"]>
> | PlanItemNotFound | PlanItemNotOpen | PlanItemIsLesson
