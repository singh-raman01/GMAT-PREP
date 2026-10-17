import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { Cause, Clock, Context, Effect, Latch, Layer, Schema, Semaphore } from "effect"
import { setKey } from "../../api/bookMapRules.ts"
import { BookId, BookNotFound } from "../../api/Books.ts"
import { bandNames } from "../../api/difficulty.ts"
import {
  type BookChoice,
  FiltersInvalid,
  type FilterChoice,
  HeldElsewhere,
  ItemRef,
  NoQuestionsMatch,
  PracticeChoice,
  PracticeClock,
  PracticeNotFound,
  PracticeOptions,
  PracticeOutOfStep,
  PracticePreview,
  PracticeResult,
  PracticeSummary,
  PracticeView,
  QuestionNotFound,
  ResponseView,
  ScoreEstimateView,
  type Selection,
  SelectionInvalid,
  ServedView,
  SessionId,
  SimilarCount,
  SkipReason
} from "../../api/Practice.ts"
import { QuestionId } from "../../api/Review.ts"
import { targetSecondsFor } from "../../api/targetTimes.ts"
import { Db } from "../db/Database.ts"
import {
  bookmarks,
  books,
  questions,
  responses,
  servedQuestions,
  sessions,
  sources
} from "../db/schema.ts"
import { sessionMistakes } from "../learning/facts.ts"
import { RetryItem } from "../learning/retryConfig.ts"
import { scoreEstimatesOf, scoreEstimateView } from "../ratings/estimates.ts"
import { rateSession } from "../ratings/rateSession.ts"
import { ratedAmong } from "../ratings/rated.ts"
import { Settings } from "../settings/Settings.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { type ClockState, fromSave, tick, TickMs } from "./clock.ts"
import { debriefOf, namesOf, practiceQuestion, type StoredQuestion, storedQuestions } from "./content.ts"
import {
  bookmarkedBy,
  difficultyOf,
  encodeSelection,
  heldBySections,
  historyOf,
  isCorrect,
  keysOf,
  mergeTargets,
  publishedPool,
  readSelection,
  seenBy
} from "./history.ts"
import {
  bookOrder,
  type BookItem,
  matchesFilters,
  openToPractice,
  pickByFilters,
  pickSimilar,
  type SkippedItem
} from "./selection.ts"

// Practice Sets. A set's Questions are chosen when it starts and served one
// at a time; serving a Question makes it Seen. Responses are facts:
// recorded once per sequence number and never edited (ADR 0005). One device
// holds a set at a time.
//
// A timed set runs on the server's clock (ADR 0009) for the sum of its
// Target Times: each answer serves the next Question at once, the Debriefs
// wait for the end, and when time runs out the Question on screen gets a
// time-out Response. When it ends, its Rated Responses move Difficulty and
// the Sections' Score Estimates, in the order they were given, so nothing
// shows how an answer went before the set does. Untimed Responses are never
// Rated.

const Ref = Schema.Struct({ set: Schema.String, number: Schema.Int, reason: SkipReason })

// What a Session of kind practice stores in its config.
const PracticeConfig = Schema.Struct({
  title: Schema.String,
  // How the set was chosen; null for similar Questions.
  choice: Schema.NullOr(PracticeChoice),
  similarTo: Schema.NullOr(Schema.String),
  requested: Schema.NullOr(Schema.Int),
  // The Book whose printed place each Question shows.
  bookId: Schema.NullOr(Schema.String),
  // The Questions, in the order they are served.
  planned: Schema.Array(Schema.String),
  // For a book-order set, the item each Question is served at.
  places: Schema.optional(
    Schema.Array(Schema.Struct({ questionId: Schema.String, set: Schema.String, number: Schema.Int }))
  ),
  heldForMocks: Schema.Array(Ref),
  unavailable: Schema.Array(Ref),
  // For a retry set: the Error Log entry and Retry Ladder step each planned
  // Question is for.
  retry: Schema.optional(Schema.Array(RetryItem))
})
type PracticeConfig = typeof PracticeConfig.Type
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(PracticeConfig))
const decodeConfig = Schema.decodeUnknownSync(Schema.fromJsonString(PracticeConfig))

type SessionRow = typeof sessions.$inferSelect
type ResponseRow = typeof responses.$inferSelect

// Who acts: the Profile, from its unlock, and the device, from the
// x-gp-device header; a client that sends none acts as any device.
export interface Caller {
  readonly profileId: string
  readonly device: string | undefined
}

export interface Submit {
  readonly seq: number
  readonly questionId: QuestionId
  readonly selection: Selection
  readonly guessed: boolean
}

interface Plan {
  readonly questionIds: ReadonlyArray<string>
  readonly matching: number
  readonly places: NonNullable<PracticeConfig["places"]>
  readonly heldForMocks: ReadonlyArray<SkippedItem>
  readonly unavailable: ReadonlyArray<SkippedItem>
  // How many Questions it leaves out because a running Sectional chose them,
  // and for a book-order set, their items.
  readonly inSection: number
  readonly inSectionItems: ReadonlyArray<SkippedItem>
}

// What a selection gets wrong: each of the Question's Parts takes one of its
// own options, once.
export const selectionProblems = (question: StoredQuestion, selection: Selection): ReadonlyArray<string> => {
  const problems: Array<string> = []
  for (const choice of selection) {
    const part = question.parts.find((each) => each.position === choice.part)
    if (part === undefined) problems.push(`The Question has no Part ${choice.part + 1}.`)
    else if (!part.options.some((option) => option.label === choice.choice)) {
      problems.push(`${choice.choice} is not an option${question.parts.length > 1 ? ` of Part ${choice.part + 1}` : ""}.`)
    }
  }
  for (const part of question.parts) {
    const given = selection.filter((choice) => choice.part === part.position).length
    const which = question.parts.length > 1 ? ` for Part ${part.position + 1}` : ""
    if (given === 0) problems.push(`Choose an answer${which}.`)
    if (given > 1) problems.push(`Choose one answer${which}.`)
  }
  return problems
}

