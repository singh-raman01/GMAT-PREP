import { and, asc, desc, eq, gte, inArray, isNotNull, lte, or, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema, Semaphore } from "effect"
import { Named, SessionId } from "../../api/Practice.ts"
import {
  DailyLogDay,
  DailyLogView,
  DaySettingsView,
  DiagnosticView,
  NoteDayInvalid,
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
  TargetsView,
  TestDateDays
} from "../../api/Plan.ts"
import { InvalidTimeZone } from "../../api/Profiles.ts"
import { type DayRule, nextRolloverUnder, ruleInEffect, studyDaysUnder, studyDayStartUnder } from "../../api/studyDay.ts"
import { DefaultTargetSeconds, targetSecondsFor } from "../../api/targetTimes.ts"
import { Analytics } from "../analytics/Analytics.ts"
import { Db } from "../db/Database.ts"
import { dailyNotes, lessonViews, planItems, planSettings, planVersions, profileDays, scoreEstimates, sessions } from "../db/schema.ts"
import { ErrorLog } from "../learning/ErrorLog.ts"
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
import { Settings } from "../settings/Settings.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import {
  buildPlan,
  dayNumber,
  dayOfNumber,
  type DiagnosticState,
  type LessonState,
  MockMinutes,
  type PlanDay,
  type PlanInputs,
  type PlannedItem,
  setMinutes,
  type TakenEvent,
  WarmUpRated
} from "./build.ts"

// The Study Plan service (docs/design.md, "Study Plan, Diagnostic and Daily
// Log", decisions 81 to 91): reads the Profile's settings and state, writes a
// new plan version when what it was built on has changed, starts its items
// and keeps the Daily Log.

// The Daily Log looks back this many Study Days.
const LogDays = 90
// Plan items are written this many rows to a statement.
const InsertRows = 200

const PlannedJson = Schema.fromJsonString(Schema.Unknown)
const decodeJson = Schema.decodeUnknownSync(PlannedJson)
const readJson = <A>(text: string) => decodeJson(text) as A

interface Outline {
  readonly notes: ReadonlyArray<string>
  readonly days: ReadonlyArray<Omit<PlanDay, "items">>
  // The last day whose sets are planned; versions before it planned all.
  readonly itemsUntil?: string | null
}

// When to build again (decision 90): a new Study Day, new settings, a Mock
// or Sectional finished, the Diagnostic's state, until the Diagnostic is
// done a Section reaching 20 Rated Responses, or a Lesson approved or done
// (decision 101).
interface Basis {
  readonly day: string
  readonly settings: string
  readonly finished: number
  readonly diagnostic: DiagnosticState
  readonly diagnosticSections: ReadonlyArray<string>
  readonly warm: ReadonlyArray<boolean>
  // Each approved Lesson, and whether it is done, and its methods.
  readonly lessons: ReadonlyArray<readonly [string, boolean, boolean]>
}

