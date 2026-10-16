import { and, eq, inArray, sql } from "drizzle-orm"
import { Clock, Effect, Schema } from "effect"
import { CostPreview, type PageRoute } from "../../api/Books.ts"
import { formatDollars } from "../../api/money.ts"
import { Db } from "../db/Database.ts"
import { bookPages, books } from "../db/schema.ts"
import { type JobKind, JobStepFailed } from "../jobs/JobKind.ts"
import { Settings, taskReadsImages } from "../settings/Settings.ts"
import { BookFiles } from "./BookFiles.ts"
import { hasTextLayer, readPdfPages, unreadableNote } from "./pdf.ts"
import { surveyPages } from "./survey.ts"

// Reading a Book that was just added: its pages, a hundred per step, then
// the cost preview from a 10-page sample read by the Book Map model. The
// full run waits for the Curator after this.

export const PagesPerStep = 100
export const SamplePages = 10

// Dollars the sample may spend unless the Curator raises it.
export const SampleCap = 0.5

const Params = Schema.Struct({ bookId: Schema.String, title: Schema.String })

const Checkpoint = Schema.Struct({
  // The next page to read; past the last page once all are read.
  nextPage: Schema.Int,
  sampling: Schema.Boolean
})

// Up to n items spread evenly through the list, first to last.
export const spread = <A>(items: ReadonlyArray<A>, n: number): ReadonlyArray<A> =>
  items.length <= n ? items : Array.from({ length: n }, (_, i) => items[Math.floor((i + 0.5) * items.length / n)]!)

// How a page with no text layer is read: as an image when the extraction
// model can read images, otherwise by the Curator in the Review Queue.
export const scannedRouteFor = (readsImages: boolean): PageRoute => (readsImages ? "image" : "review")

const readStep = (bookId: string, nextPage: number) =>
  Effect.gen(function*() {
    const db = yield* Db
    const files = yield* BookFiles
    const settings = yield* Settings
    const [book] = yield* db.select().from(books).where(eq(books.id, bookId)).pipe(Effect.orDie)
    if (book === undefined) return { _tag: "Finished", result: "The Book was removed before it was read." } as const

    const reading = yield* Effect.result(readPdfPages(yield* files.read(book.fileHash), nextPage, nextPage + PagesPerStep - 1))
    const now = yield* Clock.currentTimeMillis
    if (reading._tag === "Failure") {
      const note = unreadableNote(reading.failure)
      yield* db.update(books).set({ status: "unreadable", note, updatedAt: now }).where(eq(books.id, bookId)).pipe(
        Effect.orDie
      )
      return yield* new JobStepFailed({ message: note })
    }

    const { pageCount, pages } = reading.success
    const scannedRoute = scannedRouteFor(taskReadsImages(yield* settings.llm, "extraction"))
    if (pages.length > 0) {
      yield* db.insert(bookPages)
        .values(pages.map((page) => {
          const hasText = hasTextLayer(page.text)
          return { bookId, number: page.number, text: page.text, hasText, route: hasText ? "text" : scannedRoute }
        }))
        .onConflictDoUpdate({
          target: [bookPages.bookId, bookPages.number],
          set: { text: sql`excluded.text`, hasText: sql`excluded.has_text`, route: sql`excluded.route` }
        })
        .pipe(Effect.orDie)
    }
    const stepsTotal = Math.ceil(pageCount / PagesPerStep) + 1
    const lastRead = pages.at(-1)?.number ?? pageCount
    if (lastRead < pageCount) {
      return {
        _tag: "Continue",
        checkpoint: { nextPage: lastRead + 1, sampling: false },
        stepsTotal,
        note: `Read ${lastRead} of ${pageCount} pages`
      } as const
    }

    const [counts] = yield* db.select({
      text: sql<number>`coalesce(sum(case when ${bookPages.hasText} then 1 else 0 end), 0)`,
      scanned: sql<number>`coalesce(sum(case when ${bookPages.hasText} then 0 else 1 end), 0)`
    }).from(bookPages).where(eq(bookPages.bookId, bookId)).pipe(Effect.orDie)
    yield* db.update(books)
      .set({
        pageCount,
        textPages: counts?.text ?? 0,
        scannedRoute: (counts?.scanned ?? 0) > 0 ? scannedRoute : null,
        updatedAt: now
      })
      .where(eq(books.id, bookId))
      .pipe(Effect.orDie)
    return {
      _tag: "Continue",
      checkpoint: { nextPage: pageCount + 1, sampling: true },
      stepsTotal,
      note: `Read all ${pageCount} pages; the Book Map model is reading a sample of ${SamplePages}`
    } as const
  })