const statusWords = { any: undefined, unseen: "unseen", missed: "missed before", bookmarked: "Bookmarked" } as const

const stateOf = (session: { readonly status: string }) =>
  session.status === "finished" ? "finished" as const : session.status === "paused" ? "paused" as const : "active" as const

export class Practice extends Context.Service<Practice, {
  options(profileId: string): Effect.Effect<PracticeOptions>
  preview(profileId: string, choice: PracticeChoice): Effect.Effect<PracticePreview, FiltersInvalid | BookNotFound>
  start(caller: Caller, choice: PracticeChoice): Effect.Effect<PracticeView, FiltersInvalid | BookNotFound | NoQuestionsMatch>
  list(profileId: string): Effect.Effect<ReadonlyArray<PracticeSummary>>
  get(caller: Caller, id: SessionId): Effect.Effect<PracticeView, PracticeNotFound>
  answer(
    caller: Caller,
    id: SessionId,
    submit: Submit
  ): Effect.Effect<PracticeView, PracticeNotFound | PracticeOutOfStep | SelectionInvalid | HeldElsewhere>
  next(
    caller: Caller,
    id: SessionId,
    position: number
  ): Effect.Effect<PracticeView, PracticeNotFound | PracticeOutOfStep | HeldElsewhere>
  bookmark(
    caller: Caller,
    id: SessionId,
    questionId: QuestionId,
    bookmarked: boolean
  ): Effect.Effect<PracticeView, PracticeNotFound | PracticeOutOfStep | HeldElsewhere>
  finish(caller: Caller, id: SessionId): Effect.Effect<PracticeView, PracticeNotFound | HeldElsewhere>
  pause(caller: Caller, id: SessionId): Effect.Effect<PracticeView, PracticeNotFound | PracticeOutOfStep | HeldElsewhere>
  resume(caller: Caller, id: SessionId): Effect.Effect<PracticeView, PracticeNotFound | PracticeOutOfStep | HeldElsewhere>
  claim(caller: Caller, id: SessionId): Effect.Effect<PracticeView, PracticeNotFound>
  review(caller: Caller, id: SessionId, position: number): Effect.Effect<ServedView, PracticeNotFound | PracticeOutOfStep>
  similar(caller: Caller, questionId: QuestionId): Effect.Effect<PracticeView, QuestionNotFound | NoQuestionsMatch>
  scores(profileId: string): Effect.Effect<ReadonlyArray<ScoreEstimateView>>
  // A retry set of the given Questions, each for its entry and step; the
  // caller has chosen them.
  startRetries(caller: Caller, items: ReadonlyArray<RetryItem>, timed: boolean): Effect.Effect<PracticeView>
}>()("gmat-prep/server/Practice") {
  static readonly layer = Layer.effect(
    Practice,
    Effect.gen(function*() {
      const db = yield* Db
      const settings = yield* Settings
      const taxonomy = (yield* Taxonomy).view
      const names = namesOf(taxonomy)
      const mistakeChoices = taxonomy.mistakeTypes.map((each) => names.named(each.id))
      // Requests and the clock's ticks take turns.
      const oneAtATime = (yield* Semaphore.make(1)).withPermits(1)
      // Reads shared with other modules; a failed query is a defect.
      const run = <A, E>(effect: Effect.Effect<A, E, Db>) => effect.pipe(Effect.provideService(Db, db), Effect.orDie)

      // Runs an action in one transaction; its failures come back as values
      // so they do not roll back as defects.
      const inTransaction = <A, E>(action: Effect.Effect<A, E, never>) =>
        db.transaction(() => Effect.result(action)).pipe(
          Effect.orDie,
          Effect.flatMap((result) => (result._tag === "Success" ? Effect.succeed(result.success) : Effect.fail(result.failure)))
        )

      const sectionIds = new Set(taxonomy.sections.map((section) => section.id))
      const typeSection = new Map(
        taxonomy.sections.flatMap((section) => section.questionTypes.map((type) => [type.id, section.id] as const))
      )
      const skillIds = new Set(
        taxonomy.sections.flatMap((section) => section.topics.flatMap((topic) => topic.skills.map((skill) => skill.id)))
      )

      const filterProblems = (filters: FilterChoice): ReadonlyArray<string> => {
        const problems: Array<string> = []
        if (filters.section !== undefined && !sectionIds.has(filters.section)) {
          problems.push(`There is no Section ${filters.section}.`)
        }
        const typeIn = filters.questionType === undefined ? undefined : typeSection.get(filters.questionType)
        if (filters.questionType !== undefined && typeIn === undefined) {
          problems.push(`There is no Question Type ${filters.questionType}.`)
        } else if (filters.section !== undefined && typeIn !== undefined && typeIn !== filters.section) {
          problems.push(`${names.named(filters.questionType!).name} is not in ${names.named(filters.section).name}.`)
        }
        if (filters.skill !== undefined && !skillIds.has(filters.skill)) problems.push(`There is no Skill ${filters.skill}.`)
        return problems
      }

      const rangeProblems = (choice: BookChoice): ReadonlyArray<string> => {
        const problems: Array<string> = []
        if (choice.set === undefined && (choice.from !== undefined || choice.to !== undefined)) {
          problems.push("Choose a set to give item numbers, since each set numbers its own items.")
        }
        if (choice.from !== undefined && choice.to !== undefined && choice.from > choice.to) {
          problems.push(`Item ${choice.from} comes after item ${choice.to}.`)
        }
        return problems
      }

      const bookItems = (bookId: string) =>
        db.select({
          questionId: sources.questionId,
          set: sources.set,
          number: sources.number,
          page: sources.page,
          status: questions.status,
          reserve: questions.reserve,
          releasedAt: questions.releasedAt
        }).from(sources)
          .innerJoin(questions, eq(questions.id, sources.questionId))
          .where(eq(sources.bookId, bookId))
          .pipe(
            Effect.orDie,
            Effect.map((rows) =>
              rows.map((row): BookItem => ({
                questionId: row.questionId,
                set: row.set,
                number: row.number,
                page: row.page,
                status: row.status,
                reserve: row.reserve,
                released: row.releasedAt !== null
              }))
            )
          )

      const bookOf = (bookId: string) =>
        db.select({ id: books.id, title: books.title }).from(books).where(eq(books.id, bookId)).pipe(
          Effect.orDie,
          Effect.flatMap((rows) => (rows[0] === undefined ? Effect.fail(new BookNotFound()) : Effect.succeed(rows[0])))
        )

      // The Questions a choice gives the Profile, in the order they would be
      // served, and its title.
      const plan = (profileId: string, choice: PracticeChoice, salt: string) =>
        Effect.gen(function*() {
          const history = yield* run(historyOf(profileId))
          const held = yield* run(heldBySections(profileId))
          if (choice.kind === "filters") {
            const problems = filterProblems(choice)
            if (problems.length > 0) return yield* new FiltersInvalid({ problems })
            const pool = yield* run(publishedPool)
            const picked = pickByFilters(pool.filter((question) => !held.has(question.id)), history, choice, salt)
            // Under missed, counted whatever their status, which would say
            // how an answer went.
            const counted = choice.status === "missed" ? { ...choice, status: "any" as const } : choice
            const inSection = pool.filter((question) => held.has(question.id) && matchesFilters(question, counted, history))
              .length
            const words = [
              choice.questionType === undefined
                ? choice.section === undefined ? "Every Section" : names.named(choice.section).name
                : names.named(choice.questionType).name,
              ...(choice.skill === undefined ? [] : [names.named(choice.skill).name]),
              ...(choice.band === undefined ? [] : [bandNames[choice.band]]),
              ...(statusWords[choice.status] === undefined ? [] : [statusWords[choice.status]])
            ]
            return {
              plan: { ...picked, places: [], heldForMocks: [], unavailable: [], inSection, inSectionItems: [] } satisfies Plan,
              title: words.join(", "),
              bookId: null
            }
          }
          const problems = rangeProblems(choice)
          if (problems.length > 0) return yield* new FiltersInvalid({ problems })
          const book = yield* bookOf(choice.bookId)
          const order = bookOrder(yield* bookItems(book.id), history.seen, choice, held)
          const items = choice.set === undefined
            ? "every set"
            : choice.from === undefined && choice.to === undefined
            ? choice.set.trim()
            : `${choice.set.trim()} ${choice.from ?? 1} to ${choice.to ?? "the end"}`
          return {
            plan: {
              ...order,
              matching: order.questionIds.length,
              inSection: order.inSection.length,
              inSectionItems: order.inSection
            } satisfies Plan,
            title: `${book.title}, ${items}`,
            bookId: book.id
          }
        })

      const own = (profileId: string, id: string) =>
        db.select().from(sessions)
          .where(and(eq(sessions.id, id), eq(sessions.profileId, profileId), eq(sessions.kind, "practice")))
          .pipe(
            Effect.orDie,
            Effect.flatMap((rows) => (rows[0] === undefined ? Effect.fail(new PracticeNotFound()) : Effect.succeed(rows[0])))
          )

      const servedOf = (sessionId: string) =>
        db.select().from(servedQuestions).where(eq(servedQuestions.sessionId, sessionId))
          .orderBy(asc(servedQuestions.position)).pipe(Effect.orDie)

      const responsesOf = (sessionId: string) =>
        db.select().from(responses).where(eq(responses.sessionId, sessionId)).orderBy(asc(responses.seq)).pipe(
          Effect.orDie
        )

      // The Response that stands for a Question in the Session: its last.
      const finalFor = (answers: ReadonlyArray<ResponseRow>, questionId: string) =>
        answers.findLast((answer) => answer.questionId === questionId)

      // The clocks of timed sets now running, as last ticked.
      const clocks = new Map<string, ClockState>()
      // Open while a timed set may be running. It starts open, so the first
      // tick picks up sets left running when the app last stopped.
      const wake = yield* Latch.make(true)

      // In a timed set, a Question is served at a moment of its clock, and the
      // clock is saved then, so after a restart it never stands before a
      // Question that was served.
      const serve = (sessionId: string, position: number, questionId: string, servedElapsedMs: number | null) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          yield* db.insert(servedQuestions).values({ sessionId, position, questionId, servedAt: now, servedElapsedMs })
            .pipe(Effect.orDie)
          if (servedElapsedMs === null) return
          yield* db.update(sessions).set({ elapsedMs: servedElapsedMs, clockSavedAt: now }).where(eq(sessions.id, sessionId))
            .pipe(Effect.orDie)
          const state = clocks.get(sessionId)
          if (state !== undefined) clocks.set(sessionId, { ...state, savedAt: now })
        })

      // A running timed set's clock as it would tick now: its elapsed time,
      // and whether the time since its last tick was a gap, not counted.
      const peek = (session: SessionRow, now: number) => {
        if (session.timeLimitMs === null || session.status !== "active") {
          return { ticked: undefined, elapsedMs: session.elapsedMs }
        }
        const state = clocks.get(session.id) ?? fromSave(session.elapsedMs, session.clockSavedAt ?? now)
        const ticked = tick(state, now, session.timeLimitMs)
        return { ticked, elapsedMs: ticked.next.elapsedMs }
      }

      // Ticks a running timed set's clock now, as the clock's own ticks do,
      // so a request that comes before the next tick still marks a gap as
      // an interruption and sees the time run out.
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

      // The Question to serve at a position. A planned Question that left the
      // Question Bank since the set began gives way to the one it was merged
      // into, unless the set has that one already; otherwise it leaves the
      // set, as does one a running Sectional chose since. Undefined when no
      // planned Question is left.
      const servable = (session: SessionRow, position: number) =>
        Effect.gen(function*() {
          const config = decodeConfig(session.config)
          const planned = [...config.planned]
          const resolve = yield* run(mergeTargets)
          const held = yield* run(heldBySections(session.profileId))
          const statusOf = (questionId: string) =>
            db.select({ status: questions.status }).from(questions).where(eq(questions.id, questionId)).pipe(
              Effect.orDie,
              Effect.map((rows) => rows[0]?.status)
            )
          let changed = false
          while (position < planned.length) {
            const planId = planned[position]!
            if (held.has(resolve(planId))) {
              planned.splice(position, 1)
              changed = true
              continue
            }
            if ((yield* statusOf(planId)) === "published") break
            const target = resolve(planId)
            const replaced = target !== planId && !planned.includes(target) && (yield* statusOf(target)) === "published"
            if (replaced) planned[position] = target
            else planned.splice(position, 1)
            changed = true
          }
          if (changed) {
            yield* db.update(sessions).set({ config: encodeConfig({ ...config, planned }) })
              .where(eq(sessions.id, session.id)).pipe(Effect.orDie)
          }
          return planned[position]
        })

      const servedView = (
        session: SessionRow,
        config: PracticeConfig,
        row: typeof servedQuestions.$inferSelect,
        context: {
          readonly answers: ReadonlyArray<ResponseRow>
          readonly marked: ReadonlySet<string>
          readonly rated: ReadonlySet<string>
          readonly resolve: (id: string) => string
        }
      ) =>
        Effect.gen(function*() {
          // A Question since merged shows as served, judged by the one it
          // became, as the Error Log judges it.
          const target = context.resolve(row.questionId)
          const read = yield* run(storedQuestions([...new Set([row.questionId, target])]))
          const stored = read.get(row.questionId)
          if (stored === undefined) return yield* Effect.die(new Error(`Served Question ${row.questionId} is missing`))
          const judged = read.get(target) ?? stored
          const response = finalFor(context.answers, row.questionId)
          const selection = response === undefined ? [] : readSelection(response.selection)
          const keys = judged.parts.map((part) => ({ position: part.position, key: part.key }))
          // A timed set keeps its Debriefs, and whether answers were right,
          // for the end.
          const over = session.status === "finished"
          const shown = over || (!session.timed && response !== undefined)
          const place = config.places?.find((each) => each.questionId === row.questionId)
          const wrong = response !== undefined && (response.kind === "time-out" || !isCorrect(selection, keys))
          const mistakes = shown && wrong
            ? yield* run(sessionMistakes(session, row.questionId, {
              overrides: yield* settings.targetTimes,
              names,
              choices: mistakeChoices,
              resolve: context.resolve
            }))
            : null
          return new ServedView({
            position: row.position,
            question: practiceQuestion(stored, names, config.bookId, place),
            bookmarked: context.marked.has(context.resolve(row.questionId)),
            response: response === undefined || (session.timed && !over) ? null : new ResponseView({
              selection,
              guessed: response.guessed,
              timeSpentMs: response.timeSpentMs,
              correct: isCorrect(selection, keys),
              rated: context.rated.has(response.id),
              timedOut: response.kind === "time-out"
            }),
            debrief: shown ? debriefOf(judged, selection, names) : null,
            mistakes
          })
        })

      // A Bookmark is the Profile's, on the Question a merged one became.
      // Which Responses are Rated shows only once a timed set ends, and an
      // untimed set has none.
      const contextOf = (session: SessionRow) =>
        Effect.gen(function*() {
          const served = yield* servedOf(session.id)
          const answers = yield* responsesOf(session.id)
          const marked = yield* run(bookmarkedBy(session.profileId))
          const resolve = yield* run(mergeTargets)
          const ids = served.map((row) => row.questionId)
          const rated = session.timed && session.status === "finished"
            ? yield* run(ratedAmong(session.profileId, ids))
            : new Set<string>()
          return { served, answers, marked, rated, resolve }
        })

      const viewOf = (session: SessionRow, device: string | undefined) =>
        Effect.gen(function*() {
          const config = decodeConfig(session.config)
          const now = yield* Clock.currentTimeMillis
          const hidden = session.timed && session.status !== "finished"
          const context = yield* contextOf(session)
          const ids = context.served.map((row) => row.questionId)
          const keys = yield* run(keysOf(ids))
          const types = ids.length === 0
            ? []
            : yield* db.select({ id: questions.id, questionType: questions.questionType }).from(questions)
              .where(inArray(questions.id, ids)).pipe(Effect.orDie)
          const results = context.served.map((row) => {
            const response = finalFor(context.answers, row.questionId)
            const first = context.answers.find((answer) => answer.questionId === row.questionId)
            return new PracticeResult({
              position: row.position,
              questionId: QuestionId.make(row.questionId),
              questionType: names.named(types.find((type) => type.id === row.questionId)?.questionType ?? ""),
              correct: response === undefined || hidden
                ? null
                : isCorrect(readSelection(response.selection), keys.get(row.questionId) ?? []),
              guessed: response?.guessed ?? false,
              timedOut: response?.kind === "time-out",
              timeSpentMs: first?.timeSpentMs ?? null,
              bookmarked: context.marked.has(context.resolve(row.questionId))
            })
          })
          const last = context.served.at(-1)
          const { ticked, elapsedMs } = peek(session, now)
          return new PracticeView({
            id: SessionId.make(session.id),
            title: config.title,
            timed: session.timed,
            status: stateOf(session),
            total: config.planned.length,
            requested: config.requested,
            heldForMocks: config.heldForMocks.map((ref) => new ItemRef(ref)),
            unavailable: config.unavailable.map((ref) => new ItemRef(ref)),
            results,
            // A paused set hides its Question.
            current: session.status === "active" && last !== undefined
              ? yield* servedView(session, config, last, context)
              : null,
            nextSeq: (context.answers.at(-1)?.seq ?? 0) + 1,
            clock: session.timeLimitMs === null ? null : new PracticeClock({
              limitMs: session.timeLimitMs,
              elapsedMs,
              remainingMs: Math.max(0, session.timeLimitMs - elapsedMs),
              // A gap the next tick will mark.
              interrupted: session.interrupted || ticked?.lost === true
            }),
            heldHere: holdsIt(session, device),
            endedBy: session.endedBy === "time" ? "time" : session.endedBy === "finished" ? "finished" : null,
            createdAt: session.createdAt,
            finishedAt: session.finishedAt
          })
        })

      const outOfStep = (session: SessionRow, device: string | undefined, reason: PracticeOutOfStep["reason"]) =>
        viewOf(session, device).pipe(Effect.flatMap((view) => Effect.fail(new PracticeOutOfStep({ reason, view }))))

      // A set this device may change: its own, held here.
      const held = (caller: Caller, id: string) =>
        Effect.gen(function*() {
          const session = yield* own(caller.profileId, id)
          if (!holdsIt(session, caller.device)) {
            return yield* new HeldElsewhere({ view: yield* viewOf(session, caller.device) })
          }
          return session
        })

      // The time limit of a timed set: its Questions' Target Times added up.
      const limitFor = (planned: ReadonlyArray<string>) =>
        Effect.gen(function*() {
          const overrides = yield* settings.targetTimes
          const rows = yield* db.select({ id: questions.id, questionType: questions.questionType }).from(questions)
            .where(inArray(questions.id, [...planned])).pipe(Effect.orDie)
          const typeOf = new Map(rows.map((row) => [row.id, row.questionType] as const))
          return planned.reduce((sum, id) => sum + targetSecondsFor(typeOf.get(id) ?? "", overrides) * 1000, 0)
        })

      // Creates the Session, held by the caller's device, and serves its
      // first Question.
      const begin = (caller: Caller, config: PracticeConfig, id: string, timed: boolean) =>
        Effect.gen(function*() {
          const limitMs = timed ? yield* limitFor(config.planned) : null
          const created = yield* inTransaction(Effect.gen(function*() {
            const now = yield* Clock.currentTimeMillis
            yield* db.insert(sessions).values({
              id,
              profileId: caller.profileId,
              kind: "practice",
              timed,
              config: encodeConfig(config),
              status: "active",
              timeLimitMs: limitMs,
              elapsedMs: 0,
              clockSavedAt: timed ? now : null,
              holder: caller.device ?? null,
              createdAt: now
            }).pipe(Effect.orDie)
            yield* serve(id, 0, config.planned[0]!, timed ? 0 : null)
            return yield* own(caller.profileId, id).pipe(Effect.orDie)
          }))
          if (timed) yield* wake.open
          return yield* viewOf(created, caller.device)
        })

      const options = (profileId: string) =>
        Effect.gen(function*() {
          const pool = yield* run(publishedPool)
          const seen = yield* run(seenBy(profileId))
          const held = yield* run(heldBySections(profileId))
          const open = pool.filter((question) => openToPractice(question, seen) && !held.has(question.id))
          const allSkills = taxonomy.sections.flatMap((each) => each.topics.flatMap((topic) => topic.skills))
          const sections = taxonomy.sections.map((section) => {
            const mine = open.filter((question) => question.section === section.id)
            const skillCounts = new Map<string, number>()
            for (const question of mine) {
              for (const skill of new Set([question.primarySkill, ...question.secondarySkills])) {
                if (skill !== null) skillCounts.set(skill, (skillCounts.get(skill) ?? 0) + 1)
              }
            }
            return {
              id: section.id,
              name: section.name,
              questions: mine.length,
              questionTypes: section.questionTypes.map((type) => ({
                id: type.id,
                name: type.name,
                questions: mine.filter((question) => question.questionType === type.id).length
              })),
              skills: allSkills.filter((skill) => skillCounts.has(skill.id)).map((skill) => ({
                id: skill.id,
                name: skill.name,
                questions: skillCounts.get(skill.id)!
              }))
            }
          })
          // Each Book with Questions in the Question Bank, with every set's
          // full run of items and how many of them are published.
          const rows = yield* db.select({
            bookId: books.id,
            title: books.title,
            createdAt: books.createdAt,
            set: sources.set,
            number: sources.number,
            page: sources.page,
            status: questions.status
          }).from(sources)
            .innerJoin(books, eq(books.id, sources.bookId))
            .innerJoin(questions, eq(questions.id, sources.questionId))
            .orderBy(asc(books.createdAt), asc(sources.page), asc(sources.number))
            .pipe(Effect.orDie)
          const withPublished = new Set(rows.filter((row) => row.status === "published").map((row) => row.bookId))
          const byBook = new Map<
            string,
            { id: string; title: string; sets: Map<string, { name: string; numbers: Array<number>; published: number }> }
          >()
          for (const row of rows) {
            if (!withPublished.has(row.bookId)) continue
            const book = byBook.get(row.bookId) ?? { id: row.bookId, title: row.title, sets: new Map() }
            const set = book.sets.get(setKey(row.set)) ?? { name: row.set, numbers: [], published: 0 }
            set.numbers.push(row.number)
            if (row.status === "published") set.published += 1
            book.sets.set(setKey(row.set), set)
            byBook.set(row.bookId, book)
          }
          return new PracticeOptions({
            sections,
            books: [...byBook.values()].map((book) => ({
              id: BookId.make(book.id),
              title: book.title,
              sets: [...book.sets.values()].filter((set) => set.published > 0).map((set) => ({
                name: set.name,
                first: Math.min(...set.numbers),
                last: Math.max(...set.numbers),
                questions: set.published
              }))
            }))
          })
        })

      // The order a set chosen by filters takes its Questions in: the same for
      // a preview and the set started after it, so the preview's time limit
      // is the set's, and new for each set the Profile starts.
      const saltFor = (profileId: string) =>
        db.select({ count: sql<number>`count(*)` }).from(sessions)
          .where(and(eq(sessions.profileId, profileId), eq(sessions.kind, "practice")))
          .pipe(Effect.orDie, Effect.map((rows) => `${profileId}|${rows[0]?.count ?? 0}`))

      const preview = (profileId: string, choice: PracticeChoice) =>
        Effect.gen(function*() {
          const planned = (yield* plan(profileId, choice, yield* saltFor(profileId))).plan
          return new PracticePreview({
            questions: planned.questionIds.length,
            matching: planned.matching,
            heldForMocks: planned.heldForMocks.length,
            unavailable: planned.unavailable.length,
            inSection: planned.inSection,
            limitMs: choice.timed === true ? yield* limitFor(planned.questionIds) : null
          })
        })

      const start = (caller: Caller, choice: PracticeChoice) =>
        Effect.gen(function*() {
          const id = crypto.randomUUID()
          const chosen = yield* plan(caller.profileId, choice, yield* saltFor(caller.profileId))
          if (chosen.plan.questionIds.length === 0) {
            return yield* new NoQuestionsMatch({
              heldForMocks: chosen.plan.heldForMocks.length,
              unavailable: chosen.plan.unavailable.length,
              inSection: chosen.plan.inSection
            })
          }
          return yield* begin(caller, {
            title: choice.timed === true ? `${chosen.title}, timed` : chosen.title,
            choice,
            similarTo: null,
            requested: null,
            bookId: chosen.bookId,
            planned: chosen.plan.questionIds,
            places: chosen.plan.places,
            heldForMocks: chosen.plan.heldForMocks,
            unavailable: [...chosen.plan.unavailable, ...chosen.plan.inSectionItems]
          }, id, choice.timed === true)
        }).pipe(oneAtATime)

      const list = (profileId: string) =>
        Effect.gen(function*() {
          const rows = yield* db.select().from(sessions)
            .where(and(eq(sessions.profileId, profileId), eq(sessions.kind, "practice")))
            .orderBy(sql`${sessions.status} = 'finished'`, desc(sessions.createdAt), desc(sql`${sessions}.rowid`))
            .pipe(Effect.orDie)
          const ids = rows.map((row) => row.id)
          const answers = ids.length === 0
            ? []
            : yield* db.select().from(responses).where(inArray(responses.sessionId, ids)).orderBy(asc(responses.seq))
              .pipe(Effect.orDie)
          const keys = yield* run(keysOf(answers.map((answer) => answer.questionId)))
          return rows.map((row) => {
            const mine = answers.filter((answer) => answer.sessionId === row.id)
            const finals = [...new Set(mine.map((answer) => answer.questionId))].map((questionId) => finalFor(mine, questionId)!)
            return new PracticeSummary({
              id: SessionId.make(row.id),
              title: decodeConfig(row.config).title,
              timed: row.timed,
              status: stateOf(row),
              total: decodeConfig(row.config).planned.length,
              answered: finals.length,
              // A timed set keeps its results for the end.
              correct: row.timed && row.status !== "finished"
                ? 0
                : finals.filter((answer) => isCorrect(readSelection(answer.selection), keys.get(answer.questionId) ?? []))
                  .length,
              endedBy: row.endedBy === "time" ? "time" : row.endedBy === "finished" ? "finished" : null,
              createdAt: row.createdAt,
              finishedAt: row.finishedAt
            })
          })
        })

      const get = (caller: Caller, id: SessionId) =>
        own(caller.profileId, id).pipe(Effect.flatMap((session) => viewOf(session, caller.device)))

      // Reads a set again after a change, for the caller.
      const after = (caller: Caller, id: string) =>
        own(caller.profileId, id).pipe(Effect.orDie, Effect.flatMap((session) => viewOf(session, caller.device)))

      // Ends a set: the Learner finished it, or its time ran out. A timed
      // set's clock is saved where it stopped, and its Rated Responses count.
      const end = (session: SessionRow, endedBy: "finished" | "time", elapsedMs: number) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          clocks.delete(session.id)
          yield* db.update(sessions).set({
            status: "finished",
            endedBy,
            finishedAt: now,
            ...(session.timed ? { elapsedMs, clockSavedAt: now } : {})
          }).where(eq(sessions.id, session.id)).pipe(Effect.orDie)
          if (session.timed) yield* run(rateSession(session))
        })

      // When time runs out, the Question on screen gets a time-out Response:
      // wrong, and never Rated. Runs inside the caller's transaction.
      const expire = (session: SessionRow) =>
        Effect.gen(function*() {
          const limitMs = session.timeLimitMs ?? 0
          const served = yield* servedOf(session.id)
          const answers = yield* responsesOf(session.id)
          const current = served.at(-1)
          if (current !== undefined && !answers.some((each) => each.questionId === current.questionId)) {
            yield* db.insert(responses).values({
              id: crypto.randomUUID(),
              profileId: session.profileId,
              sessionId: session.id,
              questionId: current.questionId,
              seq: Math.max(0, ...answers.map((each) => each.seq)) + 1,
              selection: encodeSelection([]),
              timeSpentMs: Math.max(0, limitMs - (current.servedElapsedMs ?? 0)),
              guessed: false,
              kind: "time-out",
              supersedes: null,
              createdAt: yield* Clock.currentTimeMillis
            }).pipe(Effect.orDie)
          }
          yield* end(session, "time", limitMs)
        })

      // A request that finds the time run out ends the set by time, and says
      // the set had ended.
      const expireFor = (caller: Caller, session: SessionRow) =>
        Effect.gen(function*() {
          yield* expire(session)
          return yield* outOfStep(yield* own(caller.profileId, session.id).pipe(Effect.orDie), caller.device, "finished")
        })

      const answer = (caller: Caller, id: SessionId, submit: Submit) =>
        inTransaction(Effect.gen(function*() {
          const session = yield* held(caller, id)
          // The same submit sent again: recorded the first time. Another
          // submit with that number comes from a screen out of date.
          const [repeat] = yield* db.select().from(responses)
            .where(and(eq(responses.sessionId, id), eq(responses.seq, submit.seq))).pipe(Effect.orDie)
          if (repeat !== undefined) {
            const same = repeat.questionId === submit.questionId &&
              repeat.selection === encodeSelection(submit.selection.toSorted((a, b) => a.part - b.part)) &&
              repeat.guessed === submit.guessed
            if (same) return
            return yield* outOfStep(session, caller.device, session.status === "finished" ? "finished" : "not-current")
          }
          if (session.status === "paused") return yield* outOfStep(session, caller.device, "paused")
          if (session.status !== "active") return yield* outOfStep(session, caller.device, "finished")
          const now = yield* Clock.currentTimeMillis
          // Time ran out before the clock's next tick: the answer is too late.
          const { elapsedMs, expired } = yield* advance(session, now)
          if (expired) return yield* expireFor(caller, session)
          const served = yield* servedOf(id)
          const current = served.at(-1)
          if (current === undefined || current.questionId !== submit.questionId) {
            return yield* outOfStep(session, caller.device, "not-current")
          }
          const [given] = yield* db.select({ id: responses.id }).from(responses)
            .where(and(eq(responses.sessionId, id), eq(responses.questionId, current.questionId))).pipe(Effect.orDie)
          if (given !== undefined) return yield* outOfStep(session, caller.device, "answered")
          const stored = (yield* run(storedQuestions([current.questionId]))).get(current.questionId)!
          const problems = selectionProblems(stored, submit.selection)
          if (problems.length > 0) return yield* new SelectionInvalid({ problems })
          yield* db.insert(responses).values({
            id: crypto.randomUUID(),
            profileId: caller.profileId,
            sessionId: id,
            questionId: current.questionId,
            seq: submit.seq,
            selection: encodeSelection(submit.selection.toSorted((a, b) => a.part - b.part)),
            timeSpentMs: session.timed
              ? Math.max(0, elapsedMs - (current.servedElapsedMs ?? 0))
              : Math.max(0, now - current.servedAt),
            guessed: submit.guessed,
            kind: "first",
            supersedes: null,
            createdAt: now
          }).pipe(Effect.orDie)
          if (!session.timed) return
          // The next Question at once, or the end of the set.
          const nextId = yield* servable(session, current.position + 1)
          if (nextId !== undefined) yield* serve(id, current.position + 1, nextId, elapsedMs)
          else yield* end(session, "finished", elapsedMs)
        })).pipe(Effect.flatMap(() => after(caller, id)), oneAtATime)

      const next = (caller: Caller, id: SessionId, position: number) =>
        inTransaction(Effect.gen(function*() {
          const session = yield* held(caller, id)
          const served = yield* servedOf(id)
          // Served already, as when the request is sent again.
          if (position < served.length) return
          if (session.status === "paused") return yield* outOfStep(session, caller.device, "paused")
          if (session.status !== "active") return yield* outOfStep(session, caller.device, "finished")
          if (position > served.length) return yield* outOfStep(session, caller.device, "not-current")
          const current = served.at(-1)!
          const answered = (yield* responsesOf(id)).some((each) => each.questionId === current.questionId)
          if (!answered) return yield* outOfStep(session, caller.device, "not-answered")
          const planned = decodeConfig(session.config).planned
          if (position >= planned.length) return yield* outOfStep(session, caller.device, "no-more")
          const { elapsedMs, expired } = yield* advance(session, yield* Clock.currentTimeMillis)
          if (expired) return yield* expireFor(caller, session)
          const questionId = yield* servable(session, position)
          // What was left of the plan has left the Question Bank: the set is over.
          if (questionId === undefined) yield* end(session, "finished", elapsedMs)
          else yield* serve(id, position, questionId, session.timed ? elapsedMs : null)
        })).pipe(Effect.flatMap(() => after(caller, id)), oneAtATime)

      // A Bookmark is the Profile's: clearing it in any set clears it.
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

      // A set whose time ran out before the clock's next tick ends by time.
      const finish = (caller: Caller, id: SessionId) =>
        inTransaction(Effect.gen(function*() {
          const session = yield* held(caller, id)
          if (session.status === "finished") return
          const { elapsedMs, expired } = yield* advance(session, yield* Clock.currentTimeMillis)
          if (expired || (session.timeLimitMs !== null && elapsedMs >= session.timeLimitMs)) yield* expire(session)
          else yield* end(session, "finished", elapsedMs)
        })).pipe(Effect.flatMap(() => after(caller, id)), oneAtATime)

      // A timed set's clock stops while it is paused; an untimed set has none
      // to stop.
      const pause = (caller: Caller, id: SessionId) =>
        inTransaction(Effect.gen(function*() {
          const session = yield* held(caller, id)
          if (session.status === "paused") return
          if (session.status === "finished") return yield* outOfStep(session, caller.device, "finished")
          if (!session.timed) return yield* outOfStep(session, caller.device, "untimed")
          const now = yield* Clock.currentTimeMillis
          const { elapsedMs, expired } = yield* advance(session, now)
          if (expired) return yield* expireFor(caller, session)
          clocks.delete(session.id)
          yield* db.update(sessions).set({ status: "paused", elapsedMs, clockSavedAt: now }).where(eq(sessions.id, id))
            .pipe(Effect.orDie)
        })).pipe(Effect.flatMap(() => after(caller, id)), oneAtATime)

      // The clock goes on from where it stopped: the pause is not a gap.
      const resume = (caller: Caller, id: SessionId) =>
        inTransaction(Effect.gen(function*() {
          const session = yield* held(caller, id)
          if (session.status === "active") return
          if (session.status === "finished") return yield* outOfStep(session, caller.device, "finished")
          if (session.timeLimitMs !== null && session.elapsedMs >= session.timeLimitMs) return yield* expireFor(caller, session)
          const now = yield* Clock.currentTimeMillis
          clocks.delete(session.id)
          yield* db.update(sessions).set({ status: "active", clockSavedAt: now }).where(eq(sessions.id, id))
            .pipe(Effect.orDie)
        })).pipe(Effect.tap(() => wake.open), Effect.flatMap(() => after(caller, id)), oneAtATime)

      // This device takes the set over.
      const claim = (caller: Caller, id: SessionId) =>
        Effect.gen(function*() {
          const session = yield* own(caller.profileId, id)
          if (caller.device !== undefined && session.holder !== caller.device) {
            yield* db.update(sessions).set({ holder: caller.device }).where(eq(sessions.id, id)).pipe(Effect.orDie)
          }
          return yield* after(caller, id)
        }).pipe(oneAtATime)

      // A paused set hides its Questions until it resumes.
      const review = (caller: Caller, id: SessionId, position: number) =>
        Effect.gen(function*() {
          const session = yield* own(caller.profileId, id)
          if (session.status === "paused") return yield* outOfStep(session, caller.device, "paused")
          const context = yield* contextOf(session)
          const row = context.served.find((each) => each.position === position)
          if (row === undefined) return yield* outOfStep(session, caller.device, "not-current")
          return yield* servedView(session, decodeConfig(session.config), row, context)
        })

      // The Profile's Section Score Estimates as they stand now, from the
      // Rated Responses of the sets that have ended, on each Section's line.
      const scores = (profileId: string) =>
        run(scoreEstimatesOf(profileId)).pipe(
          Effect.map((estimates) => estimates.sections.map(scoreEstimateView((id) => names.named(id))))
        )

      const similar = (caller: Caller, questionId: QuestionId) =>
        Effect.gen(function*() {
          const [target] = yield* db.select({
            id: questions.id,
            questionType: questions.questionType,
            primarySkill: questions.primarySkill
          }).from(questions).where(eq(questions.id, questionId)).pipe(Effect.orDie)
          // A running Sectional's Question says nothing to Practice until the
          // Section closes.
          const held = yield* run(heldBySections(caller.profileId))
          if (target === undefined || held.has(target.id)) return yield* new QuestionNotFound()
          const level = (yield* run(difficultyOf(questionId))) ?? 0
          const pool = (yield* run(publishedPool)).filter((question) => !held.has(question.id))
          const seen = yield* run(seenBy(caller.profileId))
          const id = crypto.randomUUID()
          const picked = pickSimilar(pool, seen, { ...target, difficulty: level }, SimilarCount, id)
          if (picked.length === 0) return yield* new NoQuestionsMatch({ heldForMocks: 0, unavailable: 0, inSection: 0 })
          const about = target.primarySkill === null ? [] : [names.named(target.primarySkill).name]
          return yield* begin(caller, {
            title: `Similar: ${[...about, names.named(target.questionType).name].join(", ")}`,
            choice: null,
            similarTo: target.id,
            requested: SimilarCount,
            bookId: null,
            planned: picked,
            heldForMocks: [],
            unavailable: []
          }, id, false)
        }).pipe(oneAtATime)

      // One tick of every running timed set's clock. With none running, the
      // clock stops until a timed set starts or resumes. Sectionals keep their
      // own clock.
      const tickAll = Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        const running = yield* db.select().from(sessions)
          .where(and(eq(sessions.kind, "practice"), eq(sessions.timed, true), eq(sessions.status, "active")))
          .pipe(Effect.orDie)
        if (running.length === 0) yield* wake.close
        const ids = new Set(running.map((session) => session.id))
        for (const id of [...clocks.keys()]) if (!ids.has(id)) clocks.delete(id)
        for (const session of running) {
          const { expired } = yield* advance(session, now)
          if (expired) yield* inTransaction(expire(session))
        }
      }).pipe(
        oneAtATime,
        Effect.catchCause((cause) => Effect.logError(`The Session clock could not tick: ${Cause.pretty(cause)}`))
      )

      yield* Effect.forkScoped(
        Effect.forever(wake.await.pipe(Effect.andThen(Effect.sleep(TickMs)), Effect.andThen(tickAll)))
      )

      const startRetries = (caller: Caller, items: ReadonlyArray<RetryItem>, timed: boolean) =>
        begin(caller, {
          title: timed ? "Retries, timed" : "Retries",
          choice: null,
          similarTo: null,
          requested: null,
          bookId: null,
          planned: items.map((item) => item.questionId),
          heldForMocks: [],
          unavailable: [],
          retry: [...items]
        }, crypto.randomUUID(), timed).pipe(oneAtATime)

      return Practice.of({
        startRetries,
        options,
        preview,
        start,
        list,
        get,
        answer,
        next,
        bookmark,
        finish,
        pause,
        resume,
        claim,
        review,
        similar,
        scores
      })
    })
  )
}
