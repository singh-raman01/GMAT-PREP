import { and, asc, desc, eq, inArray } from "drizzle-orm"
import { Cause, Clock, Context, Effect, Latch, Layer, Schema, Semaphore } from "effect"
import { Blueprint, type GroupId, GroupIds, groupOf, groupsOf, sectionCount } from "../../api/blueprint.ts"
import { bandOf } from "../../api/difficulty.ts"
import {
  Named,
  PracticeClock,
  PracticeQuestion,
  type Selection,
  SelectionInvalid,
  ServedView,
  SessionId
} from "../../api/Practice.ts"
import { QuestionId } from "../../api/Review.ts"
import {
  GroupStockView,
  MaxChanges,
  ReserveTooSmall,
  ReviewEntry,
  SectionalHeldElsewhere,
  SectionalNotFound,
  SectionalOptions,
  SectionalOutOfStep,
  SectionalQuestion,
  SectionalReport,
  SectionalResult,
  SectionalRunning,
  SectionalSummary,
  SectionalView,
  SectionMinutes,
  SectionReadiness,
  UnknownSection
} from "../../api/Sectionals.ts"
import { Db } from "../db/Database.ts"
import { bookmarks, questions, responses, servedQuestions, sessions } from "../db/schema.ts"
import { type Caller, selectionProblems } from "../practice/Practice.ts"
import { type ClockState, fromSave, tick, TickMs } from "../practice/clock.ts"
import { debriefOf, namesOf, practiceQuestion, storedQuestions } from "../practice/content.ts"
import {
  bookmarkedBy,
  encodeSelection,
  isCorrect,
  keysOf,
  lastSeenBy,
  mergeTargets,
  publishedPool,
  readSelection
} from "../practice/history.ts"
import { rateSession } from "../ratings/rateSession.ts"
import { Settings } from "../settings/Settings.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { nextUnit, openSlots, sectionEstimate, sectionStock, seededRandom, type ServedUnit, type Unit } from "./adaptive.ts"
import { editPoints, sectionScoreOf } from "./score.ts"

// Sectionals: one Section alone under Mock rules (docs/design.md,
// "Sessions"). The next unit is chosen after each Response, adaptively; a
// Question must be answered before the next appears and there is no going
// back. When time remains after the last Question, Review & Edit allows up
// to three changed answers. The Section is scored, and Difficulty and
// Ability move, only when it closes.

const Tier = Schema.Literals(["reserve-near", "near", "reserve-far", "far", "seen"])

const ServedUnitRecord = Schema.Struct({
  unitId: Schema.String,
  group: Schema.Literals(GroupIds),
  // Its Questions in serving order, as they stood when it was chosen.
  questionIds: Schema.Array(Schema.String),
  tier: Tier,
  slot: Schema.Literals(["own", "passed"])
})

// What a Session of kind sectional stores in its config.
const SectionalConfig = Schema.Struct({
  section: Schema.String,
  // The Blueprint as it stood at the start.
  blueprint: Blueprint,
  // The units served, in order.
  units: Schema.Array(ServedUnitRecord),
  // Slots passed on by groups no unit could fill, by group.
  passed: Schema.Record(Schema.String, Schema.Int),
  stage: Schema.Literals(["question", "review"]),
  // Slots nothing was left to fill when Review & Edit began, which are not
  // scored.
  unfilled: Schema.Int,
  // Kept when the Section closes, so later Difficulty moves leave it as it was.
  report: Schema.NullOr(SectionalReport)
})
type SectionalConfig = typeof SectionalConfig.Type
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(SectionalConfig))
const decodeConfig = Schema.decodeUnknownSync(Schema.fromJsonString(SectionalConfig))

type SessionRow = typeof sessions.$inferSelect
type ResponseRow = typeof responses.$inferSelect

const LimitMs = SectionMinutes * 60 * 1000

export interface Change {
  readonly seq: number
  readonly questionId: QuestionId
  readonly selection: Selection
}

const servedUnitsOf = (config: SectionalConfig): ReadonlyArray<ServedUnit> =>
  config.units.map((unit) => ({ unitId: unit.unitId, group: unit.group, size: unit.questionIds.length, slot: unit.slot }))

const passedOf = (config: SectionalConfig) => config.passed as Readonly<Partial<Record<GroupId, number>>>

const sorted = (selection: Selection) => selection.toSorted((a, b) => a.part - b.part)

