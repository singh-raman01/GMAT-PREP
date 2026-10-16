import { and, asc, eq, inArray } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { BookId } from "../../api/Books.ts"
import {
  CannotPublish,
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
import { Db } from "../db/Database.ts"
import { readLinkReasons, recheckSources, RepeatCodes } from "../books/bankWrites.ts"
import { books, options, parts, questions, reviewItems, sources } from "../db/schema.ts"

// The Curator's decisions on held Questions and unread pages.

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

// Near matches and identical text with another key, which the Curator
// settles as a Variant or a merge.
const RepeatReasons: ReadonlySet<string> = RepeatCodes

export class ReviewQueue extends Context.Service<ReviewQueue, {
  readonly list: Effect.Effect<ReadonlyArray<ReviewItemView>>
  publish(id: ReviewItemId): Effect.Effect<ReviewItemView, ReviewItemNotFound | ReviewItemNotOpen | CannotPublish>
  withdraw(id: ReviewItemId): Effect.Effect<ReviewItemView, ReviewItemNotFound | ReviewItemNotOpen>
  keepAsVariant(id: ReviewItemId): Effect.Effect<ReviewItemView, ReviewItemNotFound | ReviewItemNotOpen>
  merge(id: ReviewItemId): Effect.Effect<ReviewItemView, ReviewItemNotFound | ReviewItemNotOpen>
  dismiss(id: ReviewItemId): Effect.Effect<ReviewItemView, ReviewItemNotFound | ReviewItemNotOpen>
}>()("gmat-prep/server/ReviewQueue") {
  static readonly layer = Layer.effect(
    ReviewQueue,
    Effect.gen(function*() {
      const db = yield* Db
      const oneAtATime = (yield* Semaphore.make(1)).withPermits(1)

      const questionViews = (ids: ReadonlyArray<string>) =>
        Effect.gen(function*() {
          if (ids.length === 0) return new Map<string, QuestionView>()
          const rows = yield* db.select().from(questions).where(inArray(questions.id, [...ids]))
          const partRows = yield* db.select().from(parts).where(and(inArray(parts.questionId, [...ids]), eq(parts.position, 0)))
          const optionRows = partRows.length === 0
            ? []
            : yield* db.select().from(options).where(inArray(options.partId, partRows.map((part) => part.id)))
              .orderBy(asc(options.position))
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
            return [row.id, new QuestionView({
              id: QuestionId.make(row.id),
              section: row.section,
              questionType: row.questionType,
              stem: row.stem,
              options: optionRows.filter((option) => option.partId === part?.id).map((option) => ({
                label: option.label,
                text: option.text
              })),
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
          return rows.map((row) =>
            new ReviewItemView({
              id: ReviewItemId.make(row.id),
              question: row.questionId === null ? null : views.get(row.questionId) ?? null,
              page: row.bookId === null || row.page === null ? null : {
                bookId: BookId.make(row.bookId),
                bookTitle: titles.find((book) => book.id === row.bookId)?.title ?? "",
                number: row.page
              },
              reasons: readReasons(row.reasons),
              related: row.relatedQuestionId === null ? null : views.get(row.relatedQuestionId) ?? null,
              status: row.status as "open" | "decided",
              decision: row.decision as ReviewItemView["decision"],
              createdAt: row.createdAt
            })
          )
        })

      const viewOf = (row: ItemRow) => viewsOf([row]).pipe(Effect.map((views) => views[0]!))

      const list = db.select().from(reviewItems).where(eq(reviewItems.status, "open"))
        .orderBy(asc(reviewItems.createdAt)).pipe(Effect.orDie, Effect.flatMap(viewsOf))

      const rowOf = (id: ReviewItemId) =>
        db.select().from(reviewItems).where(eq(reviewItems.id, id)).pipe(
          Effect.orDie,
          Effect.flatMap((rows) => (rows[0] === undefined ? Effect.fail(new ReviewItemNotFound()) : Effect.succeed(rows[0])))
        )

      // The open item, or the reason the action cannot go ahead. Actions read
      // it inside their transaction, so a re-link the worker commits meanwhile
      // is either seen or waits.
      const openItem = (id: ReviewItemId, fits: (row: ItemRow) => boolean) =>
        Effect.gen(function*() {
          const row = yield* rowOf(id)
          if (row.status !== "open" || !fits(row)) return yield* new ReviewItemNotOpen({ item: yield* viewOf(row) })
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

      const isQuestion = (row: ItemRow) => row.questionId !== null

      const publish = (id: ReviewItemId) =>
        inTransaction(Effect.gen(function*() {
          const row = yield* openItem(id, isQuestion)
          const blocking = readReasons(row.reasons).filter((reason) => !PublishableReasons.has(reason.code))
          if (blocking.length > 0) return yield* new CannotPublish({ reasons: blocking })
          yield* setQuestionStatus(row.questionId!, "published")
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

      // A Variant stays a Question of its own, still waiting for the Curator;
      // the repeat is settled for good, so re-linking does not raise it again.
      const keepAsVariant = (id: ReviewItemId) =>
        inTransaction(Effect.gen(function*() {
          const row = yield* openItem(id, repeats)
          const reasons = readReasons(row.reasons).filter((reason) => !RepeatReasons.has(reason.code))
          const [question] = yield* db.select({ linkReasons: questions.linkReasons }).from(questions)
            .where(eq(questions.id, row.questionId!)).pipe(Effect.orDie)
          const kept = readLinkReasons(question?.linkReasons ?? "[]").filter((reason) => !RepeatReasons.has(reason.code))
          yield* db.update(questions).set({ linkReasons: JSON.stringify(kept), relatedQuestionId: null })
            .where(eq(questions.id, row.questionId!)).pipe(Effect.orDie)
          const [updated] = yield* db.update(reviewItems)
            .set({ reasons: JSON.stringify(reasons), relatedQuestionId: null })
            .where(eq(reviewItems.id, row.id))
            .returning()
            .pipe(Effect.orDie)
          return updated!
        })).pipe(Effect.flatMap(viewOf), oneAtATime)

      // The same Question: its Sources join the related one, and it goes.
      // Items and Questions that pointed at it point at the related one now,
      // and the related one is held if its Sources now disagree on the key.
      const merge = (id: ReviewItemId) =>
        inTransaction(Effect.gen(function*() {
          const row = yield* openItem(id, repeats)
          const target = row.relatedQuestionId!
          const [other] = yield* db.select({ status: questions.status }).from(questions).where(eq(questions.id, target))
            .pipe(Effect.orDie)
          if (other === undefined || other.status === "withdrawn") {
            return yield* new ReviewItemNotOpen({ item: yield* viewOf(row) })
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
          return updated
        })).pipe(Effect.flatMap(viewOf), oneAtATime)

      const dismiss = (id: ReviewItemId) =>
        inTransaction(Effect.gen(function*() {
          const row = yield* openItem(id, (item) => item.questionId === null && item.page !== null)
          return yield* decide(row, "dismissed")
        })).pipe(Effect.flatMap(viewOf), oneAtATime)

      return ReviewQueue.of({ list, publish, withdraw, keepAsVariant, merge, dismiss })
    })
  )
}
