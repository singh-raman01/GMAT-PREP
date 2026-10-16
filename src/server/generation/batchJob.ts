import { and, asc, count, eq, inArray, lt, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { DifficultyBand } from "../../api/difficulty.ts"
import { enrichQuestion } from "../books/enrichment.ts"
import { contents, datasetOfDraft, type Reason } from "../books/linking.ts"
import { renderChart } from "../charts/charts.ts"
import { Db } from "../db/Database.ts"
import { generationBatches, questions } from "../db/schema.ts"
import type { JobKind } from "../jobs/JobKind.ts"
import { runGate } from "../review/gate.ts"
import { assignReserveFor, assignUndecided } from "../review/reserve.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { generateItem, readAgain } from "./generate.ts"
import type { DraftItem } from "./items.ts"
import { type GeneratedType, GeneratedTypes } from "./prompts.ts"
import { writeItem } from "./write.ts"

// A generation batch's job: each item is written by the generator, keyed by
// code, read a second time, and stored as drafts, one item a step; then each
// draft is enriched and put through the Publish Gate, one a step. Last, a
// quarter of the batch joins the Mock Reserve (ADR 0003, ADR 0008).

const Params = Schema.Struct({ batchId: Schema.String })

const Checkpoint = Schema.Struct({
  stage: Schema.Literals(["generate", "enrich"]),
  // The next item to write, from 1.
  item: Schema.Int
})

// Dollars a batch may spend unless the Curator sets a cap.
export const GenerationCap = 2

const batchOf = (batchId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const [batch] = yield* db.select().from(generationBatches).where(eq(generationBatches.id, batchId)).pipe(Effect.orDie)
    return batch
  })

// What earlier items were about, so the generator picks other topics.
const earlierTopics = (batchId: string, item: number) =>
  Effect.gen(function*() {
    const db = yield* Db
    const rows = yield* db.selectDistinct({ item: questions.batchItem, stem: questions.stem }).from(questions)
      .where(and(eq(questions.batchId, batchId), lt(questions.batchItem, item)))
      .orderBy(asc(questions.batchItem))
      .pipe(Effect.orDie)
    const firstOfEach = new Map<number, string>()
    for (const row of rows) if (!firstOfEach.has(row.item ?? 0)) firstOfEach.set(row.item ?? 0, row.stem)
    return [...firstOfEach.values()].map((stem) => stem.split(/(?<=[.?!])\s/)[0]!.slice(0, 160))
  })

// A chart the server cannot draw holds its Questions.
const chartChecks = (item: DraftItem) =>
  Effect.gen(function*() {
    const checks: Array<Reason> = []
    for (const content of contents(item.stimulus)) {
      if (content.kind !== "chart") continue
      const failed = yield* renderChart(content.spec, datasetOfDraft(content.table)).pipe(
        Effect.as(undefined),
        Effect.catchTag("ChartRenderFailed", (error) => Effect.succeed(error.detail))
      )
      if (failed !== undefined) checks.push({ code: "render", detail: `The chart does not draw: ${failed}` })
    }
    return checks
  })

