import { describe, expect, test } from "bun:test"
import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import type { BatchView, GeneratedQuestionType } from "../src/api/Generation.ts"
import { skillsFor } from "../src/api/taxonomyRules.ts"
import { Db } from "../src/server/db/Database.ts"
import { datasets, parts, questions, statementPredicates, stimuli } from "../src/server/db/schema.ts"
import { AppConfig } from "../src/server/AppConfig.ts"
import { GenerationBatch } from "../src/server/generation/batchJob.ts"
import { JobKinds } from "../src/server/jobs/JobKind.ts"
import { AllJobKinds } from "../src/server/jobs/kinds/index.ts"
import { FakeLlm, LlmTransport } from "../src/server/llm/LlmTransport.ts"
import { workerServices } from "../src/server/worker/services.ts"
import { ApiKeyStore } from "../src/server/settings/ApiKeyStore.ts"
import { Settings } from "../src/server/settings/Settings.ts"
import { type Curator, curatorBrowser } from "./bookFlow.ts"
import { type FakeGeneration, giItem, makeFakeGenerationModel, msrItem, taItem, tpaItem } from "./fakeGenerationModel.ts"
import { advanceUntil, runWithWorker } from "./harness.ts"

const tasks = ["generation", "statement-translation", "tagging", "solving", "approaches"] as const

const configure = (fake: FakeGeneration = {}) =>
  Effect.gen(function*() {
    yield* (yield* Settings).saveLlm({
      baseUrl: "https://api.example.com/v1",
      jsonMode: "json-schema",
      models: tasks.map((task) => ({ task, model: "text-model" })),
      prices: [{ model: "text-model", inputPerMillion: 2, outputPerMillion: 8 }],
      readsImages: []
    })
    yield* (yield* ApiKeyStore).save("sk-test-12345678")
    yield* (yield* FakeLlm).respondWith(makeFakeGenerationModel(fake))
  })

// The first Skill the Taxonomy has for a Question Type.
const skillFor = (curator: Curator, questionType: GeneratedQuestionType) =>
  curator.api.bank.taxonomy().pipe(Effect.map((taxonomy) => skillsFor(taxonomy, questionType)[0]!.id))

// Starts a batch and waits for its job to end.
const generate = (curator: Curator, questionType: GeneratedQuestionType, count = 1) =>
  Effect.gen(function*() {
    const started = yield* curator.api.generation.start({
      payload: { questionType, skill: yield* skillFor(curator, questionType), band: "medium", count, spendCap: 1 }
    })
    return yield* advanceUntil(
      curator.api.generation.batches().pipe(Effect.map((batches) => {
        const batch = batches.find((each) => each.id === started.id)
        return batch?.job?.status === "done" ? batch : undefined
      })),
      { step: "200 millis", maxSteps: 3000 }
    )
  })

// A batch's Questions with their Parts' keys, in the order they were written.
const batchQuestions = (batch: BatchView) =>
  Effect.gen(function*() {
    const db = yield* Db
    const rows = yield* db.select().from(questions).where(eq(questions.batchId, batch.id))
      .orderBy(asc(questions.createdAt), asc(sql`${questions}.rowid`)).pipe(Effect.orDie)
    const partRows = rows.length === 0 ? [] : yield* db.select().from(parts)
      .where(inArray(parts.questionId, rows.map((row) => row.id))).orderBy(asc(parts.position)).pipe(Effect.orDie)
    return rows.map((row) => {
      const own = partRows.filter((part) => part.questionId === row.id)
      return { ...row, keys: own.map((part) => part.key).join(","), bases: own.map((part) => part.keyBasis), partIds: own.map((part) => part.id) }
    })
  })

// The predicates kept for a Question's Parts, in the Parts' order.
const keptFor = (partIds: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const db = yield* Db
    const rows = yield* db.select().from(statementPredicates).where(inArray(statementPredicates.partId, [...partIds]))
      .pipe(Effect.orDie)
    return rows.toSorted((a, b) => partIds.indexOf(a.partId) - partIds.indexOf(b.partId))
  })

