import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { Db } from "../db/Database.ts"
import { books, jobs, questions, sources } from "../db/schema.ts"

// Drafts are Questions waiting for enrichment and the Publish Gate. Each is
// checked by the extraction of a Book it has a Source in, while that runs, or
// by a refresh job that names it. Every change that makes a draft queues one
// of these in the same transaction. A draft is stranded when its job was
// cancelled or failed: it waits for the Curator to ask for a check.

const RefreshParams = Schema.fromJsonString(Schema.Struct({ questionIds: Schema.Array(Schema.String) }))
const RefreshCheckpoint = Schema.fromJsonString(Schema.Struct({ done: Schema.Int }))
const decodeParams = Schema.decodeUnknownOption(RefreshParams)
const decodeCheckpoint = Schema.decodeUnknownOption(RefreshCheckpoint)

export interface Drafts {
  // Drafts a queued or running job will check, oldest first.
  readonly checking: ReadonlyArray<string>
  // Drafts only a paused job will check, once the Curator resumes it.
  readonly paused: ReadonlyArray<string>
  // Drafts no job will check, oldest first.
  readonly stranded: ReadonlyArray<string>
}

export const drafts = Effect.gen(function*() {
  const db = yield* Db
  const rows = yield* db.select({ id: questions.id }).from(questions).where(eq(questions.status, "draft"))
    .orderBy(asc(questions.createdAt), asc(sql`${questions}.rowid`))
  if (rows.length === 0) return { checking: [], paused: [], stranded: [] } satisfies Drafts
  const extracting = yield* db.selectDistinct({ questionId: sources.questionId, status: jobs.status }).from(sources)
    .innerJoin(books, eq(books.id, sources.bookId))
    .innerJoin(jobs, eq(jobs.id, books.jobId))
    .where(and(eq(jobs.kind, "book-extract"), inArray(jobs.status, ["queued", "running", "paused"])))
  const refreshes = yield* db.select({ params: jobs.params, checkpoint: jobs.checkpoint, status: jobs.status }).from(jobs)
    .where(and(eq(jobs.kind, "question-refresh"), inArray(jobs.status, ["queued", "running", "paused"])))
  const active = new Set<string>()
  const waiting = new Set<string>()
  const cover = (id: string, status: string) => (status === "paused" ? waiting : active).add(id)
  for (const row of extracting) cover(row.questionId, row.status)
  for (const refresh of refreshes) {
    const ids = Option.match(decodeParams(refresh.params), { onNone: () => [], onSome: (params) => params.questionIds })
    const done = refresh.checkpoint === null
      ? 0
      : Option.match(decodeCheckpoint(refresh.checkpoint), { onNone: () => 0, onSome: (at) => at.done })
    for (const id of ids.slice(done)) cover(id, refresh.status)
  }
  const ids = rows.map((row) => row.id)
  return {
    checking: ids.filter((id) => active.has(id)),
    paused: ids.filter((id) => !active.has(id) && waiting.has(id)),
    stranded: ids.filter((id) => !active.has(id) && !waiting.has(id))
  } satisfies Drafts
})