const generateStep = (jobId: string, batchId: string, item: number) =>
  Effect.gen(function*() {
    const db = yield* Db
    const batch = yield* batchOf(batchId)
    if (batch === undefined) return { _tag: "Finished", result: "The batch is gone." } as const
    if (item > batch.count) {
      return { _tag: "Continue", checkpoint: { stage: "enrich", item }, stepsTotal: null, note: "Checking each Question" } as const
    }
    const next = { stage: "generate" as const, item: item + 1 }
    // A step run again after a stop finds its item already written.
    const [written] = yield* db.select({ n: count() }).from(questions)
      .where(and(eq(questions.batchId, batchId), eq(questions.batchItem, item))).pipe(Effect.orDie)
    if ((written?.n ?? 0) > 0) return { _tag: "Continue", checkpoint: next, stepsTotal: null, note: null } as const
    const taxonomy = (yield* Taxonomy).view
    const spec = {
      questionType: batch.questionType as GeneratedType,
      skill: batch.skill,
      band: batch.band as DifficultyBand,
      count: batch.count
    }
    const generated = yield* generateItem(jobId, taxonomy, spec, item, yield* earlierTopics(batchId, item))
    if ("failed" in generated) {
      yield* db.update(generationBatches).set({ failed: sql`${generationBatches.failed} + 1` })
        .where(eq(generationBatches.id, batchId)).pipe(Effect.orDie)
      return {
        _tag: "Continue",
        checkpoint: next,
        stepsTotal: null,
        note: `Item ${item} of ${batch.count} could not be made valid: ${generated.failed.slice(0, 2).join(" ")}`
      } as const
    }
    const checks = yield* chartChecks(generated.item)
    const seconds = yield* readAgain(jobId, generated.item)
    yield* db.transaction(() =>
      writeItem({
        batchId,
        itemNumber: item,
        item: generated.item,
        generator: { model: generated.model, promptVersion: generated.promptVersion },
        seconds,
        checks
      })
    ).pipe(Effect.orDie)
    return {
      _tag: "Continue",
      checkpoint: next,
      stepsTotal: null,
      note: `Wrote item ${item} of ${batch.count}`
    } as const
  })

const draftsOf = (batchId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const rows = yield* db.select({ id: questions.id }).from(questions)
      .where(and(eq(questions.batchId, batchId), eq(questions.status, "draft")))
      .orderBy(asc(questions.createdAt), asc(sql`${questions}.rowid`))
      .pipe(Effect.orDie)
    return rows.map((row) => row.id)
  })

const enrichStep = (jobId: string, batchId: string, item: number, stepsDone: number) =>
  Effect.gen(function*() {
    const db = yield* Db
    const drafts = yield* draftsOf(batchId)
    const next = drafts[0]
    if (next === undefined) {
      const joined = yield* assignReserveFor({ batchId }).pipe(Effect.orDie)
      // Questions of other origins this batch's checks may have published.
      yield* assignUndecided.pipe(Effect.orDie)
      const own = yield* db.select({ status: questions.status, n: count() }).from(questions)
        .where(and(eq(questions.batchId, batchId), inArray(questions.status, ["published", "held"])))
        .groupBy(questions.status)
        .pipe(Effect.orDie)
      const of = (status: string) => own.find((row) => row.status === status)?.n ?? 0
      const batch = yield* batchOf(batchId)
      const failed = batch?.failed ?? 0
      return {
        _tag: "Finished",
        result: `${of("published")} Questions published, ${of("held")} held in the Review Queue; ${joined} joined the Mock Reserve.${
          failed > 0 ? ` ${failed} ${failed === 1 ? "item" : "items"} could not be made valid.` : ""
        }`
      } as const
    }
    const taxonomy = (yield* Taxonomy).view
    yield* enrichQuestion(jobId, taxonomy, next)
    const outcome = yield* runGate(next, taxonomy).pipe(Effect.orDie)
    return {
      _tag: "Continue",
      checkpoint: { stage: "enrich", item },
      stepsTotal: stepsDone + drafts.length + 1,
      note: `Checked a Question: ${outcome === "published" ? "published" : "held for review"} (${drafts.length - 1} left)`
    } as const
  })

export const GenerationBatch: JobKind<typeof Params.Type, typeof Checkpoint.Type> = {
  kind: "di-generate",
  params: Params,
  checkpoint: Checkpoint,
  label: () => "Generating Data Insights Questions",
  start: () => ({ stage: "generate", item: 1 }),
  stepsTotal: () => null,
  // A batch that ends early still decides the Reserve for what it published.
  stopped: (params) => assignReserveFor({ batchId: params.batchId }).pipe(Effect.orDie, Effect.asVoid),
  step: ({ jobId, params, checkpoint, stepsDone }) =>
    checkpoint.stage === "generate"
      ? generateStep(jobId, params.batchId, checkpoint.item)
      : enrichStep(jobId, params.batchId, checkpoint.item, stepsDone)
}

export const isGeneratedType = (type: string): type is GeneratedType => (GeneratedTypes as ReadonlyArray<string>).includes(type)
