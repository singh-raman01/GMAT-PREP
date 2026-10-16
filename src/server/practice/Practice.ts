import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema, Semaphore } from "effect"
import { setKey } from "../../api/bookMapRules.ts"
import { BookId, BookNotFound } from "../../api/Books.ts"
import { bandNames } from "../../api/difficulty.ts"
import {
  type BookChoice,
  FiltersInvalid,
  type FilterChoice,
  ItemRef,
  NoQuestionsMatch,
  PracticeChoice,
  PracticeNotFound,
  PracticeOptions,
  PracticeOutOfStep,
  PracticePreview,
  PracticeResult,
  PracticeSummary,
  PracticeView,
  QuestionNotFound,
  ResponseView,
  type Selection,
  SelectionInvalid,
  ServedView,
  SessionId,
  SimilarCount,
  SkipReason
} from "../../api/Practice.ts"
import { QuestionId } from "../../api/Review.ts"
import { Db } from "../db/Database.ts"
import { bookmarks, books, questions, responses, servedQuestions, sessions, sources } from "../db/schema.ts"
import { ratedAmong } from "../ratings/rated.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { debriefOf, namesOf, practiceQuestion, type StoredQuestion, storedQuestions } from "./content.ts"
import {
  bookmarkedBy,
  difficultyOf,
  encodeSelection,
  historyOf,
  isCorrect,
  keysOf,
  mergeTargets,
  publishedPool,
  readSelection,
  seenBy
} from "./history.ts"
import { bookOrder, type BookItem, openToPractice, pickByFilters, pickSimilar, type SkippedItem } from "./selection.ts"

// Untimed Practice Sets. A set's Questions are chosen when it starts and
// served one at a time; serving a Question makes it Seen. Responses are
// facts: recorded once per sequence number and never edited (ADR 0005).
// Untimed Responses are never Rated, so nothing here moves Difficulty.

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
  unavailable: Schema.Array(Ref)
})
type PracticeConfig = typeof PracticeConfig.Type
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(PracticeConfig))
const decodeConfig = Schema.decodeUnknownSync(Schema.fromJsonString(PracticeConfig))

type SessionRow = typeof sessions.$inferSelect
type ResponseRow = typeof responses.$inferSelect

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

