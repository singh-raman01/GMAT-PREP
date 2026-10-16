import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { BookId } from "../../api/Books.ts"
import {
  ApproachView,
  CannotPublish,
  DraftsView,
  KeyNotAnOption,
  KeysDiffer,
  KeyOverrideView,
  OptionNoteView,
  PublishableReasons,
  QuestionId,
  type QuestionStatus,
  QuestionView,
  ReviewItemId,
  ReviewItemNotFound,
  ReviewItemNotOpen,
  ReviewItemView,
  ReviewReason,
  SourceView
} from "../../api/Review.ts"
import { KeyCodes, readLinkReasons, recheckSources, RepeatCodes, UnsureCodes } from "../books/bankWrites.ts"
import { Db } from "../db/Database.ts"
import {
  approaches,
  books,
  goldenQuestions,
  keyOverrides,
  optionNotes,
  options,
  parts,
  questions,
  reviewItems,
  solverRuns,
  sources
} from "../db/schema.ts"
import { SolverRuns } from "../books/enrichment.ts"
import { JobStore } from "../jobs/JobStore.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { runGate } from "./gate.ts"
import { QuestionRefresh, RefreshCap } from "./refreshJob.ts"
import { assignReserve } from "./reserve.ts"
import { drafts } from "./stranded.ts"

// The Curator's decisions on held Questions and unread pages. A Question the
// Publish Gate is still checking (a draft) is not in the queue.

const decodeReason = Schema.decodeUnknownOption(ReviewReason)

// Each stored reason, as the API names it. One this version does not know,
// such as one an older version wrote, still blocks publishing.
const readReasons = (json: string): ReadonlyArray<ReviewReason> => {
  let stored: unknown
  try {
    stored = JSON.parse(json)
  } catch {
    stored = undefined
  }
  if (!Array.isArray(stored)) {
    return [new ReviewReason({ code: "structure", detail: "Its reasons could not be read; withdraw it or extract it again." })]
  }
  return stored.map((reason: unknown) =>
    Option.getOrElse(decodeReason(reason), () =>
      new ReviewReason({
        code: "structure",
        detail: `A reason this version of the app does not know: ${JSON.stringify(reason).slice(0, 200)}.`
      }))
  )
}

type ItemRow = typeof reviewItems.$inferSelect

// Reasons enrichment may settle when tried again after an unusable reply.
const RetryCodes: ReadonlySet<string> = new Set(["tags", "approach-misses-key", "option-notes", "teaching-text", "not-enriched"])
// Of those, the ones about the Approaches and notes.
const ContentCodes: ReadonlySet<string> = new Set(["approach-misses-key", "option-notes", "teaching-text"])

// Near matches and identical text with another key, which the Curator
// settles as a Variant or a merge.
const RepeatReasons: ReadonlySet<string> = RepeatCodes