export class Sectionals extends Context.Service<Sectionals, {
  options(profileId: string): Effect.Effect<SectionalOptions>
  start(caller: Caller, section: string): Effect.Effect<SectionalView, UnknownSection | ReserveTooSmall | SectionalRunning>
  list(profileId: string): Effect.Effect<ReadonlyArray<SectionalSummary>>
  get(caller: Caller, id: SessionId): Effect.Effect<SectionalView, SectionalNotFound>
  answer(
    caller: Caller,
    id: SessionId,
    submit: Change
  ): Effect.Effect<SectionalView, SectionalNotFound | SectionalOutOfStep | SelectionInvalid | SectionalHeldElsewhere>
  bookmark(
    caller: Caller,
    id: SessionId,
    questionId: QuestionId,
    bookmarked: boolean
  ): Effect.Effect<SectionalView, SectionalNotFound | SectionalOutOfStep | SectionalHeldElsewhere>
  question(caller: Caller, id: SessionId, position: number): Effect.Effect<SectionalQuestion, SectionalNotFound | SectionalOutOfStep>
  change(
    caller: Caller,
    id: SessionId,
    submit: Change
  ): Effect.Effect<SectionalView, SectionalNotFound | SectionalOutOfStep | SelectionInvalid | SectionalHeldElsewhere>
  finish(caller: Caller, id: SessionId): Effect.Effect<SectionalView, SectionalNotFound | SectionalHeldElsewhere>
  claim(caller: Caller, id: SessionId): Effect.Effect<SectionalView, SectionalNotFound>
}>()("gmat-prep/server/Sectionals") {
  static readonly layer = Layer.effect(
    Sectionals,
    Effect.gen(function*() {
      const db = yield* Db
      const settings = yield* Settings
      const taxonomy = (yield* Taxonomy).view
      const names = namesOf(taxonomy)
      // Requests and the clock's ticks take turns.
      const oneAtATime = (yield* Semaphore.make(1)).withPermits(1)
      const run = <A, E>(effect: Effect.Effect<A, E, Db>) => effect.pipe(Effect.provideService(Db, db), Effect.orDie)

      // Runs an action in one transaction; its failures come back as values
      // so they do not roll back as defects.
      const inTransaction = <A, E>(action: Effect.Effect<A, E, never>) =>
        db.transaction(() => Effect.result(action)).pipe(
          Effect.orDie,
          Effect.flatMap((result) => (result._tag === "Success" ? Effect.succeed(result.success) : Effect.fail(result.failure)))
        )

      const sectionName = (id: string) => new Named({ id, name: taxonomy.sections.find((each) => each.id === id)?.name ?? id })

      const own = (profileId: string, id: string) =>
        db.select().from(sessions)
          .where(and(eq(sessions.id, id), eq(sessions.profileId, profileId), eq(sessions.kind, "sectional")))
          .pipe(
            Effect.orDie,
            Effect.flatMap((rows) => (rows[0] === undefined ? Effect.fail(new SectionalNotFound()) : Effect.succeed(rows[0])))
          )

      const servedOf = (sessionId: string) =>
        db.select().from(servedQuestions).where(eq(servedQuestions.sessionId, sessionId))
          .orderBy(asc(servedQuestions.position)).pipe(Effect.orDie)

      const responsesOf = (sessionId: string) =>
        db.select().from(responses).where(eq(responses.sessionId, sessionId)).orderBy(asc(responses.seq)).pipe(
          Effect.orDie
        )

      const saveConfig = (sessionId: string, config: SectionalConfig) =>
        db.update(sessions).set({ config: encodeConfig(config) }).where(eq(sessions.id, sessionId)).pipe(Effect.orDie)

      // Every unit the Section could serve the Profile: published Questions
      // whose Reserve decision is made, an RC passage's or MSR set's
      // together, with whether they are held for Mocks and when the Profile
      // last saw one of them.
      const poolFor = (profileId: string, section: string) =>
        Effect.gen(function*() {
          const published = (yield* run(publishedPool))
            .filter((question) => question.section === section && question.reserve !== null)
          const lastSeen = yield* run(lastSeenBy(profileId))
          const units = new Map<string, { group: GroupId; members: Array<(typeof published)[number]> }>()
          for (const question of published) {
            const group = groupOf(question.questionType)
            if (group === undefined) continue
            const unitId = group.units ? question.stimulusId : question.id
            if (unitId === null) continue
            const unit = units.get(unitId) ?? { group: group.id, members: [] }
            unit.members.push(question)
            units.set(unitId, unit)
          }
          return [...units].map(([id, unit]): Unit => {
            const seenAt = unit.members.flatMap((member) => {
              const at = lastSeen.get(member.id)
              return at === undefined ? [] : [at]
            })
            return {
              id,
              group: unit.group,
              questionIds: unit.members.map((member) => member.id),
              difficulty: unit.members.reduce((sum, member) => sum + member.difficulty, 0) / unit.members.length,
              reserve: unit.members.every((member) => member.reserve === true && !member.released),
              lastSeenAt: seenAt.length === 0 ? null : Math.max(...seenAt)
            }
          })
        })

      const readiness = (profileId: string, section: string) =>
        Effect.gen(function*() {
          const blueprint = yield* settings.blueprint
          const stock = sectionStock(blueprint, section, yield* poolFor(profileId, section))
          return new SectionReadiness({
            section: sectionName(section),
            questions: sectionCount(blueprint, section),
            minutes: SectionMinutes,
            ready: stock.every((group) => group.unseen >= group.needed),
            groups: stock.map((group) =>
              new GroupStockView({
                group: new Named({ id: group.group, name: groupsOf(section).find((each) => each.id === group.group)!.name }),
                needed: group.needed,
                unseen: group.unseen,
                byBand: group.byBand
              })
            )
          })
        })

      // The clocks of Sectionals now running, as last ticked.
      const clocks = new Map<string, ClockState>()
      // Open while a Sectional may be running; it starts open, so the first
      // tick picks up Sectionals left running when the app last stopped.
      const wake = yield* Latch.make(true)

      // A Question is served at a moment of the clock, which is saved then.
      const serve = (sessionId: string, position: number, questionId: string, servedElapsedMs: number) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          yield* db.insert(servedQuestions).values({ sessionId, position, questionId, servedAt: now, servedElapsedMs })
            .pipe(Effect.orDie)
          yield* db.update(sessions).set({ elapsedMs: servedElapsedMs, clockSavedAt: now }).where(eq(sessions.id, sessionId))
            .pipe(Effect.orDie)
          const state = clocks.get(sessionId)
          if (state !== undefined) clocks.set(sessionId, { ...state, savedAt: now })
        })

      const peek = (session: SessionRow, now: number) => {
        if (session.timeLimitMs === null || session.status !== "active") {
          return { ticked: undefined, elapsedMs: session.elapsedMs }
        }
        const state = clocks.get(session.id) ?? fromSave(session.elapsedMs, session.clockSavedAt ?? now)
        const ticked = tick(state, now, session.timeLimitMs)
        return { ticked, elapsedMs: ticked.next.elapsedMs }
      }

      // Ticks the clock now, as its own ticks do, so a request before the
      // next tick still sees a gap or the time run out.
      const advance = (session: SessionRow, now: number) =>
        Effect.gen(function*() {
          const { ticked, elapsedMs } = peek(session, now)
          if (ticked === undefined) return { elapsedMs, expired: false }
          clocks.set(session.id, ticked.next)
          if (ticked.save) {
            yield* db.update(sessions).set({
              elapsedMs,
              clockSavedAt: now,
              ...(ticked.lost ? { interrupted: true } : {})
            }).where(eq(sessions.id, session.id)).pipe(Effect.orDie)
          }
          return { elapsedMs, expired: ticked.expired }
        })

      const holdsIt = (session: SessionRow, device: string | undefined) =>
        session.holder === null || device === undefined || session.holder === device

      // The Section's estimate from its answers so far, each at its
      // Question's current Difficulty.
      const estimateOf = (served: ReadonlyArray<typeof servedQuestions.$inferSelect>, answers: ReadonlyArray<ResponseRow>) =>
        Effect.gen(function*() {
          const ids = [...new Set(answers.map((answer) => answer.questionId))]
          const keys = yield* run(keysOf(ids))
          const levels = yield* difficultiesOf(ids)
          const scored = served.flatMap((row) => {
            const answer = answers.findLast((each) => each.questionId === row.questionId)
            if (answer === undefined) return []
            return [{
              difficulty: levels.get(row.questionId) ?? 0,
              correct: answer.kind !== "time-out" && isCorrect(readSelection(answer.selection), keys.get(row.questionId) ?? [])
            }]
          })
          return sectionEstimate(scored)
        })

      const difficultiesOf = (ids: ReadonlyArray<string>) =>
        Effect.gen(function*() {
          if (ids.length === 0) return new Map<string, number>()
          const stored = yield* run(storedQuestions([...ids]))
          return new Map([...stored].map(([id, question]) => [id, question.difficulty] as const))
        })

      // Serves the next Question: the rest of the unit on screen, else the
      // unit the selection picks. When nothing more can be served, Review &
      // Edit begins.
      const serveNext = (session: SessionRow, config: SectionalConfig, elapsedMs: number) =>
        Effect.gen(function*() {
          const served = yield* servedOf(session.id)
          const position = served.length
          const servedIds = new Set(served.map((row) => row.questionId))
          const last = config.units.at(-1)
          const rest = last?.questionIds.filter((id) => !servedIds.has(id)) ?? []
          const statuses = rest.length === 0 ? [] : yield* db.select({ id: questions.id, status: questions.status })
            .from(questions).where(inArray(questions.id, rest)).pipe(Effect.orDie)
          // A Question that left the Question Bank since its unit was chosen is passed over.
          const nextInUnit = rest.find((id) => statuses.some((row) => row.id === id && row.status === "published"))
          if (nextInUnit !== undefined) return yield* serve(session.id, position, nextInUnit, elapsedMs)
          const pool = yield* poolFor(session.profileId, config.section)
          const estimate = yield* estimateOf(served, yield* responsesOf(session.id))
          const step = nextUnit({
            blueprint: config.blueprint,
            section: config.section,
            pool,
            served: servedUnitsOf(config),
            passed: passedOf(config),
            estimate,
            random: seededRandom(`${session.id}:${position}`)
          })
          const passed = { ...config.passed, ...step.passed } as Record<string, number>
          if (step.pick === undefined) {
            const open = openSlots(config.blueprint, config.section, servedUnitsOf(config), step.passed)
            const unfilled = [...open.own.values()].flat().reduce((sum, size) => sum + size, 0) + open.passed
            return yield* saveConfig(session.id, { ...config, passed, stage: "review", unfilled })
          }
          const pick = step.pick
          yield* saveConfig(session.id, {
            ...config,
            passed,
            units: [...config.units, {
              unitId: pick.unit.id,
              group: pick.unit.group,
              questionIds: [...pick.unit.questionIds],
              tier: pick.tier,
              slot: pick.slot
            }]
          })
          yield* serve(session.id, position, pick.unit.questionIds[0]!, elapsedMs)
        })

      // The report, from the Section as it closes: the final Responses at
      // the Questions' Difficulty now, before the Rated Responses move it.
      const reportOf = (session: SessionRow, config: SectionalConfig, elapsedMs: number) =>
        Effect.gen(function*() {
          const served = yield* servedOf(session.id)
          const answers = yield* responsesOf(session.id)
          const ids = served.map((row) => row.questionId)
          const keys = yield* run(keysOf(ids))
          const levels = yield* difficultiesOf(ids)
          const types = ids.length === 0 ? [] : yield* db.select({ id: questions.id, questionType: questions.questionType })
            .from(questions).where(inArray(questions.id, ids)).pipe(Effect.orDie)
          const marked = yield* run(bookmarkedBy(session.profileId))
          const resolve = yield* run(mergeTargets)
          const repeatIds = new Set(config.units.filter((unit) => unit.tier === "seen").flatMap((unit) => unit.questionIds))
          const right = (answer: ResponseRow | undefined, questionId: string) =>
            answer !== undefined && answer.kind !== "time-out" &&
            isCorrect(readSelection(answer.selection), keys.get(questionId) ?? [])
          const results = served.map((row) => {
            const mine = answers.filter((each) => each.questionId === row.questionId)
            const first = mine[0]
            const final = mine.at(-1)
            const edited = mine.some((each) => each.kind === "edit")
            const difficulty = levels.get(row.questionId) ?? 0
            return new SectionalResult({
              position: row.position,
              questionId: QuestionId.make(row.questionId),
              questionType: names.named(types.find((type) => type.id === row.questionId)?.questionType ?? ""),
              difficulty,
              band: bandOf(difficulty),
              correct: right(final, row.questionId),
              timedOut: final?.kind === "time-out",
              unanswered: final === undefined,
              timeSpentMs: first?.timeSpentMs ?? Math.max(0, elapsedMs - (row.servedElapsedMs ?? 0)),
              bookmarked: marked.has(resolve(row.questionId)),
              repeat: repeatIds.has(row.questionId),
              change: edited ? { wasCorrect: right(first, row.questionId), isCorrect: right(final, row.questionId) } : null
            })
          })
          // Slots left open, and the rest of a unit cut short, were never reached.
          const unreached = config.stage === "review" ? 0 : (() => {
            const open = openSlots(config.blueprint, config.section, servedUnitsOf(config), passedOf(config))
            const servedIds = new Set(ids)
            const cut = config.units.at(-1)?.questionIds.filter((id) => !servedIds.has(id)).length ?? 0
            return [...open.own.values()].flat().reduce((sum, size) => sum + size, 0) + open.passed + cut
          })()
          const finalAnswers = results.map((result) => ({ difficulty: result.difficulty, correct: result.correct }))
          const firstAnswers = results.map((result) => ({
            difficulty: result.difficulty,
            correct: result.change === null ? result.correct : result.change.wasCorrect
          }))
          const scored = sectionScoreOf(finalAnswers, unreached)
          return new SectionalReport({
            score: scored.estimate.score,
            low: scored.estimate.low,
            high: scored.estimate.high,
            ability: scored.fit.ability,
            standardError: scored.fit.standardError,
            results,
            unreached,
            unfilled: config.unfilled,
            repeats: results.filter((result) => result.repeat).length,
            changes: answers.filter((answer) => answer.kind === "edit").length,
            editPoints: editPoints(firstAnswers, finalAnswers, unreached)
          })
        })

      // Ends the Sectional: the Learner finished it, or its time ran out. Its
      // report is kept, then its Rated Responses move Difficulty and Ability.
      const end = (session: SessionRow, endedBy: "finished" | "time", elapsedMs: number) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          clocks.delete(session.id)
          const config = decodeConfig(session.config)
          yield* db.update(sessions).set({ status: "finished", endedBy, finishedAt: now, elapsedMs, clockSavedAt: now })
            .where(eq(sessions.id, session.id)).pipe(Effect.orDie)
          const report = yield* reportOf(session, config, elapsedMs)
          yield* saveConfig(session.id, { ...config, report })
          yield* run(rateSession(session))
        })

      // When time runs out on a Question, it gets a time-out Response: wrong,
      // and never Rated. In Review & Edit the Section just ends.
      const expire = (session: SessionRow) =>
        Effect.gen(function*() {
          const config = decodeConfig(session.config)
          const served = yield* servedOf(session.id)
          const answers = yield* responsesOf(session.id)
          const current = served.at(-1)
          if (config.stage === "question" && current !== undefined && !answers.some((each) => each.questionId === current.questionId)) {
            yield* db.insert(responses).values({
              id: crypto.randomUUID(),
              profileId: session.profileId,
              sessionId: session.id,
              questionId: current.questionId,
              seq: Math.max(0, ...answers.map((each) => each.seq)) + 1,
              selection: encodeSelection([]),
              timeSpentMs: Math.max(0, LimitMs - (current.servedElapsedMs ?? 0)),
              guessed: false,
              kind: "time-out",
              supersedes: null,
              createdAt: yield* Clock.currentTimeMillis
            }).pipe(Effect.orDie)
          }
          yield* end(session, "time", LimitMs)
        })

      const servedView = (
        session: SessionRow,
        row: typeof servedQuestions.$inferSelect,
        context: { readonly marked: ReadonlySet<string>; readonly resolve: (id: string) => string },
        final: ResponseRow | undefined
      ) =>
        Effect.gen(function*() {
          const stored = (yield* run(storedQuestions([row.questionId]))).get(row.questionId)
          if (stored === undefined) return yield* Effect.die(new Error(`Served Question ${row.questionId} is missing`))
          const over = session.status === "finished"
          const question = practiceQuestion(stored, names, null)
          const selection = final === undefined ? [] : readSelection(final.selection)
          return new ServedView({
            position: row.position,
            // A running Section does not say where a Question comes from.
            question: over ? question : new PracticeQuestion({ ...question, source: null }),
            bookmarked: context.marked.has(context.resolve(row.questionId)),
            response: null,
            debrief: over ? debriefOf(stored, selection, names) : null
          })
        })

      const viewOf = (session: SessionRow, device: string | undefined) =>
        Effect.gen(function*() {
          const config = decodeConfig(session.config)
          const now = yield* Clock.currentTimeMillis
          const served = yield* servedOf(session.id)
          const answers = yield* responsesOf(session.id)
          const marked = yield* run(bookmarkedBy(session.profileId))
          const resolve = yield* run(mergeTargets)
          const over = session.status === "finished"
          const stage = over ? "finished" as const : config.stage
          const last = served.at(-1)
          const current = stage === "question" && last !== undefined
            ? yield* servedView(session, last, { marked, resolve }, undefined)
            : null
          const changes = answers.filter((answer) => answer.kind === "edit")
          const review = stage !== "review" ? null : {
            entries: yield* Effect.gen(function*() {
              const ids = served.map((row) => row.questionId)
              const types = yield* db.select({ id: questions.id, questionType: questions.questionType }).from(questions)
                .where(inArray(questions.id, ids)).pipe(Effect.orDie)
              return served.map((row) =>
                new ReviewEntry({
                  position: row.position,
                  questionId: QuestionId.make(row.questionId),
                  questionType: names.named(types.find((type) => type.id === row.questionId)?.questionType ?? ""),
                  bookmarked: marked.has(resolve(row.questionId)),
                  changed: changes.some((change) => change.questionId === row.questionId)
                })
              )
            }),
            changesLeft: Math.max(0, MaxChanges - changes.length)
          }
          const { ticked, elapsedMs } = peek(session, now)
          const limitMs = session.timeLimitMs ?? LimitMs
          return new SectionalView({
            id: SessionId.make(session.id),
            section: sectionName(config.section),
            stage,
            total: sectionCount(config.blueprint, config.section),
            answered: new Set(answers.map((answer) => answer.questionId)).size,
            current,
            review,
            nextSeq: (answers.at(-1)?.seq ?? 0) + 1,
            clock: new PracticeClock({
              limitMs,
              elapsedMs,
              remainingMs: Math.max(0, limitMs - elapsedMs),
              interrupted: session.interrupted || ticked?.lost === true
            }),
            heldHere: holdsIt(session, device),
            endedBy: session.endedBy === "time" ? "time" : session.endedBy === "finished" ? "finished" : null,
            report: over ? config.report : null,
            createdAt: session.createdAt,
            finishedAt: session.finishedAt
          })
        })

      const outOfStep = (session: SessionRow, device: string | undefined, reason: SectionalOutOfStep["reason"]) =>
        viewOf(session, device).pipe(Effect.flatMap((view) => Effect.fail(new SectionalOutOfStep({ reason, view }))))

      const held = (caller: Caller, id: string) =>
        Effect.gen(function*() {
          const session = yield* own(caller.profileId, id)
          if (!holdsIt(session, caller.device)) {
            return yield* new SectionalHeldElsewhere({ view: yield* viewOf(session, caller.device) })
          }
          return session
        })

      // A request that finds the time run out ends the Sectional by time,
      // and says it had ended.
      const expireFor = (caller: Caller, session: SessionRow) =>
        Effect.gen(function*() {
          yield* expire(session)
          return yield* outOfStep(yield* own(caller.profileId, session.id).pipe(Effect.orDie), caller.device, "finished")
        })

      const after = (caller: Caller, id: string) =>
        own(caller.profileId, id).pipe(Effect.orDie, Effect.flatMap((session) => viewOf(session, caller.device)))

      const running = (profileId: string) =>
        db.select({ id: sessions.id }).from(sessions)
          .where(and(eq(sessions.profileId, profileId), eq(sessions.kind, "sectional"), eq(sessions.status, "active")))
          .pipe(Effect.orDie, Effect.map((rows) => rows[0]?.id))

      const options = (profileId: string) =>
        Effect.gen(function*() {
          const sections = yield* Effect.forEach(taxonomy.sections, (section) => readiness(profileId, section.id))
          const active = yield* running(profileId)
          return new SectionalOptions({ sections, running: active === undefined ? null : SessionId.make(active) })
        })

      const start = (caller: Caller, section: string) =>
        Effect.gen(function*() {
          if (!taxonomy.sections.some((each) => each.id === section)) return yield* new UnknownSection({ section })
          const active = yield* running(caller.profileId)
          if (active !== undefined) return yield* new SectionalRunning({ id: SessionId.make(active) })
          const ready = yield* readiness(caller.profileId, section)
          if (!ready.ready) return yield* new ReserveTooSmall({ readiness: ready })
          const blueprint = yield* settings.blueprint
          const id = crypto.randomUUID()
          yield* inTransaction(Effect.gen(function*() {
            const now = yield* Clock.currentTimeMillis
            const config: SectionalConfig = {
              section,
              blueprint,
              units: [],
              passed: {},
              stage: "question",
              unfilled: 0,
              report: null
            }
            yield* db.insert(sessions).values({
              id,
              profileId: caller.profileId,
              kind: "sectional",
              timed: true,
              config: encodeConfig(config),
              status: "active",
              timeLimitMs: LimitMs,
              elapsedMs: 0,
              clockSavedAt: now,
              holder: caller.device ?? null,
              createdAt: now
            }).pipe(Effect.orDie)
            const session = yield* own(caller.profileId, id).pipe(Effect.orDie)
            yield* serveNext(session, config, 0)
          }))
          yield* wake.open
          return yield* after(caller, id)
        }).pipe(oneAtATime)

      const list = (profileId: string) =>
        Effect.gen(function*() {
          const rows = yield* db.select().from(sessions)
            .where(and(eq(sessions.profileId, profileId), eq(sessions.kind, "sectional")))
            .orderBy(desc(sessions.createdAt)).pipe(Effect.orDie)
          return rows.map((row) => {
            const config = decodeConfig(row.config)
            return new SectionalSummary({
              id: SessionId.make(row.id),
              section: sectionName(config.section),
              finished: row.status === "finished",
              score: config.report?.score ?? null,
              low: config.report?.low ?? null,
              high: config.report?.high ?? null,
              createdAt: row.createdAt,
              finishedAt: row.finishedAt
            })
          })
        })

      const get = (caller: Caller, id: SessionId) =>
        own(caller.profileId, id).pipe(Effect.flatMap((session) => viewOf(session, caller.device)))

      // The same submit sent again is recorded once; another with its
      // number comes from a screen out of date.
      const repeated = (session: SessionRow, caller: Caller, submit: Change) =>
        Effect.gen(function*() {
          const [repeat] = yield* db.select().from(responses)
            .where(and(eq(responses.sessionId, session.id), eq(responses.seq, submit.seq))).pipe(Effect.orDie)
          if (repeat === undefined) return false
          const same = repeat.questionId === submit.questionId && repeat.selection === encodeSelection(sorted(submit.selection))
          if (same) return true
          return yield* outOfStep(session, caller.device, session.status === "finished" ? "finished" : "not-current")
        })

      const answer = (caller: Caller, id: SessionId, submit: Change) =>
        inTransaction(Effect.gen(function*() {
          const session = yield* held(caller, id)
          if (yield* repeated(session, caller, submit)) return
          if (session.status !== "active") return yield* outOfStep(session, caller.device, "finished")
          const now = yield* Clock.currentTimeMillis
          const { elapsedMs, expired } = yield* advance(session, now)
          if (expired) return yield* expireFor(caller, session)
          const config = decodeConfig(session.config)
          if (config.stage !== "question") return yield* outOfStep(session, caller.device, "answered")
          const served = yield* servedOf(id)
          const current = served.at(-1)
          if (current === undefined || current.questionId !== submit.questionId) {
            return yield* outOfStep(session, caller.device, "not-current")
          }
          const given = (yield* responsesOf(id)).some((each) => each.questionId === current.questionId)
          if (given) return yield* outOfStep(session, caller.device, "answered")
          const stored = (yield* run(storedQuestions([current.questionId]))).get(current.questionId)!
          const problems = selectionProblems(stored, submit.selection)
          if (problems.length > 0) return yield* new SelectionInvalid({ problems })
          yield* db.insert(responses).values({
            id: crypto.randomUUID(),
            profileId: caller.profileId,
            sessionId: id,
            questionId: current.questionId,
            seq: submit.seq,
            selection: encodeSelection(sorted(submit.selection)),
            timeSpentMs: Math.max(0, elapsedMs - (current.servedElapsedMs ?? 0)),
            guessed: false,
            kind: "first",
            supersedes: null,
            createdAt: now
          }).pipe(Effect.orDie)
          yield* serveNext(session, config, elapsedMs)
        })).pipe(Effect.flatMap(() => after(caller, id)), oneAtATime)

      // A Bookmark is the Profile's, as in Practice Sets.
      const bookmark = (caller: Caller, id: SessionId, questionId: QuestionId, bookmarked: boolean) =>
        inTransaction(Effect.gen(function*() {
          const session = yield* held(caller, id)
          const served = yield* servedOf(id)
          if (!served.some((row) => row.questionId === questionId)) {
            return yield* outOfStep(session, caller.device, "not-current")
          }
          const now = yield* Clock.currentTimeMillis
          const target = (yield* run(mergeTargets))(questionId)
          if (bookmarked) {
            yield* db.insert(bookmarks).values({ profileId: caller.profileId, questionId: target, sessionId: id, createdAt: now })
              .onConflictDoNothing().pipe(Effect.orDie)
          } else {
            yield* db.delete(bookmarks)
              .where(and(eq(bookmarks.profileId, caller.profileId), eq(bookmarks.questionId, target)))
              .pipe(Effect.orDie)
          }
        })).pipe(Effect.flatMap(() => after(caller, id)), oneAtATime)

      // In Review & Edit a served Question shows with the answer that
      // stands; once the Sectional is over, with its Debrief. While
      // Questions are still coming, none can be gone back to.
      const question = (caller: Caller, id: SessionId, position: number) =>
        Effect.gen(function*() {
          const session = yield* own(caller.profileId, id)
          const config = decodeConfig(session.config)
          if (session.status !== "finished" && config.stage !== "review") {
            return yield* outOfStep(session, caller.device, "not-in-review")
          }
          const served = yield* servedOf(id)
          const row = served.find((each) => each.position === position)
          if (row === undefined) return yield* outOfStep(session, caller.device, "not-current")
          const final = (yield* responsesOf(id)).findLast((each) => each.questionId === row.questionId)
          const marked = yield* run(bookmarkedBy(session.profileId))
          const resolve = yield* run(mergeTargets)
          return new SectionalQuestion({
            served: yield* servedView(session, row, { marked, resolve }, final),
            selection: final === undefined || final.kind === "time-out" ? null : readSelection(final.selection)
          })
        })

      const change = (caller: Caller, id: SessionId, submit: Change) =>
        inTransaction(Effect.gen(function*() {
          const session = yield* held(caller, id)
          if (yield* repeated(session, caller, submit)) return
          if (session.status !== "active") return yield* outOfStep(session, caller.device, "finished")
          const now = yield* Clock.currentTimeMillis
          const { expired } = yield* advance(session, now)
          if (expired) return yield* expireFor(caller, session)
          const config = decodeConfig(session.config)
          if (config.stage !== "review") return yield* outOfStep(session, caller.device, "not-in-review")
          const answers = yield* responsesOf(id)
          if (answers.filter((each) => each.kind === "edit").length >= MaxChanges) {
            return yield* outOfStep(session, caller.device, "no-changes-left")
          }
          const served = yield* servedOf(id)
          if (!served.some((row) => row.questionId === submit.questionId)) {
            return yield* outOfStep(session, caller.device, "not-current")
          }
          const standing = answers.findLast((each) => each.questionId === submit.questionId)
          const selection = encodeSelection(sorted(submit.selection))
          if (standing !== undefined && standing.selection === selection) {
            return yield* outOfStep(session, caller.device, "same-answer")
          }
          const stored = (yield* run(storedQuestions([submit.questionId]))).get(submit.questionId)!
          const problems = selectionProblems(stored, submit.selection)
          if (problems.length > 0) return yield* new SelectionInvalid({ problems })
          yield* db.insert(responses).values({
            id: crypto.randomUUID(),
            profileId: caller.profileId,
            sessionId: id,
            questionId: submit.questionId,
            seq: submit.seq,
            selection,
            timeSpentMs: 0,
            guessed: false,
            kind: "edit",
            supersedes: standing?.id ?? null,
            createdAt: now
          }).pipe(Effect.orDie)
        })).pipe(Effect.flatMap(() => after(caller, id)), oneAtATime)

      // Ends the Sectional now. Time that ran out before the clock's next
      // tick ends it by time instead.
      const finish = (caller: Caller, id: SessionId) =>
        inTransaction(Effect.gen(function*() {
          const session = yield* held(caller, id)
          if (session.status === "finished") return
          const { elapsedMs, expired } = yield* advance(session, yield* Clock.currentTimeMillis)
          if (expired) yield* expire(session)
          else yield* end(session, "finished", elapsedMs)
        })).pipe(Effect.flatMap(() => after(caller, id)), oneAtATime)

      const claim = (caller: Caller, id: SessionId) =>
        Effect.gen(function*() {
          const session = yield* own(caller.profileId, id)
          if (caller.device !== undefined && session.holder !== caller.device) {
            yield* db.update(sessions).set({ holder: caller.device }).where(eq(sessions.id, id)).pipe(Effect.orDie)
          }
          return yield* after(caller, id)
        }).pipe(oneAtATime)

      // One tick of every running Sectional's clock. With none running, the
      // clock stops until one starts.
      const tickAll = Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        const active = yield* db.select().from(sessions)
          .where(and(eq(sessions.kind, "sectional"), eq(sessions.status, "active"))).pipe(Effect.orDie)
        if (active.length === 0) yield* wake.close
        const ids = new Set(active.map((session) => session.id))
        for (const id of [...clocks.keys()]) if (!ids.has(id)) clocks.delete(id)
        for (const session of active) {
          const { expired } = yield* advance(session, now)
          if (expired) yield* inTransaction(expire(session))
        }
      }).pipe(
        oneAtATime,
        Effect.catchCause((cause) => Effect.logError(`The Sectional clock could not tick: ${Cause.pretty(cause)}`))
      )

      yield* Effect.forkScoped(
        Effect.forever(wake.await.pipe(Effect.andThen(Effect.sleep(TickMs)), Effect.andThen(tickAll)))
      )

      return Sectionals.of({ options, start, list, get, answer, bookmark, question, change, finish, claim })
    })
  )
}
