import { and, asc, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Semaphore } from "effect"
import { BookId } from "../../api/Books.ts"
import {
  GoldenCandidate,
  GoldenLimit,
  GoldenSetEmpty,
  GoldenSetFull,
  GoldenTagsInvalid,
  GoldenView,
  NotGoldenCandidate
} from "../../api/Golden.ts"
import { LlmNotConfigured } from "../../api/Jobs.ts"
import { QuestionId, type QuestionStatus } from "../../api/Review.ts"
import { tagProblems } from "../../api/taxonomyRules.ts"
import { Db } from "../db/Database.ts"
import { books, goldenQuestions, goldenRuns, jobs, options, parts, questions, sources } from "../db/schema.ts"
import { JobKinds } from "../jobs/JobKind.ts"
import { JobStore, toJobView } from "../jobs/JobStore.ts"
import { ApiKeyStore } from "../settings/ApiKeyStore.ts"
import { missingSettings, Settings } from "../settings/Settings.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { decodeReport, GoldenCheck, GoldenExpected } from "./goldenJob.ts"

// The golden set: the first Book's Questions the Curator approves, up to a
// hundred, and checks of it against the current prompts and models.

const encodeExpected = (expected: typeof GoldenExpected.Type) => JSON.stringify(expected)

export class Golden extends Context.Service<Golden, {
  readonly get: Effect.Effect<GoldenView>
  approve(
    questionId: QuestionId,
    tags: { readonly primarySkill: string; readonly secondarySkills: ReadonlyArray<string> }
  ): Effect.Effect<GoldenView, NotGoldenCandidate | GoldenSetFull | GoldenTagsInvalid>
  remove(questionId: QuestionId): Effect.Effect<GoldenView, NotGoldenCandidate>
  check(spendCap: number): Effect.Effect<GoldenView, GoldenSetEmpty | LlmNotConfigured>
}>()("gmat-prep/server/Golden") {
  static readonly layer = Layer.effect(
    Golden,
    Effect.gen(function*() {
      const db = yield* Db
      const store = yield* JobStore
      const kinds = yield* JobKinds
      const settings = yield* Settings
      const keys = yield* ApiKeyStore
      const taxonomy = (yield* Taxonomy).view
      const oneAtATime = (yield* Semaphore.make(1)).withPermits(1)

      // The Book added first.
      const firstBook = db.select({ id: books.id, title: books.title }).from(books)
        .orderBy(asc(books.createdAt), asc(sql`${books}.rowid`)).limit(1)
        .pipe(Effect.orDie, Effect.map((rows) => rows[0]))

      // The first Book's own Questions that are published or held.
      const candidatesOf = (bookId: string) =>
        Effect.gen(function*() {
          const rows = yield* db.select({ question: questions, set: sources.set, page: sources.page, number: sources.number })
            .from(sources)
            .innerJoin(questions, eq(questions.id, sources.questionId))
            .where(and(eq(sources.bookId, bookId), eq(sources.merged, false), inArray(questions.status, ["published", "held"])))
            .orderBy(asc(sources.page), asc(sources.number))
          const ids = rows.map((row) => row.question.id)
          const partRows = ids.length === 0
            ? []
            : yield* db.select().from(parts).where(and(inArray(parts.questionId, ids), eq(parts.position, 0)))
          const optionRows = partRows.length === 0
            ? []
            : yield* db.select().from(options).where(inArray(options.partId, partRows.map((part) => part.id)))
              .orderBy(asc(options.position))
          const approved = ids.length === 0
            ? []
            : yield* db.select().from(goldenQuestions).where(inArray(goldenQuestions.questionId, ids))
          return rows.map((row) => {
            const part = partRows.find((each) => each.questionId === row.question.id)
            const golden = approved.find((each) => each.questionId === row.question.id)
            const expected = golden === undefined ? undefined : JSON.parse(golden.expected) as typeof GoldenExpected.Type
            return new GoldenCandidate({
              questionId: QuestionId.make(row.question.id),
              questionType: row.question.questionType,
              set: row.set,
              number: row.number,
              page: row.page,
              stem: row.question.stem,
              options: optionRows.filter((option) => option.partId === part?.id).map((option) => ({
                label: option.label,
                text: option.text
              })),
              key: part?.key ?? null,
              status: row.question.status as QuestionStatus,
              primarySkill: expected?.primarySkill ?? row.question.primarySkill,
              secondarySkills: expected?.secondarySkills ??
                (JSON.parse(row.question.secondarySkills) as ReadonlyArray<string>),
              approved: golden !== undefined
            })
          })
        }).pipe(Effect.orDie)

      const get = Effect.gen(function*() {
        const book = yield* firstBook
        const [approved] = yield* db.select({ n: count() }).from(goldenQuestions).pipe(Effect.orDie)
        const [finished] = yield* db.select().from(goldenRuns).where(isNotNull(goldenRuns.report))
          .orderBy(desc(goldenRuns.finishedAt)).limit(1).pipe(Effect.orDie)
        const [latest] = yield* db.select().from(goldenRuns).orderBy(desc(goldenRuns.createdAt), desc(sql`${goldenRuns}.rowid`))
          .limit(1).pipe(Effect.orDie)
        const [job] = latest?.jobId == null
          ? []
          : yield* db.select().from(jobs).where(eq(jobs.id, latest.jobId)).pipe(Effect.orDie)
        return new GoldenView({
          book: book === undefined ? null : { id: BookId.make(book.id), title: book.title },
          limit: GoldenLimit,
          approved: approved?.n ?? 0,
          candidates: book === undefined ? [] : yield* candidatesOf(book.id),
          report: finished?.report == null ? null : Option.getOrNull(decodeReport(finished.report)),
          job: job === undefined ? null : toJobView(job, kinds)
        })
      })

      const candidate = (questionId: QuestionId) =>
        Effect.gen(function*() {
          const book = yield* firstBook
          const found = book === undefined
            ? undefined
            : (yield* candidatesOf(book.id)).find((each) => each.questionId === questionId)
          if (book === undefined || found === undefined) return yield* new NotGoldenCandidate()
          return { book, found }
        })

      // The Curator's approval keeps the Question as it stands, with the
      // Curator's tags; approving again replaces the tags.
      const approve = (
        questionId: QuestionId,
        tags: { readonly primarySkill: string; readonly secondarySkills: ReadonlyArray<string> }
      ) =>
        Effect.gen(function*() {
          const { book, found } = yield* candidate(questionId)
          const problems = tagProblems(taxonomy, {
            questionType: found.questionType,
            primarySkill: tags.primarySkill,
            secondarySkills: tags.secondarySkills,
            strategies: [],
            options: []
          })
          if (problems.length > 0) return yield* new GoldenTagsInvalid({ problems })
          const [approved] = yield* db.select({ n: count() }).from(goldenQuestions).pipe(Effect.orDie)
          if (!found.approved && (approved?.n ?? 0) >= GoldenLimit) return yield* new GoldenSetFull({ limit: GoldenLimit })
          const now = yield* Clock.currentTimeMillis
          const expected = encodeExpected({
            questionType: found.questionType,
            stem: found.stem,
            options: found.options,
            key: found.key,
            primarySkill: tags.primarySkill,
            secondarySkills: [...tags.secondarySkills]
          })
          yield* db.insert(goldenQuestions).values({
            questionId,
            bookId: book.id,
            set: found.set,
            number: found.number,
            page: found.page,
            expected,
            approvedAt: now
          }).onConflictDoUpdate({ target: goldenQuestions.questionId, set: { expected } }).pipe(Effect.orDie)
          return yield* get
        }).pipe(oneAtATime)

      const remove = (questionId: QuestionId) =>
        Effect.gen(function*() {
          const removed = yield* db.delete(goldenQuestions).where(eq(goldenQuestions.questionId, questionId))
            .returning({ id: goldenQuestions.questionId }).pipe(Effect.orDie)
          if (removed.length === 0) return yield* new NotGoldenCandidate()
          return yield* get
        }).pipe(oneAtATime)

      const check = (spendCap: number) =>
        Effect.gen(function*() {
          const [approved] = yield* db.select({ n: count() }).from(goldenQuestions).pipe(Effect.orDie)
          if ((approved?.n ?? 0) === 0) return yield* new GoldenSetEmpty()
          const llm = yield* settings.llm
          const hasKey = Option.isSome(yield* keys.read)
          const missing = [
            ...new Set([...missingSettings(llm, hasKey, "extraction"), ...missingSettings(llm, hasKey, "tagging")])
          ]
          if (missing.length > 0) return yield* new LlmNotConfigured({ missing })
          const now = yield* Clock.currentTimeMillis
          const runId = crypto.randomUUID()
          yield* db.transaction(() =>
            Effect.gen(function*() {
              yield* db.insert(goldenRuns).values({ id: runId, createdAt: now })
              const job = yield* store.create(GoldenCheck, { runId }, spendCap)
              yield* db.update(goldenRuns).set({ jobId: job.id }).where(eq(goldenRuns.id, runId))
            })
          ).pipe(Effect.orDie)
          return yield* get
        }).pipe(oneAtATime)

      return Golden.of({ get, approve, remove, check })
    })
  )
}