export class Practice extends Context.Service<Practice, {
  options(profileId: string): Effect.Effect<PracticeOptions>
  preview(profileId: string, choice: PracticeChoice): Effect.Effect<PracticePreview, FiltersInvalid | BookNotFound>
  start(
    profileId: string,
    choice: PracticeChoice
  ): Effect.Effect<PracticeView, FiltersInvalid | BookNotFound | NoQuestionsMatch>
  list(profileId: string): Effect.Effect<ReadonlyArray<PracticeSummary>>
  get(profileId: string, id: SessionId): Effect.Effect<PracticeView, PracticeNotFound>
  answer(
    profileId: string,
    id: SessionId,
    submit: Submit
  ): Effect.Effect<PracticeView, PracticeNotFound | PracticeOutOfStep | SelectionInvalid>
  next(profileId: string, id: SessionId, position: number): Effect.Effect<PracticeView, PracticeNotFound | PracticeOutOfStep>
  bookmark(
    profileId: string,
    id: SessionId,
    questionId: QuestionId,
    bookmarked: boolean
  ): Effect.Effect<PracticeView, PracticeNotFound | PracticeOutOfStep>
  finish(profileId: string, id: SessionId): Effect.Effect<PracticeView, PracticeNotFound>
  review(profileId: string, id: SessionId, position: number): Effect.Effect<ServedView, PracticeNotFound | PracticeOutOfStep>
  similar(profileId: string, questionId: QuestionId): Effect.Effect<PracticeView, QuestionNotFound | NoQuestionsMatch>
}>()("gmat-prep/server/Practice") {
  static readonly layer = Layer.effect(
    Practice,
    Effect.gen(function*() {
      const db = yield* Db
      const taxonomy = (yield* Taxonomy).view
      const names = namesOf(taxonomy)
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
          if (choice.kind === "filters") {
            const problems = filterProblems(choice)
            if (problems.length > 0) return yield* new FiltersInvalid({ problems })
            const pool = yield* run(publishedPool)
            const picked = pickByFilters(pool, history, choice, salt)
            const words = [
              choice.questionType === undefined
                ? choice.section === undefined ? "Every Section" : names.named(choice.section).name
                : names.named(choice.questionType).name,
              ...(choice.skill === undefined ? [] : [names.named(choice.skill).name]),
              ...(choice.band === undefined ? [] : [bandNames[choice.band]]),
              ...(statusWords[choice.status] === undefined ? [] : [statusWords[choice.status]])
            ]
            return {
              plan: { ...picked, places: [], heldForMocks: [], unavailable: [] } satisfies Plan,
              title: words.join(", "),
              bookId: null
            }
          }
          const problems = rangeProblems(choice)
          if (problems.length > 0) return yield* new FiltersInvalid({ problems })
          const book = yield* bookOf(choice.bookId)
          const order = bookOrder(yield* bookItems(book.id), history.seen, choice)
          const items = choice.set === undefined
            ? "every set"
            : choice.from === undefined && choice.to === undefined
            ? choice.set.trim()
            : `${choice.set.trim()} ${choice.from ?? 1} to ${choice.to ?? "the end"}`
          return {
            plan: { ...order, matching: order.questionIds.length } satisfies Plan,
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

      const serve = (sessionId: string, position: number, questionId: string) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          yield* db.insert(servedQuestions).values({ sessionId, position, questionId, servedAt: now }).pipe(Effect.orDie)
        })

      // The Question to serve at a position. A planned Question that left the
      // Question Bank since the set began gives way to the one it was merged
      // into, unless the set has that one already; otherwise it leaves the
      // set. Undefined when no planned Question is left.
      const servable = (session: SessionRow, position: number) =>
        Effect.gen(function*() {
          const config = decodeConfig(session.config)
          const planned = [...config.planned]
          const resolve = yield* run(mergeTargets)
          const statusOf = (questionId: string) =>
            db.select({ status: questions.status }).from(questions).where(eq(questions.id, questionId)).pipe(
              Effect.orDie,
              Effect.map((rows) => rows[0]?.status)
            )
          let changed = false
          while (position < planned.length) {
            const planId = planned[position]!
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
          const stored = (yield* run(storedQuestions([row.questionId]))).get(row.questionId)
          if (stored === undefined) return yield* Effect.die(new Error(`Served Question ${row.questionId} is missing`))
          const response = finalFor(context.answers, row.questionId)
          const selection = response === undefined ? [] : readSelection(response.selection)
          const keys = stored.parts.map((part) => ({ position: part.position, key: part.key }))
          const place = config.places?.find((each) => each.questionId === row.questionId)
          return new ServedView({
            position: row.position,
            question: practiceQuestion(stored, names, config.bookId, place),
            bookmarked: context.marked.has(context.resolve(row.questionId)),
            response: response === undefined ? null : new ResponseView({
              selection,
              guessed: response.guessed,
              timeSpentMs: response.timeSpentMs,
              correct: isCorrect(selection, keys),
              rated: context.rated.has(response.id)
            }),
            debrief: response !== undefined || session.status === "finished" ? debriefOf(stored, selection, names) : null
          })
        })

      // A Bookmark is the Profile's, on the Question a merged one became.
      const contextOf = (session: SessionRow) =>
        Effect.gen(function*() {
          const served = yield* servedOf(session.id)
          const answers = yield* responsesOf(session.id)
          const marked = yield* run(bookmarkedBy(session.profileId))
          const resolve = yield* run(mergeTargets)
          const ids = served.map((row) => row.questionId)
          const rated = yield* run(ratedAmong(session.profileId, ids))
          return { served, answers, marked, rated, resolve }
        })

      const viewOf = (session: SessionRow) =>
        Effect.gen(function*() {
          const config = decodeConfig(session.config)
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
              correct: response === undefined
                ? null
                : isCorrect(readSelection(response.selection), keys.get(row.questionId) ?? []),
              guessed: response?.guessed ?? false,
              timeSpentMs: first?.timeSpentMs ?? null,
              bookmarked: context.marked.has(context.resolve(row.questionId))
            })
          })
          const last = context.served.at(-1)
          return new PracticeView({
            id: SessionId.make(session.id),
            title: config.title,
            timed: session.timed,
            status: session.status === "finished" ? "finished" : "active",
            total: config.planned.length,
            requested: config.requested,
            heldForMocks: config.heldForMocks.map((ref) => new ItemRef(ref)),
            unavailable: config.unavailable.map((ref) => new ItemRef(ref)),
            results,
            current: session.status === "active" && last !== undefined
              ? yield* servedView(session, config, last, context)
              : null,
            nextSeq: (context.answers.at(-1)?.seq ?? 0) + 1,
            createdAt: session.createdAt,
            finishedAt: session.finishedAt
          })
        })

      const outOfStep = (session: SessionRow, reason: PracticeOutOfStep["reason"]) =>
        viewOf(session).pipe(Effect.flatMap((view) => Effect.fail(new PracticeOutOfStep({ reason, view }))))

      // Creates the Session and serves its first Question.
      const begin = (profileId: string, config: PracticeConfig, id: string) =>
        inTransaction(Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          yield* db.insert(sessions).values({
            id,
            profileId,
            kind: "practice",
            timed: false,
            config: encodeConfig(config),
            status: "active",
            createdAt: now
          }).pipe(Effect.orDie)
          yield* serve(id, 0, config.planned[0]!)
          return yield* own(profileId, id).pipe(Effect.orDie)
        })).pipe(Effect.flatMap(viewOf))

      const options = (profileId: string) =>
        Effect.gen(function*() {
          const pool = yield* run(publishedPool)
          const seen = yield* run(seenBy(profileId))
          const open = pool.filter((question) => openToPractice(question, seen))
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

      const preview = (profileId: string, choice: PracticeChoice) =>
        plan(profileId, choice, "").pipe(Effect.map(({ plan: planned }) =>
          new PracticePreview({
            questions: planned.questionIds.length,
            matching: planned.matching,
            heldForMocks: planned.heldForMocks.length,
            unavailable: planned.unavailable.length
          })
        ))

      const start = (profileId: string, choice: PracticeChoice) =>
        Effect.gen(function*() {
          const id = crypto.randomUUID()
          const chosen = yield* plan(profileId, choice, id)
          if (chosen.plan.questionIds.length === 0) {
            return yield* new NoQuestionsMatch({
              heldForMocks: chosen.plan.heldForMocks.length,
              unavailable: chosen.plan.unavailable.length
            })
          }
          return yield* begin(profileId, {
            title: chosen.title,
            choice,
            similarTo: null,
            requested: null,
            bookId: chosen.bookId,
            planned: chosen.plan.questionIds,
            places: chosen.plan.places,
            heldForMocks: chosen.plan.heldForMocks,
            unavailable: chosen.plan.unavailable
          }, id)
        }).pipe(oneAtATime)

      const list = (profileId: string) =>
        Effect.gen(function*() {
          const rows = yield* db.select().from(sessions)
            .where(and(eq(sessions.profileId, profileId), eq(sessions.kind, "practice")))
            .orderBy(sql`${sessions.status} = 'active' desc`, desc(sessions.createdAt), desc(sql`${sessions}.rowid`))
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
              status: row.status === "finished" ? "finished" : "active",
              total: decodeConfig(row.config).planned.length,
              answered: finals.length,
              correct: finals.filter((answer) =>
                isCorrect(readSelection(answer.selection), keys.get(answer.questionId) ?? [])
              ).length,
              createdAt: row.createdAt,
              finishedAt: row.finishedAt
            })
          })
        })

      const get = (profileId: string, id: SessionId) => own(profileId, id).pipe(Effect.flatMap(viewOf))

      const answer = (profileId: string, id: SessionId, submit: Submit) =>
        inTransaction(Effect.gen(function*() {
          const session = yield* own(profileId, id)
          // The same submit sent again: recorded the first time. Another
          // submit with that number comes from a screen out of date.
          const [repeat] = yield* db.select().from(responses)
            .where(and(eq(responses.sessionId, id), eq(responses.seq, submit.seq))).pipe(Effect.orDie)
          if (repeat !== undefined) {
            const same = repeat.questionId === submit.questionId &&
              repeat.selection === encodeSelection(submit.selection.toSorted((a, b) => a.part - b.part)) &&
              repeat.guessed === submit.guessed
            return same ? session : yield* outOfStep(session, "not-current")
          }
          if (session.status !== "active") return yield* outOfStep(session, "finished")
          const served = yield* servedOf(id)
          const current = served.at(-1)
          if (current === undefined || current.questionId !== submit.questionId) {
            return yield* outOfStep(session, "not-current")
          }
          const [given] = yield* db.select({ id: responses.id }).from(responses)
            .where(and(eq(responses.sessionId, id), eq(responses.questionId, current.questionId))).pipe(Effect.orDie)
          if (given !== undefined) return yield* outOfStep(session, "answered")
          const stored = (yield* run(storedQuestions([current.questionId]))).get(current.questionId)!
          const problems = selectionProblems(stored, submit.selection)
          if (problems.length > 0) return yield* new SelectionInvalid({ problems })
          const now = yield* Clock.currentTimeMillis
          yield* db.insert(responses).values({
            id: crypto.randomUUID(),
            profileId,
            sessionId: id,
            questionId: current.questionId,
            seq: submit.seq,
            selection: encodeSelection(submit.selection.toSorted((a, b) => a.part - b.part)),
            timeSpentMs: Math.max(0, now - current.servedAt),
            guessed: submit.guessed,
            kind: "first",
            supersedes: null,
            createdAt: now
          }).pipe(Effect.orDie)
          return session
        })).pipe(Effect.flatMap(viewOf), oneAtATime)

      const next = (profileId: string, id: SessionId, position: number) =>
        inTransaction(Effect.gen(function*() {
          const session = yield* own(profileId, id)
          const served = yield* servedOf(id)
          // Served already, as when the request is sent again.
          if (position < served.length) return session
          if (session.status !== "active") return yield* outOfStep(session, "finished")
          if (position > served.length) return yield* outOfStep(session, "not-current")
          const current = served.at(-1)!
          const answered = (yield* responsesOf(id)).some((each) => each.questionId === current.questionId)
          if (!answered) return yield* outOfStep(session, "not-answered")
          if (position >= decodeConfig(session.config).planned.length) return yield* outOfStep(session, "no-more")
          const questionId = yield* servable(session, position)
          // What was left of the plan has left the Question Bank: the set is over.
          if (questionId === undefined) {
            const now = yield* Clock.currentTimeMillis
            yield* db.update(sessions).set({ status: "finished", finishedAt: now }).where(eq(sessions.id, id))
              .pipe(Effect.orDie)
          } else {
            yield* serve(id, position, questionId)
          }
          return yield* own(profileId, id).pipe(Effect.orDie)
        })).pipe(Effect.flatMap(viewOf), oneAtATime)

      // A Bookmark is the Profile's: clearing it in any set clears it.
      const bookmark = (profileId: string, id: SessionId, questionId: QuestionId, bookmarked: boolean) =>
        inTransaction(Effect.gen(function*() {
          const session = yield* own(profileId, id)
          const served = yield* servedOf(id)
          if (!served.some((row) => row.questionId === questionId)) return yield* outOfStep(session, "not-current")
          const now = yield* Clock.currentTimeMillis
          const target = (yield* run(mergeTargets))(questionId)
          if (bookmarked) {
            yield* db.insert(bookmarks).values({ profileId, questionId: target, sessionId: id, createdAt: now })
              .onConflictDoNothing().pipe(Effect.orDie)
          } else {
            yield* db.delete(bookmarks).where(and(eq(bookmarks.profileId, profileId), eq(bookmarks.questionId, target)))
              .pipe(Effect.orDie)
          }
          return session
        })).pipe(Effect.flatMap(viewOf), oneAtATime)

      const finish = (profileId: string, id: SessionId) =>
        Effect.gen(function*() {
          const session = yield* own(profileId, id)
          if (session.status === "finished") return yield* viewOf(session)
          const now = yield* Clock.currentTimeMillis
          const [finished] = yield* db.update(sessions).set({ status: "finished", finishedAt: now })
            .where(eq(sessions.id, id)).returning().pipe(Effect.orDie)
          return yield* viewOf(finished!)
        }).pipe(oneAtATime)

      const review = (profileId: string, id: SessionId, position: number) =>
        Effect.gen(function*() {
          const session = yield* own(profileId, id)
          const context = yield* contextOf(session)
          const row = context.served.find((each) => each.position === position)
          if (row === undefined) return yield* outOfStep(session, "not-current")
          return yield* servedView(session, decodeConfig(session.config), row, context)
        })

      const similar = (profileId: string, questionId: QuestionId) =>
        Effect.gen(function*() {
          const [target] = yield* db.select({
            id: questions.id,
            questionType: questions.questionType,
            primarySkill: questions.primarySkill
          }).from(questions).where(eq(questions.id, questionId)).pipe(Effect.orDie)
          if (target === undefined) return yield* new QuestionNotFound()
          const level = (yield* run(difficultyOf(questionId))) ?? 0
          const pool = yield* run(publishedPool)
          const seen = yield* run(seenBy(profileId))
          const id = crypto.randomUUID()
          const picked = pickSimilar(pool, seen, { ...target, difficulty: level }, SimilarCount, id)
          if (picked.length === 0) return yield* new NoQuestionsMatch({ heldForMocks: 0, unavailable: 0 })
          const about = target.primarySkill === null ? [] : [names.named(target.primarySkill).name]
          return yield* begin(profileId, {
            title: `Similar: ${[...about, names.named(target.questionType).name].join(", ")}`,
            choice: null,
            similarTo: target.id,
            requested: SimilarCount,
            bookId: null,
            planned: picked,
            heldForMocks: [],
            unavailable: []
          }, id)
        }).pipe(oneAtATime)

      return Practice.of({ options, preview, start, list, get, answer, next, bookmark, finish, review, similar })
    })
  )
}
