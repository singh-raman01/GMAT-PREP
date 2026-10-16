import { and, count, eq, inArray, sql } from "drizzle-orm"
import { Clock, Effect, Option, Schema } from "effect"
import { CostPreview, CostStep, type PageRoute } from "../../api/Books.ts"
import { formatDollars } from "../../api/money.ts"
import { Db } from "../db/Database.ts"
import { bookPages, books, jobs, llmCalls } from "../db/schema.ts"
import { type JobKind, JobStepFailed } from "../jobs/JobKind.ts"
import { ApiKeyStore } from "../settings/ApiKeyStore.ts"
import { missingSettings, Settings, taskReadsImages } from "../settings/Settings.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { BookFiles } from "./BookFiles.ts"
import { readPdfPages, unreadableNote } from "./pdf.ts"
import { readPage, readsGroup } from "./readings.ts"
import { readSurvey, surveyPages } from "./survey.ts"
import {
  type QuestionText,
  SolverRuns,
  solveQuestion,
  tagQuestion,
  unlessInvalid,
  writeApproaches
} from "./enrichment.ts"

// Reading a Book that was just added: its pages, a hundred per step, then
// the cost preview from the full run tried on a 10-page sample. The full run
// waits for the Curator after this.

export const PagesPerStep = 100
export const SamplePages = 10

// Dollars the sample may spend unless the Curator raises it: room for about
// thirty calls, the survey, extraction and two Questions' enrichment, with
// two-page prompts on a costly model.
export const SampleCap = 3

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
        .values(pages.map((page) => ({
          bookId,
          number: page.number,
          text: page.text,
          hasText: !page.scanned,
          route: page.scanned ? scannedRoute : "text"
        })))
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

// Projects a step of the full run from what it took on the sample: its pages,
// or for enrichment, its Questions.
const projectStep = (
  name: string,
  sampled: { readonly pages: number; readonly tokens: number; readonly cost: number },
  remainingPages: number,
  unit: "page" | "question" = "page",
  costed = true
) =>
  new CostStep({
    name,
    unit,
    sampledPages: sampled.pages,
    sampleTokens: sampled.tokens,
    sampleCost: sampled.cost,
    projectedPages: remainingPages,
    projectedTokens: sampled.pages === 0 ? 0 : Math.round(sampled.tokens / sampled.pages * remainingPages),
    projectedCost: sampled.pages === 0 ? 0 : sampled.cost / sampled.pages * remainingPages,
    costed
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
    const sampledQuestions: Array<QuestionText> = []
    for (const page of extractable) {
      const { reading } = yield* readPage({ jobId, bookId, page: page.page, role: page.role, group: page.group })
      if (reading.role === "questions" && reading.group === "ps") {
        for (const item of reading.value.questions) {
          if (item.retired !== null) continue
          sampledQuestions.push({ questionType: "quant.ps", stem: item.stem, options: item.options, key: null, explanation: null })
        }
      }
    }
    yield* sampleEnrichment(jobId, sampledQuestions)

    // What the sample took across every reading of the Book, since a reading
    // that was cancelled or failed leaves surveys and readings this one reuses.
    const intakeJobs = db.select({ id: jobs.id }).from(jobs)
      .where(and(eq(jobs.kind, "book-intake"), sql`json_extract(${jobs.params}, '$.bookId') = ${bookId}`))
    const spent = yield* db.select({
      task: llmCalls.task,
      tokens: sql<number>`coalesce(sum(${llmCalls.tokensIn} + ${llmCalls.tokensOut}), 0)`,
      cost: sql<number>`coalesce(sum(${llmCalls.cost}), 0)`,
      model: sql<string>`max(${llmCalls.model})`
    }).from(llmCalls).where(inArray(llmCalls.jobId, intakeJobs)).groupBy(llmCalls.task).pipe(Effect.orDie)
    const of = (task: string) => spent.find((row) => row.task === task) ?? { tokens: 0, cost: 0, model: "" }
    // Pages like the sampled extractable ones, in the same share.
    const extractablePages = sample.length === 0 ? 0 : Math.round(extractable.length / sample.length * textPages.length)
    // Questions in the same share of the Book as in the sample.
    const projectedQuestions = sample.length === 0 ? 0 : Math.round(sampledQuestions.length / sample.length * textPages.length)
    const enrichCalls = ["tagging", "solving", "approaches"].map(of)
    // A sample Question's enrichment ends with its Approaches call.
    const [enriched] = yield* db.select({ n: count() }).from(llmCalls)
      .where(and(inArray(llmCalls.jobId, intakeJobs), eq(llmCalls.task, "approaches")))
      .pipe(Effect.orDie)
    const enrichmentCosted = projectedQuestions === 0 || (enriched?.n ?? 0) > 0
    const steps = [
      // The full run surveys every page with text, the sampled ones again.
      projectStep("Book Map", { pages: sample.length, ...of("book-map") }, textPages.length),
      projectStep(
        "Extraction",
        { pages: extractable.length, ...of("extraction") },
        Math.max(0, extractablePages - extractable.length)
      ),
      // Every Question of the full run is enriched; the sample's were only
      // enriched to cost it.
      projectStep(
        "Enrichment",
        {
          pages: enriched?.n ?? 0,
          tokens: enrichCalls.reduce((total, call) => total + call.tokens, 0),
          cost: enrichCalls.reduce((total, call) => total + call.cost, 0)
        },
        projectedQuestions,
        "question",
        enrichmentCosted
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

// Enriches up to two of the sample's Questions, only to cost enrichment: they
// are tagged, solved three times and given Approaches, and the replies are
// not kept. Their key is not known yet, so the first solve's answer stands in.
// Skipped when the enrichment models are not set, so the step is not costed.
// A try of this step that stopped part way picks up at the first Question
// with no Approaches call, doing that one again in full.
const SampleQuestions = 2

const sampleEnrichment = (jobId: string, sampled: ReadonlyArray<QuestionText>) =>
  Effect.gen(function*() {
    const db = yield* Db
    const llm = yield* (yield* Settings).llm
    const hasKey = Option.isSome(yield* (yield* ApiKeyStore).read)
    const ready = (["tagging", "solving", "approaches"] as const).every((task) => missingSettings(llm, hasKey, task).length === 0)
    if (!ready) return
    const [done] = yield* db.select({ n: count() }).from(llmCalls)
      .where(and(eq(llmCalls.jobId, jobId), eq(llmCalls.task, "approaches")))
      .pipe(Effect.orDie)
    const taxonomy = (yield* Taxonomy).view
    for (const question of sampled.slice(done?.n ?? 0, SampleQuestions)) {
      yield* unlessInvalid(tagQuestion(jobId, taxonomy, question))
      const answers: Array<string> = []
      for (let run = 1; run <= SolverRuns; run++) {
        const solve = yield* unlessInvalid(solveQuestion(jobId, question, run))
        if (solve !== undefined) answers.push(solve.value.answer)
      }
      yield* unlessInvalid(writeApproaches(jobId, taxonomy, { ...question, key: answers[0] ?? "A" }, undefined))
    }
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
