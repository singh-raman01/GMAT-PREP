import { and, desc, eq, inArray } from "drizzle-orm"
import { Clock, Context, Effect, Layer } from "effect"
import { BookId, BookNotFound } from "../../api/Books.ts"
import { type PaperMarkInput, PaperMarkInvalid, PaperMarkNotFound, PaperMarkView } from "../../api/PaperMarks.ts"
import { Db } from "../db/Database.ts"
import { books, paperMarks, questions } from "../db/schema.ts"
import { mergeTargets } from "./history.ts"
import { marksAndPages, paperSeenOf } from "./paperSeen.ts"

// What is wrong with a page range, for a Book with the given number of pages
// (null when it is not known).
export const pageProblems = (input: PaperMarkInput, pageCount: number | null): ReadonlyArray<string> => {
  const { firstPage, lastPage } = input
  if (firstPage === null && lastPage === null) return []
  if (firstPage === null || lastPage === null) {
    return ["Give both the first and the last page, or neither for the whole Book."]
  }
  const problems: Array<string> = []
  if (firstPage > lastPage) problems.push(`Page ${firstPage} comes after page ${lastPage}.`)
  if (pageCount !== null && lastPage > pageCount) {
    problems.push(`The Book has ${pageCount} ${pageCount === 1 ? "page" : "pages"}.`)
  }
  return problems
}

export class PaperMarks extends Context.Service<PaperMarks, {
  list(profileId: string): Effect.Effect<ReadonlyArray<PaperMarkView>>
  add(profileId: string, input: PaperMarkInput): Effect.Effect<ReadonlyArray<PaperMarkView>, BookNotFound | PaperMarkInvalid>
  remove(profileId: string, id: string): Effect.Effect<ReadonlyArray<PaperMarkView>, PaperMarkNotFound>
}>()("gmat-prep/server/PaperMarks") {
  static readonly layer = Layer.effect(
    PaperMarks,
    Effect.gen(function*() {
      const db = yield* Db
      const run = <A, E>(effect: Effect.Effect<A, E, Db>) => effect.pipe(Effect.provideService(Db, db), Effect.orDie)

      // Each mark with the published Questions it makes Seen, counted on its
      // own: Questions two marks cover count for both.
      const list = (profileId: string) =>
        Effect.gen(function*() {
          const { marks, pages } = yield* run(marksAndPages(profileId))
          if (marks.length === 0) return []
          const resolve = yield* run(mergeTargets)
          const rows = yield* run(
            db.select({ id: paperMarks.id, createdAt: paperMarks.createdAt, bookTitle: books.title })
              .from(paperMarks).innerJoin(books, eq(books.id, paperMarks.bookId))
              .where(eq(paperMarks.profileId, profileId))
              .orderBy(desc(paperMarks.createdAt), desc(paperMarks.id))
          )
          const covered = new Map(marks.map((mark) => [mark.id, [...paperSeenOf([mark], pages, resolve).keys()]] as const))
          const ids = [...new Set([...covered.values()].flat())]
          const published = new Set(
            ids.length === 0 ? [] : (yield* run(
              db.select({ id: questions.id }).from(questions)
                .where(and(inArray(questions.id, ids), eq(questions.status, "published")))
            )).map((row) => row.id)
          )
          const byId = new Map(marks.map((mark) => [mark.id, mark] as const))
          return rows.map((row) => {
            const mark = byId.get(row.id)!
            return new PaperMarkView({
              id: mark.id,
              book: { id: BookId.make(mark.bookId), title: row.bookTitle },
              firstPage: mark.firstPage,
              lastPage: mark.lastPage,
              questions: covered.get(mark.id)!.filter((id) => published.has(id)).length,
              createdAt: mark.createdAt
            })
          })
        })

      const add = (profileId: string, input: PaperMarkInput) =>
        Effect.gen(function*() {
          const [book] = yield* run(db.select({ pageCount: books.pageCount }).from(books).where(eq(books.id, input.bookId)))
          if (book === undefined) return yield* new BookNotFound()
          const problems = pageProblems(input, book.pageCount)
          if (problems.length > 0) return yield* new PaperMarkInvalid({ problems })
          yield* run(db.insert(paperMarks).values({
            id: crypto.randomUUID(),
            profileId,
            bookId: input.bookId,
            firstPage: input.firstPage,
            lastPage: input.lastPage,
            createdAt: yield* Clock.currentTimeMillis
          }))
          return yield* list(profileId)
        })

      const remove = (profileId: string, id: string) =>
        Effect.gen(function*() {
          const removed = yield* run(
            db.delete(paperMarks).where(and(eq(paperMarks.id, id), eq(paperMarks.profileId, profileId)))
              .returning({ id: paperMarks.id })
          )
          if (removed.length === 0) return yield* new PaperMarkNotFound()
          return yield* list(profileId)
        })

      return PaperMarks.of({ list, add, remove })
    })
  )
}
