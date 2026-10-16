import { eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { Db } from "../db/Database.ts"
import { paperMarks, sources } from "../db/schema.ts"

// What Paper Marks make Seen (docs/design.md, "Sessions", and decision 57):
// every Question with a Source on a marked page of a marked Book, first Seen
// at the earliest mark that covers it and last Seen at the latest.

export interface Mark {
  readonly id: string
  readonly bookId: string
  readonly firstPage: number | null
  readonly lastPage: number | null
  readonly createdAt: number
}

export interface SourcePage {
  readonly questionId: string
  readonly bookId: string
  readonly page: number
}

export const covers = (mark: Mark, source: SourcePage) =>
  mark.bookId === source.bookId &&
  (mark.firstPage === null || mark.lastPage === null || (source.page >= mark.firstPage && source.page <= mark.lastPage))

// When each Question was first made Seen, or last, by the Question it counts
// as: a merged Question counts as the one it became.
export const paperSeenOf = (
  marks: ReadonlyArray<Mark>,
  pages: ReadonlyArray<SourcePage>,
  resolve: (questionId: string) => string = (questionId) => questionId,
  which: "first" | "last" = "first"
): ReadonlyMap<string, number> => {
  const seen = new Map<string, number>()
  for (const source of pages) {
    for (const mark of marks) {
      if (!covers(mark, source)) continue
      const id = resolve(source.questionId)
      const kept = seen.get(id)
      if (kept === undefined || (which === "first" ? mark.createdAt < kept : mark.createdAt > kept)) seen.set(id, mark.createdAt)
    }
  }
  return seen
}

// A Profile's marks, and the Sources in the Books they mark.
export const marksAndPages = (profileId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const marks: ReadonlyArray<Mark> = yield* db.select({
      id: paperMarks.id,
      bookId: paperMarks.bookId,
      firstPage: paperMarks.firstPage,
      lastPage: paperMarks.lastPage,
      createdAt: paperMarks.createdAt
    }).from(paperMarks).where(eq(paperMarks.profileId, profileId))
    if (marks.length === 0) return { marks, pages: [] as ReadonlyArray<SourcePage> }
    const pages: ReadonlyArray<SourcePage> = yield* db.select({
      questionId: sources.questionId,
      bookId: sources.bookId,
      page: sources.page
    }).from(sources).where(inArray(sources.bookId, [...new Set(marks.map((mark) => mark.bookId))]))
    return { marks, pages }
  })
