import { and, count, desc, eq, inArray, isNull, max, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import {
  AddedBook,
  BookDetail,
  BookId,
  BookMapInvalid,
  BookNotFound,
  BookNotReady,
  type BookStatus,
  BookView,
  ConfirmedMap,
  CostPreview,
  MapProposal,
  MapRange,
  type MapRangeInput,
  type PageRoute
} from "../../api/Books.ts"
import { JobId, LlmNotConfigured } from "../../api/Jobs.ts"
import { Db } from "../db/Database.ts"
import { bookMapProposals, bookMaps, bookPages, books, jobs } from "../db/schema.ts"
import { JobKinds } from "../jobs/JobKind.ts"
import { JobStore, toJobView } from "../jobs/JobStore.ts"
import { ApiKeyStore } from "../settings/ApiKeyStore.ts"
import { missingSettings, Settings, taskReadsImages } from "../settings/Settings.ts"
import { BookFiles, type Received } from "./BookFiles.ts"
import { mapProblems, tidyMap } from "../../api/bookMapRules.ts"
import { BookIntake, SampleCap, scannedRouteFor } from "./intakeJob.ts"
import { BookMapping, encodeRanges, PagesPerBatch } from "./mapJob.ts"

// The Curator's Books: adding one, its cost preview and full run, and its
// Book Map versions.

export interface BookDetails {
  readonly title: string
  readonly edition: string
  readonly official: boolean
}

type BookRow = typeof books.$inferSelect

const decodePreview = Schema.decodeUnknownOption(Schema.fromJsonString(CostPreview))
const decodeRanges = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(MapRange)))

// Statuses from which a Book Map can be confirmed: the pages have been read.
const Mappable: ReadonlySet<string> = new Set(["previewed", "mapping", "map-proposed", "mapped"])