describe("A generation batch", () => {
  test("keys each Table Analysis statement by code, reads it again, and publishes it, with a quarter in the Mock Reserve", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure()
        const curator = yield* curatorBrowser
        const batch = yield* generate(curator, "di.ta", 4)
        expect(batch).toMatchObject({ number: 1, questions: 4, published: 4, held: 0, failed: 0, reserved: 1 })
        const written = yield* batchQuestions(batch)
        expect(written.map((row) => [row.keys, row.batchItem, row.status])).toEqual([
          ["A,A,B", 1, "published"],
          ["A,A,B", 2, "published"],
          ["A,A,B", 3, "published"],
          ["A,A,B", 4, "published"]
        ])
        expect(written[0]!.bases).toEqual(["computed", "computed", "computed"])
        const db = yield* Db
        const kept = yield* keptFor(written[0]!.partIds)
        expect(kept.map((row) => [row.kind, row.result, row.secondResult])).toEqual([
          ["computed", "yes", "yes"],
          ["computed", "yes", "yes"],
          ["computed", "no", "no"]
        ])
        const [table] = yield* db.select({ kind: stimuli.kind, origin: datasets.origin }).from(stimuli)
          .innerJoin(datasets, eq(datasets.id, stimuli.datasetId))
          .where(eq(stimuli.id, written[0]!.stimulusId!)).pipe(Effect.orDie)
        expect(table).toEqual({ kind: "table", origin: "generator" })
        // The second item was told what the first was about.
        const requests = yield* (yield* FakeLlm).requests
        const second = requests.filter((request) => (request.messages[0]?.content ?? "").includes("Write one Table Analysis question"))[1]!
        expect(second.messages.find((message) => message.role === "user")?.content).toContain(
          "- The table shows each region's sales, growth over the year and number of stores."
        )
      }),
      AllJobKinds
    ), 120_000)

  test("keys a Graphics Interpretation blank by the option the value fits, and draws its chart from its Dataset", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure()
        const curator = yield* curatorBrowser
        const batch = yield* generate(curator, "di.gi")
        const [question] = yield* batchQuestions(batch)
        expect(question).toMatchObject({ keys: "B,C", status: "published" })
        const db = yield* Db
        const [chart] = yield* db.select().from(stimuli).where(eq(stimuli.id, question!.stimulusId!)).pipe(Effect.orDie)
        expect(chart!.kind).toBe("chart")
        expect(JSON.parse(chart!.chartSpec!)).toMatchObject({
          data: { name: "dataset" },
          mark: "bar",
          encoding: { x: { field: "Year" }, y: { field: "Visitors" } }
        })
        const kept = yield* keptFor(question!.partIds)
        expect(kept.map((row) => [row.result, row.approximate])).toEqual([["50", true], ["2020", false]])
      }),
      AllJobKinds
    ), 120_000)

  test("keys a Two-Part Analysis by the one pair of options that meets every condition", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure()
        const curator = yield* curatorBrowser
        const [question] = yield* batchQuestions(yield* generate(curator, "di.tpa"))
        expect(question).toMatchObject({ keys: "C,B", status: "published", bases: ["computed", "computed"] })
      }),
      AllJobKinds
    ), 120_000)

  test("writes an MSR set of three Questions on shared tabs, and holds an inference from text for the Curator", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure()
        const curator = yield* curatorBrowser
        const batch = yield* generate(curator, "di.msr")
        expect(batch).toMatchObject({ questions: 3, published: 2, held: 1 })
        const written = yield* batchQuestions(batch)
        expect(written.map((row) => row.keys)).toEqual(["A,B,A", "A,B,B", "A,A,B"])
        expect(new Set(written.map((row) => row.stimulusId)).size).toBe(1)
        expect(written[0]!.bases).toEqual(["computed", "computed", "generator"])
        const db = yield* Db
        const tabs = yield* db.select({ kind: stimuli.kind, title: stimuli.title }).from(stimuli)
          .where(eq(stimuli.parentId, written[0]!.stimulusId!)).orderBy(asc(stimuli.position)).pipe(Effect.orDie)
        expect(tabs).toEqual([
          { kind: "passage", title: "Policy" },
          { kind: "table", title: "Loans" },
          { kind: "passage", title: "Survey" }
        ])
        // The inference waits for the Curator, whose solves agree with it.
        const [item] = yield* curator.api.review.list()
        expect(item!.question?.generated).toEqual({ batch: 1, item: 1, question: 1 })
        expect(item!.reasons).toEqual([{
          code: "inference",
          detail: "Statement 3 is an inference from the text that code cannot check; its three solves agree with its key, A. Publish it once you have checked it."
        }])
        yield* curator.api.review.publish({ params: { id: item!.id } })
        const [first] = yield* batchQuestions(batch)
        expect(first!.status).toBe("published")
      }),
      AllJobKinds
    ), 120_000)

  test("does not let the Curator publish an inference its solves do not confirm", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure({ solve: (stem) => (stem === msrItem.questions[0]!.intro ? "A,B,B" : undefined) })
        const curator = yield* curatorBrowser
        yield* generate(curator, "di.msr")
        const [item] = yield* curator.api.review.list()
        expect(item!.reasons.map((reason) => reason.code)).toEqual(["solver-disagreement", "inference-unconfirmed"])
        const refused = yield* curator.api.review.publish({ params: { id: item!.id } }).pipe(Effect.flip)
        expect(refused).toMatchObject({ _tag: "CannotPublish" })
      }),
      AllJobKinds
    ), 120_000)

  test("holds a statement whose second reading disagrees, until the Curator sets its key", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure({ disagree: new Set([taItem.statements[1]!.text]) })
        const curator = yield* curatorBrowser
        const batch = yield* generate(curator, "di.ta")
        expect(batch).toMatchObject({ published: 0, held: 1 })
        const [item] = yield* curator.api.review.list()
        expect(item!.reasons).toEqual([{
          code: "predicate-disagreement",
          detail: "Statement 2: its predicate gives yes, but a second reading of its words gives no."
        }])
        // Having read the statement, the Curator keeps the computed key.
        yield* curator.api.review.overrideKey({
          params: { id: item!.id },
          payload: { part: 1, key: "A", reason: "The statement asks about the top region by sales." }
        })
        const [question] = yield* advanceUntil(
          batchQuestions(batch).pipe(Effect.map((rows) => (rows[0]?.status === "published" ? rows : undefined))),
          { step: "200 millis", maxSteps: 3000 }
        )
        expect(question!.bases).toEqual(["computed", "override", "computed"])
      }),
      AllJobKinds
    ), 120_000)

  test("holds a blank, and a Two-Part Analysis, whose second reading gives another result", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure({ disagree: new Set([giItem.blanks[0]!.text, tpaItem.intro]) })
        const curator = yield* curatorBrowser
        yield* generate(curator, "di.gi")
        yield* generate(curator, "di.tpa")
        const details = (yield* curator.api.review.list()).flatMap((item) => item.reasons.map((reason) => reason.detail))
        expect(details).toEqual([
          "Blank 1: its predicate gives 50, but a second reading of its words gives 1.5.",
          "The columns: their predicates are met by C and B, but a second reading of the problem is met by C and E."
        ])
      }),
      AllJobKinds
    ), 120_000)

  test("asks again for an item that breaks a rule, and counts one still broken as failed", () =>
    runWithWorker(
      Effect.gen(function*() {
        const short = { ...taItem, statements: taItem.statements.slice(0, 2) }
        let fixedOnRetry = true
        yield* configure({ reply: (_, attempt) => (attempt === 1 || !fixedOnRetry ? short : undefined) })
        const curator = yield* curatorBrowser
        const fixed = yield* generate(curator, "di.ta")
        expect(fixed).toMatchObject({ questions: 1, published: 1, failed: 0 })
        const retry = (yield* (yield* FakeLlm).requests).find((request) =>
          (request.messages.find((message) => message.role === "user")?.content ?? "").includes("Your last reply broke these rules")
        )
        expect(retry?.messages.find((message) => message.role === "user")?.content).toContain(
          "- There are 2 statements; write exactly 3."
        )
        fixedOnRetry = false
        const broken = yield* generate(curator, "di.ta")
        expect(broken).toMatchObject({ questions: 0, failed: 1 })
        expect(broken.job?.result).toBe("0 Questions published, 0 held in the Review Queue; 0 joined the Mock Reserve. 1 item could not be made valid.")
      }),
      AllJobKinds
    ), 120_000)

  test("needs a Skill of its Question Type, and the models it uses", () =>
    runWithWorker(
      Effect.gen(function*() {
        const curator = yield* curatorBrowser
        const start = (skill: string) =>
          curator.api.generation.start({ payload: { questionType: "di.ta", skill, band: "hard", count: 2, spendCap: 1 } }).pipe(
            Effect.flip
          )
        expect(yield* start("di.sufficiency.value")).toMatchObject({ _tag: "SkillNotForType" })
        expect(yield* start("di.displays.tables")).toMatchObject({ _tag: "LlmNotConfigured" })
        expect(yield* curator.api.generation.batches()).toEqual([])
        const db = yield* Db
        expect(yield* db.select().from(questions).where(and(eq(questions.section, "di"))).pipe(Effect.orDie)).toEqual([])
      }),
      AllJobKinds
    ), 120_000)
})

