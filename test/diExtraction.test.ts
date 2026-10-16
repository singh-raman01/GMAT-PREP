import { describe, expect, test } from "bun:test"
import { asc, eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { BookId } from "../src/api/Books.ts"
import { Db } from "../src/server/db/Database.ts"
import { datasets, options, parts, questions, sources, stimuli } from "../src/server/db/schema.ts"
import { AllJobKinds } from "../src/server/jobs/kinds/index.ts"
import { configure, confirmAndExtract, curatorBrowser, proposedFrom, rangesOf } from "./bookFlow.ts"
import { DiNumbers } from "./fixtures/book.ts"
import { runWithWorker } from "./harness.ts"

// The default fixture's numbering: nine Problem Solving questions and two
// Data Sufficiency ones come first.
const di = DiNumbers(12)

// A Book's own item by number, with its Parts, options and Stimulus.
const itemOf = (bookId: BookId, number: number) =>
  Effect.gen(function*() {
    const db = yield* Db
    const [row] = yield* db.select({ question: questions }).from(sources)
      .innerJoin(questions, eq(questions.id, sources.questionId))
      .where(eq(sources.number, number)).pipe(Effect.orDie)
    const question = row!.question
    const partRows = yield* db.select().from(parts).where(eq(parts.questionId, question.id)).orderBy(asc(parts.position))
      .pipe(Effect.orDie)
    const optionRows = yield* db.select().from(options).where(inArray(options.partId, partRows.map((part) => part.id)))
      .orderBy(asc(options.position)).pipe(Effect.orDie)
    const [stimulus] = question.stimulusId === null
      ? []
      : yield* db.select().from(stimuli).where(eq(stimuli.id, question.stimulusId)).pipe(Effect.orDie)
    return {
      question,
      parts: partRows.map((part) => ({
        kind: part.kind,
        prompt: part.prompt,
        key: part.key,
        options: optionRows.filter((option) => option.partId === part.id).map((option) => option.text)
      })),
      stimulus,
      bookId
    }
  })

describe("Extracting Data Insights Questions", () => {
  test("each type becomes a Question with its Parts, keys and Stimulus, and a figure is kept as its page band", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedFrom(curator, { edition: "First edition", di: true })
        const id = proposed.book.id
        const extracted = yield* confirmAndExtract(curator, id, rangesOf(proposed))
        expect(extracted.book.report).toMatchObject({ extracted: 16 })

        const table = yield* itemOf(id, di.table)
        expect(table.question).toMatchObject({ section: "di", questionType: "di.ta", status: "published" })
        expect(table.parts.map((part) => [part.kind, part.prompt, part.key])).toEqual([
          ["two-choice", "North sold the most.", "A"],
          ["two-choice", "Every region grew.", "B"],
          ["two-choice", "East grew fastest.", "A"]
        ])
        const db = yield* Db
        const [tableData] = yield* db.select().from(datasets).where(eq(datasets.id, table.stimulus!.datasetId!))
          .pipe(Effect.orDie)
        expect(JSON.parse(tableData!.columns)).toEqual([
          { name: "Region", type: "text", unit: "" },
          { name: "Sales", type: "currency", unit: "$ thousands" },
          { name: "Growth", type: "percent", unit: "" }
        ])
        expect(JSON.parse(tableData!.rows)[2]).toEqual([
          { text: "East", value: null },
          { text: "15", value: 15 },
          { text: "12.5%", value: 12.5 }
        ])

        const chart = yield* itemOf(id, di.chart)
        expect(chart.question).toMatchObject({ questionType: "di.gi", status: "published" })
        expect(chart.stimulus).toMatchObject({ kind: "chart" })
        expect(chart.parts.map((part) => [part.kind, part.prompt, part.key])).toEqual([
          ["dropdown", "Sales rose in {{blank}} of the three changes from one quarter to the next.", "B"],
          ["dropdown", "The best quarter sold {{blank}} units.", "B"]
        ])

        // The figure the text does not hold waits for the Curator, with its
        // band of the page kept as an image.
        const figure = yield* itemOf(id, di.figure)
        expect(figure.question).toMatchObject({ questionType: "di.gi", status: "held" })
        expect(figure.stimulus).toMatchObject({ kind: "figure" })
        const kept = JSON.parse(figure.stimulus!.figure!) as { page: number; top: number; bottom: number; file: string }
        // It is the last question on its page, so its band runs from its
        // first line to the foot of the page.
        expect(kept.top).toBeGreaterThan(0.2)
        expect(kept.top).toBeLessThan(0.4)
        expect(kept.bottom).toBe(1)
        expect(kept.file).toMatch(/^[0-9a-f]{64}$/)
        const review = yield* curator.api.review.list()
        const held = review.find((item) => item.question?.id === figure.question.id)!
        expect(held.reasons.map((reason) => reason.code)).toEqual(["figure"])
        const client = yield* HttpClient.HttpClient
        const image = yield* client.execute(
          HttpClientRequest.get(held.question!.stimulus!.image!).pipe(HttpClientRequest.setHeader("cookie", curator.cookie))
        )
        expect(image.headers["content-type"]).toBe("image/png")

        const twoPart = yield* itemOf(id, di.twoPart)
        expect(twoPart.question).toMatchObject({ questionType: "di.tpa", status: "published" })
        expect(twoPart.parts.map((part) => [part.kind, part.prompt, part.key, part.options.join(" ")])).toEqual([
          ["column-choice", "Width", "B", "2 3 4 5 6"],
          ["column-choice", "Height", "C", "2 3 4 5 6"]
        ])

        const [choice, statements] = yield* Effect.forEach(di.sources, (number) => itemOf(id, number))
        expect(choice!.question).toMatchObject({ questionType: "di.msr", status: "published" })
        expect(statements!.question).toMatchObject({ questionType: "di.msr", status: "published" })
        expect(choice!.question.stimulusId).toBe(statements!.question.stimulusId)
        expect(choice!.parts.map((part) => [part.kind, part.key])).toEqual([["single-choice", "C"]])
        expect(statements!.parts.map((part) => [part.kind, part.key])).toEqual([["two-choice", "A"], ["two-choice", "A"]])
        const tabs = yield* db.select().from(stimuli).where(eq(stimuli.parentId, choice!.question.stimulusId!))
          .orderBy(asc(stimuli.position)).pipe(Effect.orDie)
        expect(tabs.map((tab) => [tab.title, tab.kind])).toEqual([["Email", "passage"], ["Orders", "table"]])
      }),
      AllJobKinds
    ), 120_000)
})
