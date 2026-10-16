import { and, eq, inArray, sql } from "drizzle-orm"
import { Clock, Effect, Schema } from "effect"
import { CostPreview, CostStep, type PageRoute } from "../../api/Books.ts"
import { formatDollars } from "../../api/money.ts"
import { Db } from "../db/Database.ts"
import { bookPages, books, llmCalls } from "../db/schema.ts"
import { type JobKind, JobStepFailed } from "../jobs/JobKind.ts"
import { Settings, taskReadsImages } from "../settings/Settings.ts"
import { BookFiles } from "./BookFiles.ts"
import { hasTextLayer, readPdfPages, unreadableNote } from "./pdf.ts"
import { readPage, readsGroup } from "./readings.ts"
import { readSurvey, surveyPages } from "./survey.ts"

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

// Projects a step of the full run from what it took on the sampled pages.
const projectStep = (
  name: string,
  sampled: { readonly pages: number; readonly tokens: number; readonly cost: number },
  remainingPages: number
) =>
  new CostStep({
    name,
    sampledPages: sampled.pages,
    sampleTokens: sampled.tokens,
    sampleCost: sampled.cost,
    projectedPages: remainingPages,
    projectedTokens: sampled.pages === 0 ? 0 : Math.round(sampled.tokens / sampled.pages * remainingPages),
    projectedCost: sampled.pages === 0 ? 0 : sampled.cost / sampled.pages * remainingPages
  })

// The full run on 10 pages spread through the Book: the Book Map model
// surveys them, and the extraction model reads those it can extract. The
// readings are kept for the full run; the surveys only cost the run, since
// the full run surveys those pages again among their neighbours. What the calls took, read back from
// the job's own call records, projects the full run; a repeated step adds
// nothing it did not spend.
const sampleStep = (jobId: string, bookId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const textPages = yield* db.select({ number: bookPages.number }).from(bookPages)
      .where(and(eq(bookPages.bookId, bookId), eq(bookPages.hasText, true)))
      .orderBy(bookPages.number)
      .pipe(Effect.orDie)
    const sample = spread(textPages.map((page) => page.number), SamplePages)
    const now = yield* Clock.currentTimeMillis

    const rows = sample.length === 0 ? [] : yield* db.select({
      number: bookPages.number,
      text: bookPages.text,
      survey: bookPages.survey
    }).from(bookPages)
      .where(and(eq(bookPages.bookId, bookId), inArray(bookPages.number, [...sample])))
      .orderBy(bookPages.number)
      .pipe(Effect.orDie)
    const [firstUnsurveyed, ...otherUnsurveyed] = rows.filter((row) => row.survey === null)
    if (firstUnsurveyed !== undefined) {
      const surveyed = yield* surveyPages({ jobId, pages: [firstUnsurveyed, ...otherUnsurveyed], chapterBefore: null })
      for (const [number, survey] of surveyed.surveys) {
        yield* db.update(bookPages).set({ survey: JSON.stringify({ ...survey, sample: true }) })
          .where(and(eq(bookPages.bookId, bookId), eq(bookPages.number, number)))
          .pipe(Effect.orDie)
      }
    }
    const surveys = yield* db.select({ number: bookPages.number, survey: bookPages.survey }).from(bookPages)
      .where(and(eq(bookPages.bookId, bookId), inArray(bookPages.number, [...sample])))
      .pipe(Effect.orDie)
    const extractable = surveys.flatMap((row) => {
      const survey = readSurvey(row.survey)
      return survey !== null && survey.role !== "other" && survey.group !== null && readsGroup(survey.role, survey.group)
        ? [{ page: row.number, role: survey.role, group: survey.group }]
        : []
    })
    for (const page of extractable) {
      yield* readPage({ jobId, bookId, page: page.page, role: page.role, group: page.group })
    }

    const spent = yield* db.select({
      task: llmCalls.task,
      tokens: sql<number>`coalesce(sum(${llmCalls.tokensIn} + ${llmCalls.tokensOut}), 0)`,
      cost: sql<number>`coalesce(sum(${llmCalls.cost}), 0)`,
      model: sql<string>`max(${llmCalls.model})`
    }).from(llmCalls).where(eq(llmCalls.jobId, jobId)).groupBy(llmCalls.task).pipe(Effect.orDie)
    const of = (task: string) => spent.find((row) => row.task === task) ?? { tokens: 0, cost: 0, model: "" }
    // Pages like the sampled extractable ones, in the same share.
    const extractablePages = sample.length === 0 ? 0 : Math.round(extractable.length / sample.length * textPages.length)
    const steps = [
      // The full run surveys every page with text, the sampled ones again.
      projectStep("Book Map", { pages: sample.length, ...of("book-map") }, textPages.length),
      projectStep(
        "Extraction",
        { pages: extractable.length, ...of("extraction") },
        Math.max(0, extractablePages - extractable.length)
      )
    ]
    const preview = new CostPreview({
      model: of("book-map").model,
      sampledPages: sample,
      sampleTokens: steps.reduce((total, step) => total + step.sampleTokens, 0),
      sampleCost: steps.reduce((total, step) => total + step.sampleCost, 0),
      projectedPages: textPages.length,
      projectedTokens: steps.reduce((total, step) => total + step.projectedTokens, 0),
      projectedCost: steps.reduce((total, step) => total + step.projectedCost, 0),
      steps
    })
    yield* db.update(books)
      .set({
        status: "previewed",
        preview: Schema.encodeSync(Schema.fromJsonString(CostPreview))(preview),
        note: null,
        updatedAt: now
      })
      .where(eq(books.id, bookId))
      .pipe(Effect.orDie)
    return {
      _tag: "Finished",
      result: sample.length === 0
        ? "No page has a text layer, so there was nothing to sample."
        : `Sampled ${sample.length} pages for ${formatDollars(preview.sampleCost)}. The full run would take about ${
          preview.projectedTokens.toLocaleString("en-US")
        } tokens, ${formatDollars(preview.projectedCost)}.`
    } as const
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