export class Books extends Context.Service<Books, {
  add(details: BookDetails, received: Received): Effect.Effect<AddedBook>
  readonly list: Effect.Effect<ReadonlyArray<BookView>>
  get(id: BookId): Effect.Effect<BookDetail, BookNotFound>
  readAgain(id: BookId): Effect.Effect<BookView, BookNotFound | BookNotReady>
  start(id: BookId, spendCap: number): Effect.Effect<BookView, BookNotFound | BookNotReady | LlmNotConfigured>
  confirmMap(
    id: BookId,
    ranges: ReadonlyArray<MapRangeInput>
  ): Effect.Effect<BookDetail, BookNotFound | BookNotReady | BookMapInvalid>
  fileOf(id: BookId): Effect.Effect<{ readonly path: string; readonly title: string }, BookNotFound>
}>()("gmat-prep/server/Books") {
  static readonly layer = Layer.effect(
    Books,
    Effect.gen(function*() {
      const db = yield* Db
      const store = yield* JobStore
      const kinds = yield* JobKinds
      const files = yield* BookFiles
      const settings = yield* Settings
      const keys = yield* ApiKeyStore
      // Changes to Books read, decide and write; one at a time.
      const oneAtATime = (yield* Semaphore.make(1)).withPermits(1)

      const viewsOf = (rows: ReadonlyArray<BookRow>) =>
        Effect.gen(function*() {
          if (rows.length === 0) return []
          const ids = rows.map((row) => row.id)
          const scanned = yield* db.select({ bookId: bookPages.bookId, number: bookPages.number }).from(bookPages)
            .where(and(inArray(bookPages.bookId, ids), eq(bookPages.hasText, false)))
            .orderBy(bookPages.number)
          const versions = yield* db.select({ bookId: bookMaps.bookId, version: max(bookMaps.version) }).from(bookMaps)
            .where(inArray(bookMaps.bookId, ids))
            .groupBy(bookMaps.bookId)
          const jobIds = rows.flatMap((row) => (row.jobId === null ? [] : [row.jobId]))
          const jobRows = jobIds.length === 0 ? [] : yield* db.select().from(jobs).where(inArray(jobs.id, jobIds))
          return rows.map((row) => {
            const job = jobRows.find((candidate) => candidate.id === row.jobId)
            return new BookView({
              id: BookId.make(row.id),
              title: row.title,
              edition: row.edition,
              official: row.official,
              fileHash: row.fileHash,
              fileSize: row.fileSize,
              status: row.status as BookStatus,
              note: row.note,
              pageCount: row.pageCount,
              textPages: row.textPages,
              scannedPages: scanned.filter((page) => page.bookId === row.id).map((page) => page.number),
              scannedRoute: row.scannedRoute as PageRoute | null,
              preview: row.preview === null ? null : Option.getOrNull(decodePreview(row.preview)),
              mapVersion: versions.find((version) => version.bookId === row.id)?.version ?? null,
              job: job === undefined ? null : toJobView(job, kinds),
              createdAt: row.createdAt
            })
          })
        }).pipe(Effect.orDie)

      const viewOf = (row: BookRow) => viewsOf([row]).pipe(Effect.map((views) => views[0]!))

      const rowOf = (id: BookId) =>
        db.select().from(books).where(eq(books.id, id)).pipe(
          Effect.orDie,
          Effect.flatMap((rows) => (rows[0] === undefined ? Effect.fail(new BookNotFound()) : Effect.succeed(rows[0])))
        )

      const jobOf = (row: BookRow) =>
        row.jobId === null
          ? Effect.succeed(undefined)
          : db.select().from(jobs).where(eq(jobs.id, row.jobId)).pipe(Effect.map((found) => found[0]), Effect.orDie)

      const update = (id: string, changes: Partial<BookRow>) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const [row] = yield* db.update(books).set({ ...changes, updatedAt: now }).where(eq(books.id, id)).returning()
            .pipe(Effect.orDie)
          return row!
        })

      const add = (details: BookDetails, received: Received) =>
        Effect.gen(function*() {
          const [existing] = yield* db.select().from(books).where(eq(books.fileHash, received.hash)).pipe(Effect.orDie)
          if (existing !== undefined) {
            yield* files.discard(received)
            return new AddedBook({ book: yield* viewOf(existing), alreadyAdded: true })
          }
          yield* files.keep(received)
          const now = yield* Clock.currentTimeMillis
          const id = crypto.randomUUID()
          const title = details.title.trim()
          const row = yield* db.transaction(() =>
            Effect.gen(function*() {
              yield* db.insert(books).values({
                id,
                title,
                edition: details.edition.trim(),
                official: details.official,
                fileHash: received.hash,
                fileSize: received.size,
                status: "added",
                createdAt: now,
                updatedAt: now
              })
              const job = yield* store.create(BookIntake, { bookId: id, title }, SampleCap)
              return yield* update(id, { jobId: job.id })
            })
          ).pipe(Effect.orDie)
          return new AddedBook({ book: yield* viewOf(row), alreadyAdded: false })
        }).pipe(oneAtATime)

      // Newest first; rowid keeps Books added in the same millisecond in order.
      const list = db.select().from(books).orderBy(desc(books.createdAt), desc(sql`rowid`)).pipe(
        Effect.orDie,
        Effect.flatMap(viewsOf)
      )

      const get = (id: BookId) =>
        Effect.gen(function*() {
          const row = yield* rowOf(id)
          const [proposal] = yield* db.select().from(bookMapProposals).where(eq(bookMapProposals.bookId, id))
            .orderBy(desc(bookMapProposals.createdAt))
            .limit(1)
            .pipe(Effect.orDie)
          const [confirmed] = yield* db.select().from(bookMaps).where(eq(bookMaps.bookId, id))
            .orderBy(desc(bookMaps.version))
            .limit(1)
            .pipe(Effect.orDie)
          return new BookDetail({
            book: yield* viewOf(row),
            proposal: proposal === undefined ? null : new MapProposal({
              ranges: decodeRanges(proposal.ranges),
              model: proposal.model,
              promptVersion: proposal.promptVersion,
              createdAt: proposal.createdAt
            }),
            confirmed: confirmed === undefined ? null : new ConfirmedMap({
              version: confirmed.version,
              ranges: decodeRanges(confirmed.ranges),
              confirmedAt: confirmed.confirmedAt
            })
          })
        })

      // Reads the file again after its reading was cancelled, failed or
      // found the file unreadable.
      const readAgain = (id: BookId) =>
        Effect.gen(function*() {
          const row = yield* rowOf(id)
          const job = yield* jobOf(row)
          const settled = job === undefined || job.status === "failed" || job.status === "cancelled" ||
            job.status === "done"
          if ((row.status !== "added" && row.status !== "unreadable") || !settled) {
            return yield* new BookNotReady({ status: row.status as BookStatus })
          }
          if (job?.status === "failed") yield* store.cancel(JobId.make(job.id)).pipe(Effect.ignore)
          const updated = yield* db.transaction(() =>
            Effect.gen(function*() {
              const next = yield* store.create(BookIntake, { bookId: row.id, title: row.title }, SampleCap)
              return yield* update(row.id, { status: "added", note: null, jobId: next.id })
            })
          ).pipe(Effect.orDie)
          return yield* viewOf(updated)
        }).pipe(oneAtATime)

      // Starts the full run after the cost preview, or again after the
      // Curator cancelled it.
      const start = (id: BookId, spendCap: number) =>
        Effect.gen(function*() {
          const row = yield* rowOf(id)
          const job = yield* jobOf(row)
          const restart = row.status === "mapping" && (job === undefined || job.status === "cancelled")
          if (row.status !== "previewed" && !restart) {
            return yield* new BookNotReady({ status: row.status as BookStatus })
          }
          const llm = yield* settings.llm
          const missing = missingSettings(llm, Option.isSome(yield* keys.read), "book-map")
          if (missing.length > 0) return yield* new LlmNotConfigured({ missing })

          // Scanned pages follow the extraction model chosen now.
          const route = scannedRouteFor(taskReadsImages(llm, "extraction"))
          const [left] = yield* db.select({ pages: count() }).from(bookPages)
            .where(and(eq(bookPages.bookId, row.id), eq(bookPages.hasText, true), isNull(bookPages.survey)))
            .pipe(Effect.orDie)
          const batches = Math.ceil((left?.pages ?? 0) / PagesPerBatch)
          const updated = yield* db.transaction(() =>
            Effect.gen(function*() {
              yield* db.update(bookPages).set({ route })
                .where(and(eq(bookPages.bookId, row.id), eq(bookPages.hasText, false)))
              const next = yield* store.create(BookMapping, { bookId: row.id, title: row.title, batches }, spendCap)
              return yield* update(row.id, {
                status: "mapping",
                jobId: next.id,
                scannedRoute: row.scannedRoute === null ? null : route
              })
            })
          ).pipe(Effect.orDie)
          return yield* viewOf(updated)
        }).pipe(oneAtATime)

      const confirmMap = (id: BookId, ranges: ReadonlyArray<MapRangeInput>) =>
        Effect.gen(function*() {
          const row = yield* rowOf(id)
          if (!Mappable.has(row.status) || row.pageCount === null) {
            return yield* new BookNotReady({ status: row.status as BookStatus })
          }
          const problems = mapProblems(ranges, row.pageCount)
          if (problems.length > 0) return yield* new BookMapInvalid({ problems })
          const now = yield* Clock.currentTimeMillis
          yield* db.transaction(() =>
            Effect.gen(function*() {
              const [latest] = yield* db.select({ version: max(bookMaps.version) }).from(bookMaps)
                .where(eq(bookMaps.bookId, row.id))
              yield* db.insert(bookMaps).values({
                bookId: row.id,
                version: (latest?.version ?? 0) + 1,
                ranges: encodeRanges(tidyMap(ranges).map((range) => new MapRange(range))),
                confirmedAt: now
              })
              yield* update(row.id, { status: "mapped" })
            })
          ).pipe(Effect.orDie)
          return yield* get(id)
        }).pipe(oneAtATime)

      const fileOf = (id: BookId) =>
        rowOf(id).pipe(Effect.map((row) => ({ path: files.pathOf(row.fileHash), title: row.title })))

      return Books.of({ add, list, get, readAgain, start, confirmMap, fileOf })
    })
  )
}