const sampleStep = (jobId: string, bookId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const textPages = yield* db.select({ number: bookPages.number }).from(bookPages)
      .where(and(eq(bookPages.bookId, bookId), eq(bookPages.hasText, true)))
      .orderBy(bookPages.number)
      .pipe(Effect.orDie)
    const sample = spread(textPages.map((page) => page.number), SamplePages)
    const finish = (preview: CostPreview, result: string) =>
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        const encoded = Schema.encodeSync(Schema.fromJsonString(CostPreview))(preview)
        yield* db.update(books).set({ status: "previewed", preview: encoded, note: null, updatedAt: now })
          .where(eq(books.id, bookId)).pipe(Effect.orDie)
        return { _tag: "Finished", result } as const
      })

    const [first, ...rest] = sample
    if (first === undefined) {
      return yield* finish(
        new CostPreview({
          model: "",
          sampledPages: [],
          sampleTokens: 0,
          sampleCost: 0,
          projectedPages: 0,
          projectedTokens: 0,
          projectedCost: 0
        }),
        "No page has a text layer, so there was nothing to sample."
      )
    }
    const rows = yield* db.select({ number: bookPages.number, text: bookPages.text }).from(bookPages)
      .where(and(eq(bookPages.bookId, bookId), inArray(bookPages.number, [first, ...rest])))
      .orderBy(bookPages.number)
      .pipe(Effect.orDie)
    const [firstRow, ...otherRows] = rows
    if (firstRow === undefined) return yield* new JobStepFailed({ message: "The sampled pages could not be found." })
    const surveyed = yield* surveyPages({ jobId, pages: [firstRow, ...otherRows], chapterBefore: null })
    for (const [number, survey] of surveyed.surveys) {
      yield* db.update(bookPages).set({ survey: JSON.stringify(survey) })
        .where(and(eq(bookPages.bookId, bookId), eq(bookPages.number, number)))
        .pipe(Effect.orDie)
    }
    // The full run reads the other pages with text, at the sample's rate.
    const remaining = textPages.length - sample.length
    const projectedTokens = Math.round(surveyed.tokens / sample.length * remaining)
    const projectedCost = surveyed.cost / sample.length * remaining
    return yield* finish(
      new CostPreview({
        model: surveyed.model,
        sampledPages: sample,
        sampleTokens: surveyed.tokens,
        sampleCost: surveyed.cost,
        projectedPages: remaining,
        projectedTokens,
        projectedCost
      }),
      `Sampled ${sample.length} pages for ${formatDollars(surveyed.cost)}. The full run reads ${remaining} more: about ${
        projectedTokens.toLocaleString("en-US")
      } tokens, ${formatDollars(projectedCost)}.`
    )
  })

export const BookIntake: JobKind<typeof Params.Type, typeof Checkpoint.Type> = {
  kind: "book-intake",
  params: Params,
  checkpoint: Checkpoint,
  label: (params) => `Reading ${params.title}`,
  start: () => ({ nextPage: 1, sampling: false }),
  stepsTotal: () => null,
  step: ({ jobId, params, checkpoint }) =>
    checkpoint.sampling ? sampleStep(jobId, params.bookId) : readStep(params.bookId, checkpoint.nextPage)
}
