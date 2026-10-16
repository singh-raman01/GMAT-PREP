import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { Db } from "../db/Database.ts"
import { books, jobs, questions, sources } from "../db/schema.ts"

// Drafts are Questions waiting for enrichment and the Publish Gate. Each is
// checked by the extraction of a Book it has a Source in, while that runs, or
// by a refresh job that names it. A draft no such job will reach, as when
// another Book's run sent it back, a refresh job was cancelled, or the app
// stopped before queueing the job, is stranded: the next extraction or
// refresh job takes it, and so does a refresh queued when the app starts or
// when the Curator asks.

const LiveStatuses = ["queued", "running", "paused"]

const RefreshParams = Schema.fromJsonString(Schema.Struct({ questionIds: Schema.Array(Schema.String) }))
const RefreshCheckpoint = Schema.fromJsonString(Schema.Struct({ done: Schema.Int }))
const decodeParams = Schema.decodeUnknownOption(RefreshParams)
const decodeCheckpoint = Schema.decodeUnknownOption(RefreshCheckpoint)

export interface Drafts {
  // Drafts a live job will check, oldest first.
  readonly checking: ReadonlyArray<string>
  // Drafts no live job will check, oldest first.
  readonly stranded: ReadonlyArray<string>
}

export const drafts = Effect.gen(function*() {
  const db = yield* Db
  const rows = yield* db.select({ id: questions.id }).from(questions).where(eq(questions.status, "draft"))
    .orderBy(asc(questions.createdAt), asc(sql`${questions}.rowid`))
  if (rows.length === 0) return { checking: [], stranded: [] } satisfies Drafts
  const extracting = yield* db.selectDistinct({ questionId: sources.questionId }).from(sources)
    .innerJoin(books, eq(books.id, sources.bookId))
    .innerJoin(jobs, eq(jobs.id, books.jobId))
    .where(and(eq(jobs.kind, "book-extract"), inArray(jobs.status, LiveStatuses)))
  const refreshes = yield* db.select({ params: jobs.params, checkpoint: jobs.checkpoint }).from(jobs)
    .where(and(eq(jobs.kind, "question-refresh"), inArray(jobs.status, LiveStatuses)))
  const covered = new Set(extracting.map((row) => row.questionId))
  for (const refresh of refreshes) {
    const ids = Option.match(decodeParams(refresh.params), { onNone: () => [], onSome: (params) => params.questionIds })
    const done = refresh.checkpoint === null
      ? 0
      : Option.match(decodeCheckpoint(refresh.checkpoint), { onNone: () => 0, onSome: (at) => at.done })
    for (const id of ids.slice(done)) covered.add(id)
  }
  return {
    checking: rows.filter((row) => covered.has(row.id)).map((row) => row.id),
    stranded: rows.filter((row) => !covered.has(row.id)).map((row) => row.id)
  } satisfies Drafts
})

export const strandedDrafts = drafts.pipe(Effect.map((found) => found.stranded))