// The time zone's own name, or none for one the runtime does not know.
const canonicalZone = (timeZone: string) => {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

interface StartedSession {
  readonly id: string
  readonly planItemId: string | null
  readonly status: string
  readonly kind: string
}

interface ItemRow {
  readonly id: string
  readonly versionId: string
  readonly day: string
  readonly position: number
  readonly item: string
  readonly status: string
  readonly reason: string | null
}

const itemColumns = {
  id: planItems.id,
  versionId: planItems.versionId,
  day: planItems.day,
  position: planItems.position,
  item: planItems.item,
  status: planItems.status,
  reason: planItems.reason
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
  writeNote(profileId: string, day: string, note: string): Effect.Effect<DailyLogDay, NoteDayInvalid>
}>()("gmat-prep/server/Plans") {
  static readonly layer = Layer.effect(
    Plans,
    Effect.gen(function*() {
      const db = yield* Db
      const analytics = yield* Analytics
      const errorLog = yield* ErrorLog
      const retries = yield* Retries
      const lessons = yield* Lessons
      const practice = yield* Practice
      const sectionals = yield* Sectionals
      const mocks = yield* Mocks
      const scores = yield* Scores
      const settings = yield* Settings
      const taxonomy = (yield* Taxonomy).view
      const names = namesOf(taxonomy)
      const sectionIds = taxonomy.sections.map((section) => section.id)
      const named = (id: string) => names.named(id)
      const run = <A, E>(effect: Effect.Effect<A, E, Db>) => effect.pipe(Effect.provideService(Db, db), Effect.orDie)
      // One build at a time, so two reads at once write one version.
      const oneAtATime = (yield* Semaphore.make(1)).withPermits(1)
      // One start at a time, so two starts of one item make one Session.
      const oneStart = (yield* Semaphore.make(1)).withPermits(1)

      const settingsRowOf = (profileId: string) =>
        db.select().from(planSettings).where(eq(planSettings.profileId, profileId))
          .orderBy(desc(planSettings.setAt), desc(sql`${planSettings}.rowid`)).limit(1)
          .pipe(Effect.orDie, Effect.map((rows) => rows[0]))

      const rulesOf = (profileId: string) => run(dayRulesOf(profileId)).pipe(Effect.map((rules) => rules ?? DefaultRules))

      // The Sessions started from plan items: each item's latest.
      const startedOf = (profileId: string) =>
        db.select({ id: sessions.id, planItemId: sessions.planItemId, status: sessions.status, kind: sessions.kind })
          .from(sessions).where(and(eq(sessions.profileId, profileId), isNotNull(sessions.planItemId)))
          .orderBy(asc(sessions.createdAt))
          .pipe(
            Effect.orDie,
            Effect.map((rows) => new Map<string, StartedSession>(rows.map((row) => [row.planItemId!, row] as const)))
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
      const statusOf = (row: Pick<ItemRow, "id" | "item" | "status">, progress: Progress) => {
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

      // The plan items of some days that a Session was started from, or a
      // Lesson page opened from, under any version.
      const workedItemsOf = (profileId: string, from: string, to: string) =>
        Effect.gen(function*() {
          const bySessions = yield* db.selectDistinct(itemColumns).from(sessions).innerJoin(planItems, eq(planItems.id, sessions.planItemId))
            .where(and(eq(sessions.profileId, profileId), gte(planItems.day, from), lte(planItems.day, to)))
            .pipe(Effect.orDie)
          const byLessons = yield* db.selectDistinct(itemColumns).from(lessonViews).innerJoin(planItems, eq(planItems.id, lessonViews.planItemId))
            .where(and(eq(lessonViews.profileId, profileId), gte(planItems.day, from), lte(planItems.day, to)))
            .pipe(Effect.orDie)
          const byId = new Map<string, ItemRow>()
          for (const row of [...bySessions, ...byLessons]) byId.set(row.id, row)
          return [...byId.values()].toSorted((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.position - b.position))
        })

      // What the Profile has done with the approved Lessons (decision 101):
      // the whole Lesson once a check of it ended, the methods once any part
      // was marked read.
      const lessonStatesOf = (profileId: string) =>
        Effect.gen(function*() {
          const approved = [...(yield* lessons.approved).values()]
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

      // How many more Mocks or Sectionals the start check lets each Section
      // serve: it passes while every Blueprint group holds twice its count
      // unseen, and each one served takes at most its count.
      const allowedOf = (profileId: string) =>
        sectionals.readinessAll(profileId).pipe(
          Effect.map((sections) =>
            Object.fromEntries(sections.map((section) => [
              section.section.id,
              Math.min(...section.groups.map((group) => {
                const count = Math.max(1, group.needed / 2)
                return Math.max(0, Math.floor(group.unseen / count) - 1)
              }))
            ]))
          )
        )

      // The Diagnostic (decision 89): done once a Mock is finished, or the
      // three Diagnostic Sectionals; else skipped, blocked while no Mock can
      // start and no part of it has started, or pending with the Sections
      // whose Sectional has not started. A part started, running or ended,
      // has begun it. The start check is read only when it decides.
      const diagnosticOf = (
        profileId: string,
        skipped: boolean,
        allowed: Effect.Effect<Readonly<Record<string, number>>>,
        started: ReadonlyMap<string, StartedSession>
      ) =>
        Effect.gen(function*() {
          const finished = yield* db.select({ kind: sessions.kind, count: sql<number>`count(*)` }).from(sessions)
            .where(and(eq(sessions.profileId, profileId), inArray(sessions.kind, ["mock", "sectional"]), eq(sessions.status, "finished")))
            .groupBy(sessions.kind).pipe(Effect.orDie)
          const mocksFinished = finished.find((row) => row.kind === "mock")?.count ?? 0
          const finishedCount = finished.reduce((sum, row) => sum + row.count, 0)
          if (mocksFinished > 0) return { state: "done" as DiagnosticState, sectionsLeft: [] as ReadonlyArray<string>, finished: finishedCount }
          const eventSessions = [...started.values()].filter((session) => session.kind === "sectional" || session.kind === "mock")
          const eventItems = eventSessions.length === 0
            ? []
            : yield* db.select({ id: planItems.id, item: planItems.item }).from(planItems)
              .where(inArray(planItems.id, eventSessions.map((session) => session.planItemId!))).pipe(Effect.orDie)
          const parts = eventItems.map((row) => ({ session: started.get(row.id)!, item: readJson<PlannedItem>(row.item) }))
            .filter((part) => part.item.diagnostic)
          const begun = parts.length > 0
          const sectionals = parts.filter((part) => part.item.kind === "sectional")
          const sectionsDone = new Set(sectionals.filter((part) => part.session.status === "finished").map((part) => part.item.section!))
          const sectionsStarted = new Set(sectionals.map((part) => part.item.section!))
          // A Diagnostic Mock under way leaves nothing more to plan for it.
          const mockUnderWay = parts.some((part) => part.item.kind === "mock")
          const left = mockUnderWay ? [] : sectionIds.filter((section) => !sectionsStarted.has(section))
          const outcome = (state: DiagnosticState) => ({ state, sectionsLeft: state === "pending" ? left : [], finished: finishedCount })
          if (sectionIds.every((section) => sectionsDone.has(section))) return outcome("done")
          if (skipped) return outcome("skipped")
          // Once begun, it goes on: a Section that cannot serve its Sectional
          // waits, dropped with the reason.
          if (!begun) {
            const counts = yield* allowed
            if (sectionIds.some((section) => (counts[section] ?? 0) < 1)) return outcome("blocked")
          }
          return outcome("pending")
        })

      // The Study Day the current test date, or none, was first set: the
      // plan's phases and turns count from it.
      const startOf = (profileId: string, rules: ReadonlyArray<DayRule>) =>
        db.select({ testDate: planSettings.testDate, setAt: planSettings.setAt }).from(planSettings)
          .where(eq(planSettings.profileId, profileId))
          .orderBy(asc(planSettings.setAt), asc(sql`${planSettings}.rowid`))
          .pipe(
            Effect.orDie,
            Effect.map((rows) => {
              let first = rows.length - 1
              while (first > 0 && rows[first - 1]!.testDate === rows[rows.length - 1]!.testDate) first -= 1
              return dayOfNumber(studyDaysUnder(rules)(rows[first]!.setAt))
            })
          )

      // The Mocks and Sectionals started in the last 7 Study Days, by the
      // day each started, from the plan or not.
      const takenOf = (profileId: string, rules: ReadonlyArray<DayRule>, today: number) =>
        Effect.gen(function*() {
          const rows = yield* db.select({
            kind: sessions.kind,
            createdAt: sessions.createdAt,
            section: sql<string | null>`json_extract(${sessions.config}, '$.section')`,
            planItemId: sessions.planItemId
          }).from(sessions)
            .where(and(
              eq(sessions.profileId, profileId),
              inArray(sessions.kind, ["mock", "sectional"]),
              gte(sessions.createdAt, studyDayStartUnder(rules, today - 6))
            ))
            .pipe(Effect.orDie)
          const itemIds = rows.flatMap((row) => (row.planItemId === null ? [] : [row.planItemId]))
          const items = itemIds.length === 0
            ? []
            : yield* db.select({ id: planItems.id, item: planItems.item }).from(planItems).where(inArray(planItems.id, itemIds))
              .pipe(Effect.orDie)
          const diagnostic = new Set(items.filter((row) => readJson<PlannedItem>(row.item).diagnostic).map((row) => row.id))
          const dayOf = studyDaysUnder(rules)
          return rows.map((row): TakenEvent => ({
            day: dayOfNumber(dayOf(row.createdAt)),
            kind: row.kind === "mock" ? "mock" : "sectional",
            section: row.kind === "sectional" ? row.section : null,
            diagnostic: row.planItemId !== null && diagnostic.has(row.planItemId),
            fromPlan: row.planItemId !== null
          }))
        })

      // Each Section's Rated Responses as its latest Score Estimate counted
      // them, which is read at once, where the analytics would fit every
      // Weak Area first.
      const ratedOf = (profileId: string) =>
        Effect.forEach(sectionIds, (section) =>
          db.select({ rated: scoreEstimates.ratedResponses }).from(scoreEstimates)
            .where(and(eq(scoreEstimates.profileId, profileId), eq(scoreEstimates.section, section)))
            .orderBy(desc(scoreEstimates.at), desc(sql`${scoreEstimates}.rowid`)).limit(1)
            .pipe(Effect.orDie, Effect.map((rows) => rows[0]?.rated ?? 0)))

      // What decides when to build again, read cheaply: the start check only
      // while the Diagnostic waits, and the Rated Responses only until it is
      // done, and not again once every Section has 20.
      const basisOf = (
        profileId: string,
        row: typeof planSettings.$inferSelect,
        today: number,
        started: ReadonlyMap<string, StartedSession>,
        latest: Basis | undefined
      ) =>
        Effect.gen(function*() {
          const diagnostic = yield* diagnosticOf(profileId, row.diagnosticSkipped, allowedOf(profileId), started)
          const warm = diagnostic.state === "done"
            ? []
            : latest !== undefined && latest.warm.length === sectionIds.length && latest.warm.every((each) => each)
            ? latest.warm
            : (yield* ratedOf(profileId)).map((rated) => rated >= WarmUpRated)
          const lessonStates = yield* lessonStatesOf(profileId)
          return {
            day: dayOfNumber(today),
            settings: row.id,
            finished: diagnostic.finished,
            diagnostic: diagnostic.state,
            diagnosticSections: diagnostic.sectionsLeft,
            warm,
            lessons: lessonStates.map((lesson) => [lesson.lessonId, lesson.done, lesson.methodsDone] as const)
          } satisfies Basis
        })

      // What the plan is built from now (decision 83).
      const inputsOf = (
        profileId: string,
        row: typeof planSettings.$inferSelect,
        rules: ReadonlyArray<DayRule>,
        today: number,
        basis: Basis
      ) =>
        Effect.gen(function*() {
          const found = yield* analytics.planAnalytics(profileId)
          // Counted as the basis counts them, so a build sees the warm-up the
          // basis saw.
          const rated = yield* ratedOf(profileId)
          const forecast = yield* retries.forecast(profileId)
          const allowed = yield* allowedOf(profileId)
          const overrides = yield* settings.targetTimes
          const day = dayOfNumber(today)
          const todayWork = yield* workedItemsOf(profileId, day, day)
          const subjects = new Set(found.weakAreas.map((area) => area.id))
          const lessonStates = (yield* lessonStatesOf(profileId)).filter((lesson) => subjects.has(lesson.subject))
          return {
            settings: {
              testDate: row.testDate,
              targetTotal: row.targetTotal,
              weeklyMinutes: row.weeklyMinutes,
              daysOff: readJson<ReadonlyArray<number>>(row.daysOff)
            },
            state: {
              today: day,
              start: yield* startOf(profileId, rules),
              sections: found.sections.map((section) => ({
                id: section.id,
                ability: section.ability === null ? null : Math.round(section.ability * 1000) / 1000,
                rated: rated[sectionIds.indexOf(section.id)] ?? 0,
                paceMs: (DefaultTargetSeconds[section.id] ?? 120) * 1000
              })),
              weakAreas: found.weakAreas.map((area) => ({
                ...area,
                ability: Math.round(area.ability * 1000) / 1000,
                // A Question Type's set runs at its own Target Time.
                ...(area.kind === "questionType" ? { paceMs: targetSecondsFor(area.id, overrides) * 1000 } : {})
              })),
              retries: forecast.map((retry) => ({
                day: dayOfNumber(Math.max(today, retry.dueDay)),
                timed: retry.timed,
                minutes: retry.minutes,
                priority: retry.priority
              })),
              allowed,
              diagnostic: basis.diagnostic,
              diagnosticSections: basis.diagnosticSections,
              taken: yield* takenOf(profileId, rules, today),
              todayWork: todayWork.map((each) => readJson<PlannedItem>(each.item)),
              lessons: lessonStates
            }
          } satisfies PlanInputs
        })

      // The latest version, built again first when its basis has changed.
      const ensure = (profileId: string) =>
        Effect.gen(function*() {
          const row = yield* settingsRowOf(profileId)
          if (row === undefined) return undefined
          const now = yield* Clock.currentTimeMillis
          const rules = yield* rulesOf(profileId)
          const today = studyDaysUnder(rules)(now)
          const [latest] = yield* db.select({
            id: planVersions.id,
            version: planVersions.version,
            builtAt: planVersions.builtAt,
            fromDay: planVersions.fromDay,
            basis: planVersions.basis,
            outline: planVersions.outline
          }).from(planVersions).where(eq(planVersions.profileId, profileId))
            .orderBy(desc(planVersions.version)).limit(1).pipe(Effect.orDie)
          const progress = yield* progressOf(profileId)
          const kept = latest === undefined ? undefined : readJson<Basis>(latest.basis)
          const basis = yield* basisOf(profileId, row, today, progress.sessions, kept)
          const basisText = JSON.stringify(basis)
          if (latest !== undefined && latest.basis === basisText) return { version: latest, basis, row, rules, today, now, progress }
          const inputs = yield* inputsOf(profileId, row, rules, today, basis)
          const plan = buildPlan(inputs)
          const version = {
            id: crypto.randomUUID(),
            profileId,
            version: (latest?.version ?? 0) + 1,
            builtAt: now,
            fromDay: inputs.state.today,
            basis: basisText,
            inputs: JSON.stringify(inputs),
            outline: JSON.stringify({
              notes: plan.notes,
              days: plan.days.map(({ items: _, ...day }) => day),
              itemsUntil: plan.itemsUntil
            } satisfies Outline)
          }
          const rows = [
            ...plan.days.flatMap((day) => day.items.map((each, position) => ({ each, position, status: "planned" as const, reason: null }))),
            ...plan.dropped.map((each, position) => ({ each, position: 1000 + position, status: "dropped" as const, reason: each.reason }))
          ].map(({ each, position, status, reason }) => ({
            id: crypto.randomUUID(),
            versionId: version.id,
            day: each.day,
            position,
            kind: each.kind,
            item: JSON.stringify(each),
            minutes: each.minutes,
            status,
            reason
          }))
          // No fact depends on the plan, so writing it keeps the analytics
          // worked out for the next read.
          yield* errorLog.factFree(Effect.gen(function*() {
            yield* db.insert(planVersions).values(version)
            for (let from = 0; from < rows.length; from += InsertRows) {
              yield* db.insert(planItems).values(rows.slice(from, from + InsertRows))
            }
          }))
          return { version, basis, row, rules, today, now, progress }
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

      const itemView = (row: Pick<ItemRow, "id" | "item" | "status" | "reason">, progress: Progress) => {
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
          trapPattern: item.practice?.trapPattern === undefined ? null : named(item.practice.trapPattern),
          minutes: item.minutes,
          status,
          reason: row.reason,
          sessionId: session === undefined ? null : SessionId.make(session.id),
          lesson: item.lesson === null || item.lesson === undefined
            ? null
            : { subject: named(item.lesson.subject), part: item.lesson.part }
        })
      }

      // The rule now, and a change waiting for the next rollover unless it
      // puts back the rule now.
      const daySettingsOf = (rules: ReadonlyArray<DayRule>, now: number) => {
        const current = ruleInEffect(rules, now)
        const latest = rules.at(-1)!
        const pending = latest.from > now && (latest.timeZone !== current.timeZone || latest.rolloverHour !== current.rolloverHour)
          ? latest
          : undefined
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

      const settingsView = (row: typeof planSettings.$inferSelect) =>
        new PlanSettingsView({
          testDate: row.testDate,
          targetTotal: row.targetTotal,
          weeklyMinutes: row.weeklyMinutes,
          daysOff: readJson<ReadonlyArray<number>>(row.daysOff),
          diagnosticSkipped: row.diagnosticSkipped
        })

      const view = (profileId: string) =>
        Effect.gen(function*() {
          const ensured = yield* ensure(profileId)
          if (ensured === undefined) {
            const now = yield* Clock.currentTimeMillis
            const rules = yield* rulesOf(profileId)
            const diagnostic = yield* diagnosticOf(profileId, false, allowedOf(profileId), yield* startedOf(profileId))
            return new PlanView({
              today: dayOfNumber(studyDaysUnder(rules)(now)),
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
          const { version, basis, row, rules, today, now, progress } = ensured
          const outline = readJson<Outline>(version.outline)
          const todayText = dayOfNumber(today)
          const rows = yield* db.select(itemColumns).from(planItems)
            .where(and(eq(planItems.versionId, version.id), gte(planItems.day, todayText)))
            .orderBy(asc(planItems.day), asc(planItems.position)).pipe(Effect.orDie)
          // Today's items started or done under an earlier version stay on
          // today's list.
          const earlier = (yield* workedItemsOf(profileId, todayText, todayText)).filter((each) => each.versionId !== version.id)
          const planned = Map.groupBy(rows.filter((each) => each.status === "planned"), (each) => each.day)
          const days = outline.days.filter((day) => day.day >= todayText).map((day) =>
            new PlanDayView({
              ...day,
              setsPlanned: outline.itemsUntil === undefined || outline.itemsUntil === null || day.day <= outline.itemsUntil,
              items: [
                ...(day.day === todayText ? earlier : []).map((each) => itemView(each, progress)),
                ...(planned.get(day.day) ?? []).map((each) => itemView(each, progress))
              ]
            })
          )
          return new PlanView({
            today: todayText,
            settings: settingsView(row),
            days: daySettingsOf(rules, now),
            version: version.version,
            builtAt: version.builtAt,
            plan: days,
            dropped: rows.filter((each) => each.status === "dropped").map((each) => itemView(each, progress)),
            notes: outline.notes,
            diagnostic: new DiagnosticView({
              state: basis.diagnostic,
              form: row.weeklyMinutes >= MockMinutes && basis.diagnosticSections.length === sectionIds.length ? "mock" : "sectionals",
              sectionsLeft: basis.diagnosticSections.map(sectionName)
            }),
            targets: yield* targetsOf(profileId, row.targetTotal)
          })
        })

      const saveSettings = (profileId: string, input: PlanSettingsInput) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const timeZone = canonicalZone(input.timeZone)
          if (timeZone === undefined) return yield* new InvalidTimeZone({ timeZone: input.timeZone })
          const rules = yield* rulesOf(profileId)
          const today = studyDaysUnder(rules)(now)
          const problems = [
            ...(new Set(input.daysOff).size >= 7 ? ["Keep at least one day of the week for study."] : []),
            ...(input.testDate !== null && dayNumber(input.testDate) <= today ? ["Choose a test date after today."] : []),
            ...(input.testDate !== null && dayNumber(input.testDate) > today + TestDateDays ? ["Choose a test date within 2 years."] : [])
          ]
          if (problems.length > 0) return yield* new PlanSettingsInvalid({ problems })
          const previous = yield* settingsRowOf(profileId)
          const daysOff = JSON.stringify([...new Set(input.daysOff)].toSorted((a, b) => a - b))
          // The same settings again add no row, so the plan stays as it is.
          const same = previous !== undefined && previous.testDate === input.testDate && previous.targetTotal === input.targetTotal &&
            previous.weeklyMinutes === input.weeklyMinutes && previous.daysOff === daysOff
          if (!same) {
            yield* db.insert(planSettings).values({
              id: crypto.randomUUID(),
              profileId,
              testDate: input.testDate,
              targetTotal: input.targetTotal,
              weeklyMinutes: input.weeklyMinutes,
              daysOff,
              diagnosticSkipped: previous?.diagnosticSkipped ?? false,
              setAt: now
            }).pipe(Effect.orDie)
          }
          // A time zone or rollover change applies from the next rollover.
          const current = ruleInEffect(rules, now)
          const latest = rules.at(-1)!
          if (latest.timeZone !== timeZone || latest.rolloverHour !== input.rolloverHour) {
            const settled = rules.filter((rule) => rule.from <= now)
            const back = current.timeZone === timeZone && current.rolloverHour === input.rolloverHour
            yield* db.insert(profileDays).values({
              id: crypto.randomUUID(),
              profileId,
              timeZone,
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

      // Starts one of today's planned items, or goes back to the Session
      // started from it. Only an item of the latest version's today starts.
      const start = (caller: Caller, id: PlanItemId, order: ReadonlyArray<string> | undefined) =>
        Effect.gen(function*() {
          const [found] = yield* db.select(itemColumns).from(planItems)
            .innerJoin(planVersions, eq(planVersions.id, planItems.versionId))
            .where(and(eq(planItems.id, id), eq(planVersions.profileId, caller.profileId))).pipe(Effect.orDie)
          if (found === undefined) return yield* new PlanItemNotFound()
          const item = readJson<PlannedItem>(found.item)
          // A Lesson item opens its Lesson's page instead.
          if (item.kind === "lesson") return yield* new PlanItemIsLesson()
          const ensured = yield* ensure(caller.profileId)
          const session = (ensured?.progress.sessions ?? (yield* startedOf(caller.profileId))).get(id)
          // A Session started from it and not ended is the one to go back to.
          if (session !== undefined && session.status !== "finished") {
            return new PlanStarted({
              kind: session.kind === "mock" ? "mock" : session.kind === "sectional" ? "sectional" : "practice",
              id: SessionId.make(session.id)
            })
          }
          const open = ensured !== undefined && session === undefined && found.status === "planned" &&
            found.versionId === ensured.version.id && found.day === dayOfNumber(ensured.today)
          if (!open) {
            return yield* new PlanItemNotOpen({
              status: found.status === "dropped" ? "dropped" : session !== undefined ? "done" : "planned",
              day: item.day,
              plan: yield* view(caller.profileId)
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
        }).pipe(oneStart)

      // The Daily Log (decision 91): each of the last 90 Study Days with
      // work, a plan or a note, with the items the last version built before
      // the day ended planned for it and those worked on under any version.
      const dailyLog = (profileId: string) =>
        Effect.gen(function*() {
          // Building first keeps today's items current.
          yield* ensure(profileId)
          const now = yield* Clock.currentTimeMillis
          const rules = yield* rulesOf(profileId)
          const today = studyDaysUnder(rules)(now)
          const from = today - LogDays + 1
          const fromText = dayOfNumber(from)
          const todayText = dayOfNumber(today)
          const study = yield* analytics.study(profileId)
          const progress = yield* progressOf(profileId)
          const versions = yield* db.select({ id: planVersions.id, builtAt: planVersions.builtAt, fromDay: planVersions.fromDay })
            .from(planVersions).where(eq(planVersions.profileId, profileId))
            .orderBy(asc(planVersions.version)).pipe(Effect.orDie)
          // Each day's version: the last built before the day ended, among
          // those that plan it.
          const chosen: Array<{ readonly day: string; readonly versionId: string }> = []
          let index = 0
          let current: (typeof versions)[number] | undefined
          for (let day = from; day <= today; day += 1) {
            const text = dayOfNumber(day)
            const ends = studyDayStartUnder(rules, day + 1)
            while (index < versions.length && versions[index]!.builtAt < ends) {
              current = versions[index]
              index += 1
            }
            if (current !== undefined && current.fromDay <= text) chosen.push({ day: text, versionId: current.id })
          }
          const plannedRows: Array<ItemRow> = []
          for (let at = 0; at < chosen.length; at += 100) {
            const pairs = chosen.slice(at, at + 100)
            plannedRows.push(
              ...yield* db.select(itemColumns).from(planItems)
                .where(and(
                  eq(planItems.status, "planned"),
                  or(...pairs.map((pair) => and(eq(planItems.versionId, pair.versionId), eq(planItems.day, pair.day))))
                ))
                .orderBy(asc(planItems.position)).pipe(Effect.orDie)
            )
          }
          const worked = yield* workedItemsOf(profileId, fromText, todayText)
          const plannedOf = Map.groupBy(plannedRows, (row) => row.day)
          const workedOf = Map.groupBy(worked, (row) => row.day)
          const notes = yield* db.select({ day: dailyNotes.day, note: dailyNotes.note }).from(dailyNotes)
            .where(and(eq(dailyNotes.profileId, profileId), gte(dailyNotes.day, fromText)))
            .orderBy(asc(dailyNotes.writtenAt), asc(sql`${dailyNotes}.rowid`)).pipe(Effect.orDie)
          const noteOf = new Map(notes.map((note) => [note.day, note.note] as const))
          const workOf = new Map(study.days.map((day) => [day.day, day] as const))
          const days = new Set<string>([
            todayText,
            ...study.days.map((day) => day.day),
            ...plannedOf.keys(),
            ...workedOf.keys(),
            ...noteOf.keys()
          ])
          const logDay = (text: string) => {
            const planned = plannedOf.get(text) ?? []
            const extra = (workedOf.get(text) ?? []).filter((row) => !planned.some((each) => each.id === row.id))
            const work = workOf.get(text)
            const note = noteOf.get(text)
            return new DailyLogDay({
              day: text,
              minutes: work?.minutes ?? 0,
              questions: work?.questions ?? 0,
              sections: work?.sections ?? [],
              mocks: work?.mocks ?? 0,
              items: [...planned, ...extra].map((row) => itemView(row, progress)),
              note: note === undefined || note === "" ? null : note
            })
          }
          return new DailyLogView({
            today: todayText,
            days: [...days].filter((day) => day >= fromText && day <= todayText).toSorted((a, b) => (a < b ? 1 : a > b ? -1 : 0)).map(logDay)
          })
        })

      const writeNote = (profileId: string, day: string, note: string) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const rules = yield* rulesOf(profileId)
          const today = studyDaysUnder(rules)(now)
          if (dayNumber(day) > today || dayNumber(day) < today - LogDays + 1) return yield* new NoteDayInvalid({ day })
          yield* errorLog.factFree(
            db.insert(dailyNotes).values({ id: crypto.randomUUID(), profileId, day, note: note.trim(), writtenAt: now })
          )
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
