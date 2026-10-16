import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { Cause, Clock, Context, Effect, Latch, Layer, Schema, Semaphore } from "effect"
import {
  BreakMinutes,
  MockBreak,
  MockHeldElsewhere,
  MockNotFound,
  MockOptions,
  MockOrderInvalid,
  MockOutOfStep,
  MockReport,
  MockReserveTooSmall,
  MockSectionReport,
  MockSectionView,
  MockSummary,
  MockView
} from "../../api/Mocks.ts"
import { Named, SessionId } from "../../api/Practice.ts"
import { TotalScoreView } from "../../api/Scores.ts"
import { MockRunning, SectionalRunning, SectionMinutes } from "../../api/Sectionals.ts"
import { Db } from "../db/Database.ts"
import { responses, sessions } from "../db/schema.ts"
import type { Caller } from "../practice/Practice.ts"
import { TickMs } from "../practice/clock.ts"
import { keysOf } from "../practice/history.ts"
import { rateSession } from "../ratings/rateSession.ts"
import { totalEstimate } from "../ratings/scale.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { decodeConfig, lineOf } from "./config.ts"
import { afterSection, BreakMs, breakLeftMs, keepsBreak, NewMock, nextSection } from "./mockFlow.ts"
import { rescore } from "./report.ts"
import { Sectionals } from "./Sectionals.ts"

// Mocks (docs/design.md, "Sessions"): a Session of kind mock whose three
// Sections are Sessions of kind mock-section, each run by the Sectional
// engine. The Mock moves on when a Section closes: to the break, or straight
// to the next Section. It checks every second; only the break runs on its
// clock, the Sections on their own.

const MockConfig = Schema.Struct({
  // The Sections in the order chosen.
  order: Schema.Array(Schema.String),
  // The Sessions of the Sections started, in that order.
  sections: Schema.Array(Schema.String),
  flow: Schema.Struct({
    started: Schema.Int,
    breakAfter: Schema.NullOr(Schema.Int),
    breakStartedAt: Schema.NullOr(Schema.Number),
    stage: Schema.Literals(["section", "break", "finished"])
  })
})
type MockConfig = typeof MockConfig.Type
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(MockConfig))
const decodeMockConfig = Schema.decodeUnknownSync(Schema.fromJsonString(MockConfig))

type SessionRow = typeof sessions.$inferSelect

// The Total takes the Section scores in this order, whatever order they
// were taken in.
const TotalOrder = ["quant", "verbal", "di"] as const