// The worker's services, for running a job's step by hand as a worker does
// after a restart from the same checkpoint.
const stepServices = Effect.gen(function*() {
  const transport = yield* LlmTransport
  const config = yield* AppConfig
  return workerServices(Layer.succeed(LlmTransport, transport), JobKinds.layer(AllJobKinds)).pipe(
    Layer.provide(Layer.succeed(AppConfig, config))
  )
})

describe("Repeats, the Mock Reserve and steps run again", () => {
  test("an MSR set whose inference waits for the Curator still joins the Mock Reserve whole", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure()
        const curator = yield* curatorBrowser
        // Four sets, each with an inference held: two published Questions a set.
        const batch = yield* generate(curator, "di.msr", 4)
        expect(batch).toMatchObject({ questions: 12, published: 8, held: 4, reserved: 2 })
        for (const item of yield* curator.api.review.list()) {
          yield* curator.api.review.publish({ params: { id: item.id } })
        }
        const after = (yield* curator.api.generation.batches()).find((each) => each.id === batch.id)!
        // The set in the Reserve takes in its third Question; the others stay out.
        expect(after).toMatchObject({ published: 12, held: 0, reserved: 3 })
      }),
      AllJobKinds
    ), 300_000)

  test("an item the generator writes again waits as a near match of the first", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure({ reply: (type) => (type === "di.ta" ? taItem : undefined) })
        const curator = yield* curatorBrowser
        const batch = yield* generate(curator, "di.ta", 2)
        expect(batch).toMatchObject({ questions: 2, published: 1, held: 1 })
        const [first, second] = yield* batchQuestions(batch)
        expect(second!.relatedQuestionId).toBe(first!.id)
        const [held] = yield* curator.api.review.list()
        expect(held!.reasons).toEqual([{
          code: "near-match",
          detail: "It has the same words and data as another Question: the same Question, or a Variant?"
        }])
      }),
      AllJobKinds
    ), 120_000)

  test("small batches add up to a quarter of their type's Questions in the Mock Reserve", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure()
        const curator = yield* curatorBrowser
        const ones = [
          yield* generate(curator, "di.gi"),
          yield* generate(curator, "di.gi"),
          yield* generate(curator, "di.gi"),
          yield* generate(curator, "di.gi")
        ]
        expect(ones.map((batch) => batch.published)).toEqual([1, 1, 1, 1])
        expect(ones.reduce((sum, batch) => sum + batch.reserved, 0)).toBe(1)
      }),
      AllJobKinds
    ), 300_000)

  test("a step run again after a stop counts its failed item once, and says what joined the Mock Reserve", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure()
        const curator = yield* curatorBrowser
        const done = yield* generate(curator, "di.ta", 4)
        expect(done.reserved).toBe(1)
        const services = yield* stepServices
        const again = yield* GenerationBatch.step({
          jobId: done.job!.id,
          params: { batchId: done.id },
          checkpoint: { stage: "enrich", item: 5, failed: 0 },
          stepsDone: 10
        }).pipe(Effect.provide(services))
        expect(again).toMatchObject({ _tag: "Finished", result: expect.stringContaining("1 joined the Mock Reserve") })
        // An item that cannot be made valid, its step run twice.
        yield* (yield* FakeLlm).respondWith(makeFakeGenerationModel({
          reply: (type) => (type === "di.ta" ? { ...taItem, statements: taItem.statements.slice(0, 2) } : undefined)
        }))
        const started = yield* curator.api.generation.start({
          payload: { questionType: "di.ta", skill: yield* skillFor(curator, "di.ta"), band: "medium", count: 1, spendCap: 1 }
        })
        yield* advanceUntil(
          curator.api.generation.batches().pipe(Effect.map((batches) => {
            const batch = batches.find((each) => each.id === started.id)
            return batch?.job?.status === "done" ? batch : undefined
          })),
          { step: "200 millis", maxSteps: 3000 }
        )
        const step = GenerationBatch.step({
          jobId: started.job!.id,
          params: { batchId: started.id },
          checkpoint: { stage: "generate", item: 1, failed: 0 },
          stepsDone: 0
        }).pipe(Effect.provide(services))
        yield* step
        yield* step
        const view = (yield* curator.api.generation.batches()).find((each) => each.id === started.id)!
        expect(view).toMatchObject({ count: 1, failed: 1, questions: 0 })
      }),
      AllJobKinds
    ), 180_000)

  test("a reply the generator cannot get into shape says why in the note", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure({ reply: (type) => (type === "di.ta" ? { intro: 5 } : undefined) })
        const curator = yield* curatorBrowser
        const started = yield* curator.api.generation.start({
          payload: { questionType: "di.ta", skill: yield* skillFor(curator, "di.ta"), band: "medium", count: 1, spendCap: 1 }
        })
        const services = yield* stepServices
        const step = yield* GenerationBatch.step({
          jobId: started.job!.id,
          params: { batchId: started.id },
          checkpoint: { stage: "generate", item: 1, failed: 0 },
          stepsDone: 0
        }).pipe(Effect.provide(services))
        expect(step).toMatchObject({ _tag: "Continue", note: expect.stringMatching(/^Item 1 of 1 could not be made valid: \S/) })
      }),
      AllJobKinds
    ), 120_000)

  test("a Two-Part Analysis disagreement stays until both columns are overridden", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure({ disagree: new Set([tpaItem.intro]) })
        const curator = yield* curatorBrowser
        yield* generate(curator, "di.tpa")
        // Each override sends the Question back through the Publish Gate;
        // the next waits for it to be held again.
        const override = (part: number, key: string) =>
          Effect.gen(function*() {
            const [item] = yield* advanceUntil(
              curator.api.review.list().pipe(Effect.map((items) => (items.length > 0 ? items : undefined))),
              { step: "200 millis", maxSteps: 3000 }
            )
            return yield* curator.api.review.overrideKey({
              params: { id: item!.id },
              payload: { part, key, reason: "Checked against the table." }
            })
          })
        const first = yield* override(1, "B")
        expect(first.question?.parts[1]).toMatchObject({ key: "B", keyBasis: "override" })
        const db = yield* Db
        const reasonsOf = (id: string) =>
          db.select({ linkReasons: questions.linkReasons }).from(questions).where(eq(questions.id, id)).pipe(
            Effect.orDie,
            Effect.map(([row]) => (JSON.parse(row!.linkReasons) as Array<{ code: string }>).map((reason) => reason.code))
          )
        expect(yield* reasonsOf(first.question!.id)).toEqual(["predicate-disagreement"])
        const both = yield* override(0, "C")
        expect(yield* reasonsOf(both.question!.id)).toEqual([])
      }),
      AllJobKinds
    ), 120_000)
})