export class ReviewQueue extends Context.Service<ReviewQueue, {
  readonly list: Effect.Effect<ReadonlyArray<ReviewItemView>>
  publish(id: ReviewItemId): Effect.Effect<ReviewItemView, ReviewItemNotFound | ReviewItemNotOpen | CannotPublish>
  withdraw(id: ReviewItemId): Effect.Effect<ReviewItemView, ReviewItemNotFound | ReviewItemNotOpen>
  keepAsVariant(id: ReviewItemId): Effect.Effect<ReviewItemView, ReviewItemNotFound | ReviewItemNotOpen>
  merge(id: ReviewItemId): Effect.Effect<ReviewItemView, ReviewItemNotFound | ReviewItemNotOpen | KeysDiffer>
  dismiss(id: ReviewItemId): Effect.Effect<ReviewItemView, ReviewItemNotFound | ReviewItemNotOpen>
  overrideKey(
    id: ReviewItemId,
    key: string,
    reason: string
  ): Effect.Effect<ReviewItemView, ReviewItemNotFound | ReviewItemNotOpen | KeyNotAnOption>
  checkAgain(id: ReviewItemId): Effect.Effect<ReviewItemView, ReviewItemNotFound | ReviewItemNotOpen>
  readonly drafts: Effect.Effect<DraftsView>
  readonly checkDrafts: Effect.Effect<DraftsView>
}>()("gmat-prep/server/ReviewQueue") {
  static readonly layer = Layer.effect(
    ReviewQueue,
    Effect.gen(function*() {
      const db = yield* Db
      const store = yield* JobStore
      const taxonomy = (yield* Taxonomy).view
      const oneAtATime = (yield* Semaphore.make(1)).withPermits(1)

      const questionViews = (ids: ReadonlyArray<string>) =>
        Effect.gen(function*() {
          if (ids.length === 0) return new Map<string, QuestionView>()
          const rows = yield* db.select().from(questions).where(inArray(questions.id, [...ids]))
          const partRows = yield* db.select().from(parts).where(and(inArray(parts.questionId, [...ids]), eq(parts.position, 0)))
          const partIds = partRows.map((part) => part.id)
          const optionRows = partIds.length === 0
            ? []
            : yield* db.select().from(options).where(inArray(options.partId, partIds)).orderBy(asc(options.position))
          const noteRows = partIds.length === 0
            ? []
            : yield* db.select().from(optionNotes).where(inArray(optionNotes.partId, partIds))
              .orderBy(asc(optionNotes.position))
          const overrideRows = partIds.length === 0
            ? []
            : yield* db.select().from(keyOverrides).where(inArray(keyOverrides.partId, partIds))
              .orderBy(asc(keyOverrides.createdAt))
          const solveRows = yield* db.select().from(solverRuns).where(inArray(solverRuns.questionId, [...ids]))
            .orderBy(asc(solverRuns.run))
          const approachRows = yield* db.select().from(approaches).where(inArray(approaches.questionId, [...ids]))
            .orderBy(asc(approaches.position))
          const sourceRows = yield* db.select({
            questionId: sources.questionId,
            bookId: sources.bookId,
            bookTitle: books.title,
            set: sources.set,
            number: sources.number,
            page: sources.page,
            explanation: sources.explanation,
            createdAt: sources.createdAt
          }).from(sources).innerJoin(books, eq(books.id, sources.bookId))
            .where(inArray(sources.questionId, [...ids]))
            .orderBy(asc(sources.createdAt))
          return new Map(rows.map((row) => {
            const part = partRows.find((each) => each.questionId === row.id)
            const mine = sourceRows.filter((source) => source.questionId === row.id)
            const choices = optionRows.filter((option) => option.partId === part?.id)
            return [row.id, new QuestionView({
              id: QuestionId.make(row.id),
              section: row.section,
              questionType: row.questionType,
              stem: row.stem,
              options: choices.map((option) => ({ label: option.label, text: option.text })),
              key: part?.key ?? null,
              keyBasis: (part?.keyBasis ?? null) as "book" | "computed" | "override" | null,
              status: row.status as QuestionStatus,
              bookLabel: row.bookLabel,
              explanation: mine.find((source) => source.explanation !== null)?.explanation ?? null,
              sources: mine.map((source) =>
                new SourceView({
                  bookId: BookId.make(source.bookId),
                  bookTitle: source.bookTitle,
                  set: source.set,
                  number: source.number,
                  page: source.page
                })
              ),
              primarySkill: row.primarySkill,
              secondarySkills: JSON.parse(row.secondarySkills) as ReadonlyArray<string>,
              difficultyEstimate: row.difficultyEstimate,
              solverAnswers: solveRows.filter((solve) => solve.questionId === row.id).map((solve) => solve.answer),
              approaches: approachRows.filter((approach) => approach.questionId === row.id).map((approach) =>
                new ApproachView({
                  strategy: approach.strategy,
                  steps: approach.steps,
                  expectedSeconds: approach.expectedSeconds,
                  validWhen: approach.validWhen,
                  author: approach.author as "book" | "llm",
                  answer: approach.answer
                })
              ),
              optionNotes: noteRows.filter((note) => note.partId === part?.id).map((note) =>
                new OptionNoteView({
                  label: choices[note.position]?.label ?? "?",
                  trapNote: note.trapNote,
                  mistakeType: note.mistakeType,
                  trapPattern: note.trapPattern
                })
              ),
              keyOverrides: overrideRows.filter((override) => override.partId === part?.id).map((override) =>
                new KeyOverrideView({
                  previousKey: override.previousKey,
                  newKey: override.newKey,
                  reason: override.reason,
                  createdAt: override.createdAt
                })
              )
            })] as const
          }))
        }).pipe(Effect.orDie)

      const viewsOf = (rows: ReadonlyArray<ItemRow>) =>
        Effect.gen(function*() {
          const ids = rows.flatMap((row) => [row.questionId, row.relatedQuestionId].filter((id): id is string => id !== null))
          const views = yield* questionViews([...new Set(ids)])
          const bookIds = rows.flatMap((row) => (row.bookId === null ? [] : [row.bookId]))
          const titles = bookIds.length === 0
            ? []
            : yield* db.select({ id: books.id, title: books.title }).from(books).where(inArray(books.id, bookIds)).pipe(
              Effect.orDie
            )
          return rows.map((row) => {
            const question = row.questionId === null ? undefined : views.get(row.questionId)
            const reasons = readReasons(row.reasons)
            return new ReviewItemView({
              id: ReviewItemId.make(row.id),
              question: question ?? null,
              page: row.bookId === null || row.page === null ? null : {
                bookId: BookId.make(row.bookId),
                bookTitle: titles.find((book) => book.id === row.bookId)?.title ?? "",
                number: row.page
              },
              reasons,
              related: row.relatedQuestionId === null ? null : views.get(row.relatedQuestionId) ?? null,
              status: row.status as "open" | "decided",
              decision: row.decision as ReviewItemView["decision"],
              // Text in doubt is not enriched at all, so trying again cannot help it.
              checkable: row.status === "open" && question !== undefined &&
                !reasons.some((reason) => UnsureCodes.has(reason.code)) &&
                (reasons.some((reason) => RetryCodes.has(reason.code)) || question.solverAnswers.length < SolverRuns),
              createdAt: row.createdAt
            })
          })
        })

      const viewOf = (row: ItemRow) => viewsOf([row]).pipe(Effect.map((views) => views[0]!))

      // Open items, except those of Questions the Publish Gate is checking.
      const list = db.select({ item: reviewItems }).from(reviewItems)
        .leftJoin(questions, eq(questions.id, reviewItems.questionId))
        .where(and(eq(reviewItems.status, "open"), or(isNull(reviewItems.questionId), ne(questions.status, "draft"))))
        .orderBy(asc(reviewItems.createdAt), asc(sql`${reviewItems}.rowid`))
        .pipe(
          Effect.orDie,
          Effect.flatMap((rows) => viewsOf(rows.map((row) => row.item)))
        )

      const rowOf = (id: ReviewItemId) =>
        db.select().from(reviewItems).where(eq(reviewItems.id, id)).pipe(
          Effect.orDie,
          Effect.flatMap((rows) => (rows[0] === undefined ? Effect.fail(new ReviewItemNotFound()) : Effect.succeed(rows[0])))
        )

      const statusOf = (questionId: string) =>
        db.select({ status: questions.status }).from(questions).where(eq(questions.id, questionId)).pipe(
          Effect.orDie,
          Effect.map((rows) => rows[0]?.status)
        )

      // The open item, or the reason the action cannot go ahead: it was
      // decided, its Question is being checked again, or the action does not
      // fit it. Actions read it inside their transaction, so a re-link the
      // worker commits meanwhile is either seen or waits.
      const openItem = (id: ReviewItemId, fits: (row: ItemRow) => boolean) =>
        Effect.gen(function*() {
          const row = yield* rowOf(id)
          const checking = row.questionId !== null && (yield* statusOf(row.questionId)) !== "held"
          if (row.status !== "open" || checking || !fits(row)) {
            return yield* new ReviewItemNotOpen({ item: yield* viewOf(row) })
          }
          return row
        })

      // Runs an action in one transaction; its failures come back as values
      // so they do not roll back as defects.
      const inTransaction = <A, E>(action: Effect.Effect<A, E, never>) =>
        db.transaction(() => Effect.result(action)).pipe(
          Effect.orDie,
          Effect.flatMap((result) => (result._tag === "Success" ? Effect.succeed(result.success) : Effect.fail(result.failure)))
        )

      const decide = (row: ItemRow, decision: string, changes: Partial<ItemRow> = {}) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const [updated] = yield* db.update(reviewItems)
            .set({ status: "decided", decision, decidedAt: now, ...changes })
            .where(eq(reviewItems.id, row.id))
            .returning()
            .pipe(Effect.orDie)
          return updated!
        })

      const setQuestionStatus = (questionId: string, status: QuestionStatus) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          yield* db.update(questions).set({ status, updatedAt: now }).where(eq(questions.id, questionId)).pipe(
            Effect.orDie
          )
        })

      // A Question published after its Book's run joins the Reserve now; one
      // published during the run waits for the run's end.
      const reserveFor = (questionId: string) =>
        Effect.gen(function*() {
          const [own] = yield* db.select({ bookId: sources.bookId, status: books.status }).from(sources)
            .innerJoin(books, eq(books.id, sources.bookId))
            .where(and(eq(sources.questionId, questionId), eq(sources.merged, false)))
            .pipe(Effect.orDie)
          if (own?.status === "extracted") {
            yield* assignReserve(own.bookId).pipe(Effect.provideService(Db, db), Effect.orDie)
          }
        })

      // Questions that went back to draft are checked again by a job, which
      // can write new Approaches and notes.
      const refresh = (questionIds: ReadonlyArray<string>, reason: string) =>
        Effect.gen(function*() {
          const drafts: Array<string> = []
          for (const id of questionIds) if ((yield* statusOf(id)) === "draft") drafts.push(id)
          if (drafts.length > 0) yield* store.create(QuestionRefresh, { questionIds: drafts, reason }, RefreshCap)
        })

      const isQuestion = (row: ItemRow) => row.questionId !== null

      const publish = (id: ReviewItemId) =>
        inTransaction(Effect.gen(function*() {
          const row = yield* openItem(id, isQuestion)
          const blocking = readReasons(row.reasons).filter((reason) => !PublishableReasons.has(reason.code))
          if (blocking.length > 0) return yield* new CannotPublish({ reasons: blocking })
          yield* setQuestionStatus(row.questionId!, "published")
          yield* reserveFor(row.questionId!)
          return yield* decide(row, "published")
        })).pipe(Effect.flatMap(viewOf), oneAtATime)

      const withdraw = (id: ReviewItemId) =>
        inTransaction(Effect.gen(function*() {
          const row = yield* openItem(id, isQuestion)
          yield* setQuestionStatus(row.questionId!, "withdrawn")
          return yield* decide(row, "withdrawn")
        })).pipe(Effect.flatMap(viewOf), oneAtATime)

      const repeats = (row: ItemRow) =>
        isQuestion(row) && row.relatedQuestionId !== null &&
        readReasons(row.reasons).some((reason) => RepeatReasons.has(reason.code))

      // A Variant is a Question of its own: the repeat is settled for good,
      // and the Question goes through the Publish Gate again, which publishes
      // it when nothing else holds it.
      const keepAsVariant = (id: ReviewItemId) =>
        inTransaction(Effect.gen(function*() {
          const row = yield* openItem(id, repeats)
          const [question] = yield* db.select({ linkReasons: questions.linkReasons }).from(questions)
            .where(eq(questions.id, row.questionId!)).pipe(Effect.orDie)
          const kept = readLinkReasons(question?.linkReasons ?? "[]").filter((reason) => !RepeatReasons.has(reason.code))
          yield* db.update(questions).set({ linkReasons: JSON.stringify(kept), relatedQuestionId: null })
            .where(eq(questions.id, row.questionId!)).pipe(Effect.orDie)
          yield* db.update(reviewItems).set({ relatedQuestionId: null }).where(eq(reviewItems.id, row.id)).pipe(Effect.orDie)
          const outcome = yield* runGate(row.questionId!, taxonomy).pipe(Effect.provideService(Db, db), Effect.orDie)
          if (outcome === "published") yield* reserveFor(row.questionId!)
          const [updated] = yield* db.select().from(reviewItems).where(eq(reviewItems.id, row.id)).pipe(Effect.orDie)
          return updated!
        })).pipe(Effect.flatMap(viewOf), oneAtATime)

      // The same Question: its Sources join the related one, and it goes.
      // Items and Questions that pointed at it point at the related one now,
      // and the related one is checked again if its Sources now disagree.
      const keyOf = (questionId: string) =>
        db.select({ key: parts.key, keyBasis: parts.keyBasis }).from(parts)
          .where(and(eq(parts.questionId, questionId), eq(parts.position, 0)))
          .pipe(Effect.orDie, Effect.map((rows) => rows[0]))

      const merge = (id: ReviewItemId) =>
        Effect.gen(function*() {
          const decided = yield* inTransaction(Effect.gen(function*() {
            const row = yield* openItem(id, repeats)
            const target = row.relatedQuestionId!
            // The related Question must be there and settled: one being
            // checked could be overwritten by its check.
            const targetStatus = yield* statusOf(target)
            if (targetStatus === undefined || targetStatus === "withdrawn" || targetStatus === "draft") {
              return yield* new ReviewItemNotOpen({ item: yield* viewOf(row) })
            }
            const mine = yield* keyOf(row.questionId!)
            const theirs = yield* keyOf(target)
            if (mine?.keyBasis === "override" && mine.key !== null && mine.key !== theirs?.key) {
              return yield* new KeysDiffer({ key: mine.key, relatedKey: theirs?.key ?? null })
            }
            // A golden-set approval follows the Book's item to its Question.
            const [targetGolden] = yield* db.select({ id: goldenQuestions.questionId }).from(goldenQuestions)
              .where(eq(goldenQuestions.questionId, target)).pipe(Effect.orDie)
            if (targetGolden === undefined) {
              yield* db.update(goldenQuestions).set({ questionId: target })
                .where(eq(goldenQuestions.questionId, row.questionId!)).pipe(Effect.orDie)
            }
            yield* db.update(sources).set({ questionId: target, merged: true })
              .where(eq(sources.questionId, row.questionId!)).pipe(Effect.orDie)
            yield* db.update(reviewItems).set({ relatedQuestionId: target })
              .where(and(eq(reviewItems.relatedQuestionId, row.questionId!), eq(reviewItems.status, "open")))
              .pipe(Effect.orDie)
            yield* db.update(questions).set({ relatedQuestionId: target })
              .where(eq(questions.relatedQuestionId, row.questionId!)).pipe(Effect.orDie)
            const updated = yield* decide(row, "merged", { questionId: null })
            yield* db.delete(questions).where(eq(questions.id, row.questionId!)).pipe(Effect.orDie)
            yield* recheckSources(target).pipe(Effect.provideService(Db, db), Effect.orDie)
            yield* refresh([target], "Checking a merged Question again")
            return updated
          }))
          return yield* viewOf(decided)
        }).pipe(oneAtATime)

      const dismiss = (id: ReviewItemId) =>
        inTransaction(Effect.gen(function*() {
          const row = yield* openItem(id, (item) => item.questionId === null && item.page !== null)
          return yield* decide(row, "dismissed")
        })).pipe(Effect.flatMap(viewOf), oneAtATime)

      // The Curator's key replaces the Book's, with a reason kept beside it.
      // Reasons about the key are settled; a changed key owes the Question new
      // Approaches and wrong-option notes, and its tags, Difficulty estimate
      // and solver runs are kept. Either way it goes back through the
      // Publish Gate, in a job.
      const overrideKey = (id: ReviewItemId, key: string, reason: string) =>
        Effect.gen(function*() {
          const row = yield* inTransaction(Effect.gen(function*() {
            const row = yield* openItem(id, isQuestion)
            const questionId = row.questionId!
            const [part] = yield* db.select().from(parts)
              .where(and(eq(parts.questionId, questionId), eq(parts.position, 0))).pipe(Effect.orDie)
            const choices = part === undefined
              ? []
              : (yield* db.select({ label: options.label }).from(options).where(eq(options.partId, part.id))
                .orderBy(asc(options.position)).pipe(Effect.orDie)).map((option) => option.label)
            if (part === undefined || !choices.includes(key)) return yield* new KeyNotAnOption({ options: choices })
            const now = yield* Clock.currentTimeMillis
            yield* db.insert(keyOverrides).values({
              id: crypto.randomUUID(),
              partId: part.id,
              previousKey: part.key,
              newKey: key,
              reason: reason.trim(),
              createdAt: now
            }).pipe(Effect.orDie)
            yield* db.update(parts).set({ key, keyBasis: "override" }).where(eq(parts.id, part.id)).pipe(Effect.orDie)
            const [question] = yield* db.select().from(questions).where(eq(questions.id, questionId)).pipe(Effect.orDie)
            const kept = readLinkReasons(question?.linkReasons ?? "[]").filter((each) => !KeyCodes.has(each.code))
            yield* db.update(questions).set({
              linkReasons: JSON.stringify(kept),
              status: "draft",
              ...(part.key !== key && question?.enrichment === "done" ? { enrichment: "key-content" } : {}),
              updatedAt: now
            }).where(eq(questions.id, questionId)).pipe(Effect.orDie)
            yield* refresh([questionId], "Checking a Question after a Key Override")
            return row
          }))
          return yield* viewOf((yield* db.select().from(reviewItems).where(eq(reviewItems.id, row.id)).pipe(Effect.orDie))[0]!)
        }).pipe(oneAtATime)

      // Tries again what an unusable reply left out or got wrong: tags held
      // for are asked for again, Approaches and notes are written again, and
      // missing solves are asked for, all in a job.
      const checkAgain = (id: ReviewItemId) =>
        Effect.gen(function*() {
          const row = yield* inTransaction(Effect.gen(function*() {
            const row = yield* openItem(id, isQuestion)
            const item = yield* viewOf(row)
            if (!item.checkable) return yield* new ReviewItemNotOpen({ item })
            const questionId = row.questionId!
            const [question] = yield* db.select().from(questions).where(eq(questions.id, questionId)).pipe(Effect.orDie)
            const codes = new Set(item.reasons.map((reason) => reason.code))
            const now = yield* Clock.currentTimeMillis
            yield* db.update(questions).set({
              status: "draft",
              ...(codes.has("tags") ? { taggedAt: null } : {}),
              ...([...codes].some((code) => ContentCodes.has(code)) && question?.enrichment === "done"
                ? { enrichment: "key-content" }
                : {}),
              updatedAt: now
            }).where(eq(questions.id, questionId)).pipe(Effect.orDie)
            yield* refresh([questionId], "Checking a Question again")
            return row
          }))
          return yield* viewOf((yield* db.select().from(reviewItems).where(eq(reviewItems.id, row.id)).pipe(Effect.orDie))[0]!)
        }).pipe(oneAtATime)

      const draftsView = drafts.pipe(
        Effect.provideService(Db, db),
        Effect.orDie,
        Effect.map((found) => new DraftsView({ checking: found.checking.length, stranded: found.stranded.length }))
      )

      const checkDrafts = inTransaction(Effect.gen(function*() {
        const found = yield* drafts.pipe(Effect.provideService(Db, db), Effect.orDie)
        if (found.stranded.length > 0) {
          yield* store.create(QuestionRefresh, { questionIds: found.stranded, reason: "Checking Questions left waiting" }, RefreshCap)
        }
      })).pipe(Effect.flatMap(() => draftsView), oneAtATime)

      return ReviewQueue.of({
        list,
        publish,
        withdraw,
        keepAsVariant,
        merge,
        dismiss,
        overrideKey,
        checkAgain,
        drafts: draftsView,
        checkDrafts
      })
    })
  )
}