export class Mocks extends Context.Service<Mocks, {
  options(profileId: string): Effect.Effect<MockOptions>
  start(
    caller: Caller,
    order: ReadonlyArray<string>
  ): Effect.Effect<MockView, MockOrderInvalid | MockReserveTooSmall | SectionalRunning | MockRunning>
  list(profileId: string): Effect.Effect<ReadonlyArray<MockSummary>>
  get(caller: Caller, id: SessionId): Effect.Effect<MockView, MockNotFound>
  goOn(caller: Caller, id: SessionId): Effect.Effect<MockView, MockNotFound | MockOutOfStep | MockHeldElsewhere>
  claim(caller: Caller, id: SessionId): Effect.Effect<MockView, MockNotFound>
}>()("gmat-prep/server/Mocks") {
  static readonly layer = Layer.effect(
    Mocks,
    Effect.gen(function*() {
      const db = yield* Db
      const sectionals = yield* Sectionals
      const taxonomy = (yield* Taxonomy).view
      // Requests and the break's ticks take turns.
      const oneAtATime = (yield* Semaphore.make(1)).withPermits(1)
      const run = <A, E>(effect: Effect.Effect<A, E, Db>) => effect.pipe(Effect.provideService(Db, db), Effect.orDie)
      // Runs an action in one transaction; its failures come back as values
      // so they do not roll back as defects.
      const inTransaction = <A, E>(action: Effect.Effect<A, E, never>) =>
        db.transaction(() => Effect.result(action)).pipe(
          Effect.orDie,
          Effect.flatMap((result) => (result._tag === "Success" ? Effect.succeed(result.success) : Effect.fail(result.failure)))
        )
      // Open while a Mock may be running; it starts open, so the first tick
      // picks up Mocks left running when the app last stopped.
      const wake = yield* Latch.make(true)

      const sectionName = (id: string) => new Named({ id, name: taxonomy.sections.find((each) => each.id === id)?.name ?? id })

      const own = (profileId: string, id: string) =>
        db.select().from(sessions)
          .where(and(eq(sessions.id, id), eq(sessions.profileId, profileId), eq(sessions.kind, "mock")))
          .pipe(
            Effect.orDie,
            Effect.flatMap((rows) => (rows[0] === undefined ? Effect.fail(new MockNotFound()) : Effect.succeed(rows[0])))
          )

      const saveConfig = (id: string, config: MockConfig) =>
        db.update(sessions).set({ config: encodeConfig(config) }).where(eq(sessions.id, id)).pipe(Effect.orDie)

      const sectionsOf = (config: MockConfig) =>
        config.sections.length === 0
          ? Effect.succeed([] as Array<SessionRow>)
          : db.select().from(sessions).where(inArray(sessions.id, [...config.sections])).pipe(
            Effect.orDie,
            Effect.map((rows) => config.sections.map((id) => rows.find((row) => row.id === id)!))
          )

      const holdsIt = (session: SessionRow, device: string | undefined) =>
        session.holder === null || device === undefined || session.holder === device

      // The device that holds the Mock starts each of its Sections.
      const callerOf = (mock: SessionRow): Caller => ({ profileId: mock.profileId, device: mock.holder ?? undefined })

      // Begins the Section at the next place, or takes up the one begun
      // there already: the Mock's config is saved after the Section begins,
      // so a stop in between leaves a Section the config does not name yet.
      const beginNext = (mock: SessionRow, config: MockConfig) =>
        Effect.gen(function*() {
          const place = config.sections.length + 1
          const [begun] = yield* db.select({ id: sessions.id }).from(sessions)
            .where(and(
              eq(sessions.profileId, mock.profileId),
              eq(sessions.kind, "mock-section"),
              sql`json_extract(${sessions.config}, '$.mock.id') = ${mock.id}`,
              sql`json_extract(${sessions.config}, '$.mock.place') = ${place}`
            )).pipe(Effect.orDie)
          const id = begun?.id ??
            (yield* sectionals.beginMockSection(callerOf(mock), config.order[place - 1]!, { id: mock.id, place }))
          return { ...config, sections: [...config.sections, id] } satisfies MockConfig
        })

      // Moves the Mock on as far as it can go now: from a closed Section to
      // the break or the next Section, from a break run out to the next
      // Section, and from the last Section to the end. When it ends, its
      // Sections' Rated Responses move Difficulty and the Score Estimates, in
      // the order they were taken.
      const settle = (mock: SessionRow) =>
        Effect.gen(function*() {
          if (mock.status !== "active") return mock
          const now = yield* Clock.currentTimeMillis
          let config = decodeMockConfig(mock.config)
          const start = config
          for (let step = 0; step < 9 && config.flow.stage !== "finished"; step++) {
            const flow = config.flow
            if (flow.stage === "section" && config.sections.length < flow.started) {
              config = yield* beginNext(mock, config)
            } else if (flow.stage === "section") {
              const [section] = yield* db.select({ status: sessions.status, finishedAt: sessions.finishedAt }).from(sessions)
                .where(eq(sessions.id, config.sections[flow.started - 1]!)).pipe(Effect.orDie)
              if (section?.status !== "finished") break
              config = { ...config, flow: afterSection(flow, section.finishedAt ?? now) }
            } else {
              if (breakLeftMs(flow, now) > 0) break
              config = { ...config, flow: nextSection(flow, flow.breakStartedAt! + BreakMs) }
            }
          }
          if (config !== start) yield* saveConfig(mock.id, config)
          if (config.flow.stage === "finished") {
            const [last] = yield* db.select({ finishedAt: sessions.finishedAt }).from(sessions)
              .where(eq(sessions.id, config.sections.at(-1)!)).pipe(Effect.orDie)
            yield* inTransaction(Effect.gen(function*() {
              yield* db.update(sessions).set({ status: "finished", endedBy: "finished", finishedAt: last?.finishedAt ?? now })
                .where(eq(sessions.id, mock.id)).pipe(Effect.orDie)
              for (const id of config.sections) yield* run(rateSession({ id, profileId: mock.profileId }))
            }))
          } else if (config === start) return mock
          else yield* wake.open
          return yield* own(mock.profileId, mock.id).pipe(Effect.orDie)
        })

      // A finished Mock's report: each Section's report as it reads now, and
      // the Total from the three, each on the line its report kept.
      const reportOf = (rows: ReadonlyArray<SessionRow>) =>
        Effect.gen(function*() {
          const ids = rows.map((row) => row.id)
          const answers = ids.length === 0 ? [] : yield* db.select().from(responses)
            .where(inArray(responses.sessionId, ids)).orderBy(asc(responses.seq)).pipe(Effect.orDie)
          const configs = rows.map((row) => decodeConfig(row.config))
          const keys = yield* run(keysOf([...new Set(answers.map((answer) => answer.questionId))]))
          const parts = rows.flatMap((row, index) => {
            const sectionConfig = configs[index]!
            if (sectionConfig.report === null) return []
            const report = rescore(
              sectionConfig.report,
              answers.filter((answer) => answer.sessionId === row.id),
              keys,
              lineOf(sectionConfig)
            )
            return [{ row, section: sectionConfig.section, report, line: lineOf(sectionConfig) }]
          })
          const bySection = TotalOrder.map((section) => parts.find((part) => part.section === section))
          if (bySection.some((part) => part === undefined)) return null
          const total = totalEstimate(bySection.map((part) => ({
            score: part!.report.score,
            standardError: part!.report.standardError,
            line: part!.line
          })) as unknown as Parameters<typeof totalEstimate>[0])
          return new MockReport({
            total: new TotalScoreView(total),
            sections: parts.map((part) =>
              new MockSectionReport({
                section: sectionName(part.section),
                sessionId: SessionId.make(part.row.id),
                report: part.report,
                interrupted: part.row.interrupted
              })
            ),
            interruptions: parts.filter((part) => part.row.interrupted).length,
            repeats: parts.reduce((sum, part) => sum + part.report.repeats, 0),
            paperRepeats: parts.reduce((sum, part) => sum + part.report.paperRepeats, 0),
            rescored: parts.some((part) => part.report.rescored)
          })
        })

      const viewOf = (mock: SessionRow, device: string | undefined) =>
        Effect.gen(function*() {
          const config = decodeMockConfig(mock.config)
          const rows = yield* sectionsOf(config)
          const now = yield* Clock.currentTimeMillis
          const flow = config.flow
          return new MockView({
            id: SessionId.make(mock.id),
            stage: flow.stage,
            sections: config.order.map((section, index) => {
              const row = rows[index]
              return new MockSectionView({
                section: sectionName(section),
                place: index + 1,
                sessionId: row === undefined ? null : SessionId.make(row.id),
                status: row === undefined ? "waiting" : row.status === "finished" ? "closed" : "running",
                interrupted: row?.interrupted ?? false
              })
            }),
            current: flow.stage === "section" ? flow.started : null,
            break: flow.stage === "break"
              ? new MockBreak({ after: flow.started, remainingMs: breakLeftMs(flow, now), keepsBreak: keepsBreak(flow, now) })
              : null,
            breakAfter: flow.breakAfter,
            heldHere: holdsIt(mock, device),
            report: mock.status === "finished" ? yield* reportOf(rows) : null,
            createdAt: mock.createdAt,
            finishedAt: mock.finishedAt
          })
        })

      const settled = (caller: Caller, id: string) =>
        own(caller.profileId, id).pipe(Effect.flatMap(settle), Effect.flatMap((mock) => viewOf(mock, caller.device)))

      const running = (profileId: string) =>
        db.select({ id: sessions.id }).from(sessions)
          .where(and(eq(sessions.profileId, profileId), eq(sessions.kind, "mock"), eq(sessions.status, "active")))
          .pipe(Effect.orDie, Effect.map((rows) => rows[0]?.id))

      const options = (profileId: string) =>
        Effect.gen(function*() {
          const sections = yield* sectionals.readinessAll(profileId)
          const active = yield* running(profileId)
          const sectional = yield* sectionals.runningSectional(profileId)
          return new MockOptions({
            sections,
            ready: sections.every((section) => section.ready),
            sectionMinutes: SectionMinutes,
            breakMinutes: BreakMinutes,
            running: active === undefined ? null : SessionId.make(active),
            sectional: sectional === undefined ? null : SessionId.make(sectional)
          })
        })

      const orderProblems = (order: ReadonlyArray<string>) => {
        const ids = taxonomy.sections.map((section) => section.id)
        const unknown = order.filter((section) => !ids.includes(section))
        const missing = ids.filter((section) => !order.includes(section))
        return [
          ...unknown.map((section) => `There is no Section ${section}.`),
          ...missing.map((section) => `The order leaves out ${sectionName(section).name}.`),
          ...(order.length > ids.length && unknown.length === 0 ? ["The order names a Section twice."] : [])
        ]
      }

      // One Mock or Sectional runs at a time, and a Mock starts only when
      // every Section passes the start check.
      const start = (caller: Caller, order: ReadonlyArray<string>) =>
        Effect.gen(function*() {
          const problems = orderProblems(order)
          if (problems.length > 0) return yield* new MockOrderInvalid({ problems })
          const active = yield* running(caller.profileId)
          if (active !== undefined) return yield* new MockRunning({ id: SessionId.make(active) })
          const sectional = yield* sectionals.runningSectional(caller.profileId)
          if (sectional !== undefined) return yield* new SectionalRunning({ id: SessionId.make(sectional) })
          const sections = yield* sectionals.readinessAll(caller.profileId)
          if (!sections.every((section) => section.ready)) return yield* new MockReserveTooSmall({ sections })
          const id = crypto.randomUUID()
          const now = yield* Clock.currentTimeMillis
          const config: MockConfig = { order: [...order], sections: [], flow: NewMock }
          yield* db.insert(sessions).values({
            id,
            profileId: caller.profileId,
            kind: "mock",
            timed: true,
            config: encodeConfig(config),
            status: "active",
            timeLimitMs: null,
            elapsedMs: 0,
            clockSavedAt: null,
            holder: caller.device ?? null,
            createdAt: now
          }).pipe(Effect.orDie)
          const mock = yield* own(caller.profileId, id).pipe(Effect.orDie)
          yield* saveConfig(id, yield* beginNext(mock, config))
          yield* wake.open
          return yield* settled(caller, id).pipe(Effect.orDie)
        }).pipe(oneAtATime)

      const list = (profileId: string) =>
        Effect.gen(function*() {
          const rows = yield* db.select().from(sessions)
            .where(and(eq(sessions.profileId, profileId), eq(sessions.kind, "mock")))
            .orderBy(desc(sessions.createdAt)).pipe(Effect.orDie)
          return yield* Effect.forEach(rows, (row) =>
            Effect.gen(function*() {
              const config = decodeMockConfig(row.config)
              const report = row.status === "finished" ? yield* reportOf(yield* sectionsOf(config)) : null
              return new MockSummary({
                id: SessionId.make(row.id),
                order: config.order.map(sectionName),
                finished: row.status === "finished",
                total: report?.total ?? null,
                rescored: report?.rescored ?? false,
                createdAt: row.createdAt,
                finishedAt: row.finishedAt
              })
            }))
        })

      const get = (caller: Caller, id: SessionId) => settled(caller, id).pipe(oneAtATime)

      const outOfStep = (mock: SessionRow, caller: Caller, reason: MockOutOfStep["reason"]) =>
        viewOf(mock, caller.device).pipe(Effect.flatMap((view) => Effect.fail(new MockOutOfStep({ reason, view }))))

      // Going on from the break starts the next Section now.
      const goOn = (caller: Caller, id: SessionId) =>
        Effect.gen(function*() {
          const mock = yield* settle(yield* own(caller.profileId, id))
          if (mock.status === "finished") return yield* outOfStep(mock, caller, "finished")
          if (!holdsIt(mock, caller.device)) return yield* new MockHeldElsewhere({ view: yield* viewOf(mock, caller.device) })
          const config = decodeMockConfig(mock.config)
          if (config.flow.stage !== "break") return yield* outOfStep(mock, caller, "not-on-break")
          const next = nextSection(config.flow, yield* Clock.currentTimeMillis)
          yield* saveConfig(mock.id, yield* beginNext(mock, { ...config, flow: next }))
          return yield* settled(caller, id).pipe(Effect.orDie)
        }).pipe(oneAtATime)

      // This device takes over the Mock and the Section running.
      const claim = (caller: Caller, id: SessionId) =>
        Effect.gen(function*() {
          const mock = yield* settle(yield* own(caller.profileId, id))
          if (caller.device !== undefined && mock.holder !== caller.device) {
            yield* db.update(sessions).set({ holder: caller.device }).where(eq(sessions.id, id)).pipe(Effect.orDie)
          }
          const config = decodeMockConfig(mock.config)
          const current = config.flow.stage === "section" ? config.sections[config.flow.started - 1] : undefined
          if (current !== undefined) yield* sectionals.claim(caller, SessionId.make(current)).pipe(Effect.orDie)
          return yield* settled(caller, id).pipe(Effect.orDie)
        }).pipe(oneAtATime)

      const tickAll = Effect.gen(function*() {
        const active = yield* db.select().from(sessions)
          .where(and(eq(sessions.kind, "mock"), eq(sessions.status, "active"))).pipe(Effect.orDie)
        if (active.length === 0) yield* wake.close
        for (const mock of active) yield* settle(mock)
      }).pipe(
        oneAtATime,
        Effect.catchCause((cause) => Effect.logError(`The Mock clock could not tick: ${Cause.pretty(cause)}`))
      )

      yield* Effect.forkScoped(
        Effect.forever(wake.await.pipe(Effect.andThen(Effect.sleep(TickMs)), Effect.andThen(tickAll)))
      )

      return Mocks.of({ options, start, list, get, goOn, claim })
    })
  )
}
