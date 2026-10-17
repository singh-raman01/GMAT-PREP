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
import { dailyNotes, planItems, planSettings, planVersions, profileDays, sessions } from "../db/schema.ts"
import { Retries } from "../learning/Retries.ts"
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
  MockMinutes,
  type PlanDay,
  type PlanInputs,
  type PlannedItem,
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
// or Sectional finished, the Diagnostic's state, or, until the Diagnostic is
// done, a Section reaching 20 Rated Responses.
interface Basis {
  readonly day: string
  readonly settings: string
  readonly finished: number
  readonly diagnostic: DiagnosticState
  readonly diagnosticSections: ReadonlyArray<string>
  readonly warm: ReadonlyArray<boolean>
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
  readonly item: string
  readonly status: string
  readonly reason: string | null
}

const itemColumns = {
  id: planItems.id,
  versionId: planItems.versionId,
  day: planItems.day,
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
      const retries = yield* Retries
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

      // The plan items of some days that a Session was started from, under
      // any version.
      const workedItemsOf = (profileId: string, from: string, to: string) =>
        db.selectDistinct(itemColumns).from(sessions).innerJoin(planItems, eq(planItems.id, sessions.planItemId))
          .where(and(eq(sessions.profileId, profileId), gte(planItems.day, from), lte(planItems.day, to)))
          .orderBy(asc(planItems.day), asc(planItems.position))
          .pipe(Effect.orDie)

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
      // start and none of it is taken, or pending with the Sections still to
      // take. The start check is read only when it decides.
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
          const sectionalIds = [...started.values()].filter((session) => session.kind === "sectional" && session.status === "finished")
            .map((session) => session.planItemId!)
          const diagnosticSectionals = sectionalIds.length === 0
            ? []
            : yield* db.select({ item: planItems.item }).from(planItems).where(inArray(planItems.id, sectionalIds)).pipe(Effect.orDie)
          const sectionsDone = new Set(
            diagnosticSectionals.map((row) => readJson<PlannedItem>(row.item)).filter((each) => each.diagnostic).map((each) => each.section!)
          )
          const left = sectionIds.filter((section) => !sectionsDone.has(section))
          const outcome = (state: DiagnosticState) => ({ state, sectionsLeft: state === "pending" ? left : [], finished: finishedCount })
          if (left.length === 0) return outcome("done")
          if (skipped) return outcome("skipped")
          // Once begun, it goes on: a Section that cannot serve its Sectional
          // waits, dropped with the reason.
          if (left.length === sectionIds.length) {
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
            diagnostic: row.planItemId !== null && diagnostic.has(row.planItemId)
          }))
        })

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
            : (yield* analytics.planAnalytics(profileId)).sections.map((section) => section.rated >= WarmUpRated)
          return {
            day: dayOfNumber(today),
            settings: row.id,
            finished: diagnostic.finished,
            diagnostic: diagnostic.state,
            diagnosticSections: diagnostic.sectionsLeft,
            warm
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
          const forecast = yield* retries.forecast(profileId)
          const allowed = yield* allowedOf(profileId)
          const overrides = yield* settings.targetTimes
          const day = dayOfNumber(today)
          const todayWork = yield* workedItemsOf(profileId, day, day)
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
                rated: section.rated,
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
              todayWork: todayWork.map((each) => readJson<PlannedItem>(each.item))
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
          const started = yield* startedOf(profileId)
          const kept = latest === undefined ? undefined : readJson<Basis>(latest.basis)
          const basis = yield* basisOf(profileId, row, today, started, kept)
          const basisText = JSON.stringify(basis)
          if (latest !== undefined && latest.basis === basisText) return { version: latest, basis, row, rules, today, now, started }
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
          yield* db.transaction(() =>
            Effect.gen(function*() {
              yield* db.insert(planVersions).values(version)
              for (let from = 0; from < rows.length; from += InsertRows) {
                yield* db.insert(planItems).values(rows.slice(from, from + InsertRows))
              }
            })
          ).pipe(Effect.orDie)
          return { version, basis, row, rules, today, now, started }
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
        row: Pick<ItemRow, "id" | "item" | "status" | "reason">,
        started: ReadonlyMap<string, StartedSession>
      ) => {
        const item = readJson<PlannedItem>(row.item)
        const session = started.get(row.id)
        const status = row.status === "dropped"
          ? "dropped" as const
          : session === undefined
          ? "planned" as const
          : session.status === "finished"
          ? "done" as const
          : "started" as const
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
          sessionId: session === undefined ? null : SessionId.make(session.id)
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
          const { version, basis, row, rules, today, now, started } = ensured
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
                ...(day.day === todayText ? earlier : []).map((each) => itemView(each, started)),
                ...(planned.get(day.day) ?? []).map((each) => itemView(each, started))
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
            dropped: rows.filter((each) => each.status === "dropped").map((each) => itemView(each, started)),
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
          const ensured = yield* ensure(caller.profileId)
          const session = (ensured?.started ?? (yield* startedOf(caller.profileId))).get(id)
          // A Session started from it and not ended is the one to go back to.
          if (session !== undefined && session.status !== "finished") {
            return new PlanStarted({
              kind: session.kind === "mock" ? "mock" : session.kind === "sectional" ? "sectional" : "practice",
              id: SessionId.make(session.id)
            })
          }
          const item = readJson<PlannedItem>(found.item)
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
          const started = yield* startedOf(profileId)
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
              items: [...planned, ...extra].map((row) => itemView(row, started)),
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
> | PlanItemNotFound | PlanItemNotOpen
