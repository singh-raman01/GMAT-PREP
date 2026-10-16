import { describe, expect, test } from "bun:test"
import { and, asc, eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { BookId } from "../src/api/Books.ts"
import { Db } from "../src/server/db/Database.ts"
import { datasets, options, pageReadings, parts, questions, sources, stimuli } from "../src/server/db/schema.ts"
import { AllJobKinds } from "../src/server/jobs/kinds/index.ts"
import { configure, confirmAndExtract, curatorBrowser, extractBook, proposedFrom, rangesOf, sentFor, withModel } from "./bookFlow.ts"
import { bookOfPages, DiNumbers } from "./fixtures/book.ts"
import { advanceUntil, runWithWorker } from "./harness.ts"

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

        // The Curator changes one Part's key; a letter its menu lacks is refused.
        expect(held.question!.parts.map((part) => part.options.map((option) => option.text))).toEqual([["three", "four", "five"]])
        const refused = yield* curator.api.review.overrideKey({
          params: { id: held.id },
          payload: { part: 0, key: "D", reason: "The errata say so." }
        }).pipe(Effect.flip)
        expect(refused).toMatchObject({ _tag: "KeyNotAnOption", options: ["A", "B", "C"] })
        const changed = yield* curator.api.review.overrideKey({
          params: { id: held.id },
          payload: { part: 0, key: "C", reason: "The errata say so." }
        })
        expect(changed.question?.keyOverrides).toMatchObject([{ part: 0, previousKey: "B", newKey: "C" }])
        expect(changed.question?.parts[0]).toMatchObject({ key: "C", keyBasis: "override" })

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

describe("Charts and older Books", () => {
  test("a chart that does not draw holds its Question with the reason", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const bytes = yield* Effect.promise(() =>
          bookOfPages("Venn Drills", [
            [
              "Graphics Interpretation",
              "1. The Venn diagram shows how many of 50 people drink tea or coffee.",
              "Sets: Tea, Coffee",
              "Region | Count",
              "Tea | 12",
              "Tea & Coffee | 8",
              "Tea & Milk | 5",
              "none | 25",
              "[blank] people drink tea. (12 | 20 | 25)"
            ],
            ["Data Insights Answer Key", "1. 20"]
          ])
        )
        const extracted = yield* extractBook(curator, bytes, "Venn Drills")
        const item = yield* itemOf(extracted.book.id, 1)
        expect(item.question.status).toBe("held")
        expect(item.stimulus).toMatchObject({ kind: "chart" })
        const [held] = yield* curator.api.review.list()
        expect(held?.reasons).toEqual([{
          code: "render",
          detail: 'The chart does not draw: The region "Milk & Tea" names a set the diagram lacks.'
        }])
      }),
      AllJobKinds
    ), 120_000)

  test("an older Book's Integrated Reasoning becomes the Focus types it maps onto", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        // The solves give this Book's keys.
        yield* withModel({ solve: (stem) => (/teams' wins/.test(stem) ? "A,B" : /sum of 9/.test(stem) ? "B,C" : undefined) })
        const bytes = yield* Effect.promise(() =>
          bookOfPages("Integrated Reasoning Drills", [
            [
              "Integrated Reasoning",
              "Table Analysis",
              "1. The table shows the teams' wins.",
              "Team | Wins",
              "Reds | 10",
              "Blues | 7",
              "For each statement, choose Yes if it is true, otherwise No.",
              "The Reds won more games.",
              "The Blues won 10 games.",
              "Two-Part Analysis",
              "2. Two whole numbers have a sum of 9 and a product of 20.",
              "Select the smaller and the larger.",
              "Smaller | Larger",
              "3",
              "4",
              "5",
              "6"
            ],
            ["Integrated Reasoning Answer Key", "1. Yes, No", "2. 4, 5"]
          ])
        )
        const extracted = yield* extractBook(curator, bytes, "Integrated Reasoning Drills")
        const [table, twoPart] = yield* Effect.forEach([1, 2], (number) => itemOf(extracted.book.id, number))
        expect(table!.question).toMatchObject({ section: "di", questionType: "di.ta", status: "published" })
        expect(table!.parts.map((part) => part.key)).toEqual(["A", "B"])
        expect(twoPart!.question).toMatchObject({ section: "di", questionType: "di.tpa", status: "published" })
        expect(twoPart!.parts.map((part) => [part.prompt, part.key])).toEqual([["Smaller", "B"], ["Larger", "C"]])
      }),
      AllJobKinds
    ), 120_000)
})

describe("Keys for several Parts", () => {
  // A Table Analysis Question whose printed answer for one statement is
  // neither Yes nor No has no key for any Part.
  const taBook = () =>
    bookOfPages("Override Drills", [
      [
        "Table Analysis",
        "1. The table shows the clubs' members.",
        "Club | Members",
        "Chess | 1,200",
        "Golf | 980",
        "For each statement, choose Yes if it is true, otherwise No.",
        "Chess has more members than Golf.",
        "Golf has fewer than 500 members.",
        "The two clubs have 2,180 members in all."
      ],
      ["Data Insights Answer Key", "1. Yes, Maybe, Yes"]
    ])

  test("a Question stays held until a Key Override has given every Part a key", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        yield* withModel({ solve: (stem) => (/clubs' members/.test(stem) ? "A,B,A" : undefined) })
        const curator = yield* curatorBrowser
        const book = yield* extractBook(curator, yield* Effect.promise(taBook), "Override Drills")
        const [held] = yield* curator.api.review.list()
        expect(held!.reasons.map((reason) => reason.code)).toEqual(["no-key"])
        const override = (part: number, key: string) =>
          Effect.gen(function*() {
            const [item] = yield* advanceUntil(
              curator.api.review.list().pipe(Effect.map((items) => (items.length > 0 ? items : undefined))),
              { step: "200 millis", maxSteps: 3000 }
            )
            yield* curator.api.review.overrideKey({
              params: { id: item!.id },
              payload: { part, key, reason: "The printed answer is a misprint." }
            })
            return yield* advanceUntil(
              itemOf(book.book.id, 1).pipe(Effect.map((found) => (found.question.status === "draft" ? undefined : found))),
              { step: "200 millis", maxSteps: 3000 }
            )
          })
        // The unclear statement first: the other two still have no key.
        const one = yield* override(1, "B")
        expect(one.question.status).toBe("held")
        expect(one.parts.map((part) => part.key)).toEqual([null, "B", null])
        const [again] = yield* curator.api.review.list()
        expect(again!.reasons).toEqual([{ code: "no-key", detail: "Parts 1 and 3 have no key yet." }])
        yield* override(0, "A")
        const all = yield* override(2, "A")
        expect(all.question.status).toBe("published")
        expect(all.parts.map((part) => part.key)).toEqual(["A", "B", "A"])
      }),
      AllJobKinds
    ), 120_000)
})

// One Table Analysis question as a Book prints it, with the first club's
// members and the answer key as given.
const clubBook = (title: string, chess: string, key = "Yes, No, Yes") =>
  bookOfPages(title, [
    [
      "Table Analysis",
      "1. The table shows the clubs' members.",
      "Club | Members",
      `Chess | ${chess}`,
      "Golf | 980",
      "For each statement, choose Yes if it is true, otherwise No.",
      "Chess has more members than Golf.",
      "Golf has fewer than 500 members.",
      "The two clubs have 2,180 members in all."
    ],
    ["Data Insights Answer Key", `1. ${key}`]
  ])

// The Data Insights Questions of a type, with how many Sources each has.
const bankOf = (questionType: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const rows = yield* db.select().from(questions).where(eq(questions.questionType, questionType))
      .orderBy(asc(questions.createdAt)).pipe(Effect.orDie)
    return yield* Effect.forEach(rows, (question) =>
      db.select({ id: sources.id }).from(sources).where(eq(sources.questionId, question.id)).pipe(
        Effect.orDie,
        Effect.map((found) => ({ question, sources: found.length, reasons: JSON.parse(question.linkReasons) as Array<{ code: string; detail: string }> }))
      ))
  })

describe("The same Data Insights Question in two Books", () => {
  test("a table read with a separator left out is the same table, and one with a number changed is a near one", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        yield* withModel({ solve: (stem) => (/clubs' members/.test(stem) ? "A,B,A" : undefined) })
        const curator = yield* curatorBrowser
        yield* extractBook(curator, yield* Effect.promise(() => clubBook("Club Drills", "1,200")), "Club Drills")
        yield* extractBook(curator, yield* Effect.promise(() => clubBook("Club Drills, rescan", "1200")), "Club Drills, rescan")
        const merged = yield* bankOf("di.ta")
        expect(merged.map((each) => [each.question.status, each.sources])).toEqual([["published", 2]])
        yield* extractBook(curator, yield* Effect.promise(() => clubBook("Club Drills, second edition", "1,210")), "Club Drills, second edition")
        const [first, second] = yield* bankOf("di.ta")
        expect(second!.question.status).toBe("held")
        expect(second!.question.relatedQuestionId).toBe(first!.question.id)
        // Its table is the first one's with a number changed.
        expect(second!.reasons).toEqual([
          { code: "near-match", detail: "It is another Question with different numbers: a Variant, or the same Question?" }
        ])
      }),
      AllJobKinds
    ), 180_000)

  test("a Question about a figure is compared with the Questions about every figure", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const figureBook = (title: string) =>
          bookOfPages(title, [
            [
              "Graphics Interpretation",
              "1. The figure shows the floor plan of an office.",
              "[A floor plan is printed here.]",
              "The office has [blank] rooms. (three | four | five)"
            ],
            ["Data Insights Answer Key", "1. four"]
          ])
        yield* extractBook(curator, yield* Effect.promise(() => figureBook("Office Drills")), "Office Drills")
        yield* extractBook(curator, yield* Effect.promise(() => figureBook("Office Drills, reprint")), "Office Drills, reprint")
        const [first, second] = yield* bankOf("di.gi")
        expect(first!.reasons.map((reason) => reason.code)).toEqual(["figure"])
        expect(second!.question.stimulusId).not.toBe(first!.question.stimulusId)
        expect(second!.question.relatedQuestionId).toBe(first!.question.id)
        expect(second!.reasons).toEqual([
          expect.objectContaining({ code: "figure" }),
          {
            code: "near-match",
            detail:
              "It is worded like another Question with a figure: check that the figures are the same, then merge it or keep it as a Variant."
          }
        ])
      }),
      AllJobKinds
    ), 180_000)

  test("a Key Override of one Part settles a Source's key for that Part only", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        yield* withModel({ solve: (stem) => (/clubs' members/.test(stem) ? "A,B,A" : undefined) })
        const curator = yield* curatorBrowser
        // The first Book's answer for the second statement is unclear, and
        // the Curator gives it from the errata.
        yield* extractBook(curator, yield* Effect.promise(() => clubBook("Club Drills", "1,200", "Yes, Maybe, Yes")), "Club Drills")
        const [held] = yield* curator.api.review.list()
        yield* curator.api.review.overrideKey({
          params: { id: held!.id },
          payload: { part: 1, key: "B", reason: "The errata say so." }
        })
        // A reprint gives Yes for it, where the override says No, and agrees
        // on the others: the override settles the one it differs on.
        const reprint = yield* extractBook(
          curator,
          yield* Effect.promise(() => clubBook("Club Drills, reprint", "1,200", "Yes, Yes, Yes")),
          "Club Drills, reprint"
        )
        const merged = yield* advanceUntil(
          bankOf("di.ta").pipe(Effect.map(([only]) => (only?.question.status === "published" ? only : undefined))),
          { step: "200 millis", maxSteps: 3000 }
        )
        expect([merged.sources, merged.reasons]).toEqual([2, []])
        // The reprint's answer key read again, now with No for the first
        // statement, which no override covers.
        const db = yield* Db
        const [answerPage] = yield* db.select().from(pageReadings)
          .where(and(eq(pageReadings.bookId, reprint.book.id), eq(pageReadings.role, "answer-key"))).pipe(Effect.orDie)
        const stored = JSON.parse(answerPage!.items) as { answers: Array<Record<string, unknown>> }
        const changed = {
          answers: stored.answers.map((answer) => (answer.number === 1 ? { ...answer, parts: ["No", "Yes", "Yes"] } : answer))
        }
        yield* db.update(pageReadings).set({ items: JSON.stringify(changed) })
          .where(and(
            eq(pageReadings.bookId, reprint.book.id),
            eq(pageReadings.page, answerPage!.page),
            eq(pageReadings.role, "answer-key"),
            eq(pageReadings.group, answerPage!.group)
          )).pipe(Effect.orDie)
        yield* confirmAndExtract(curator, reprint.book.id, rangesOf(reprint))
        const [after] = yield* bankOf("di.ta")
        expect(after!.reasons).toEqual([{
          code: "source-key",
          detail: "Club Drills, reprint, Data Insights, question 1 gives the key B,A,A; this Question's key is A,B,A."
        }])
      }),
      AllJobKinds
    ), 180_000)
})

describe("Readings stored in an older shape", () => {
  test("a mixed answer key read before keys had Parts is read again, so its Questions keep their keys", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedFrom(curator, { edition: "First edition", di: true })
        const id = proposed.book.id
        yield* confirmAndExtract(curator, id, rangesOf(proposed))
        // The MSR question with five choices, keyed C by the mixed answer key.
        const choice = di.sources[0]
        expect((yield* itemOf(id, choice)).parts.map((part) => part.key)).toEqual(["C"])
        const db = yield* Db
        const [row] = yield* db.select().from(pageReadings)
          .where(and(eq(pageReadings.bookId, id), eq(pageReadings.role, "answer-key"), eq(pageReadings.group, "mixed")))
          .pipe(Effect.orDie)
        // As ticket 08 stored a mixed answer-key page: letters only.
        yield* db.update(pageReadings)
          .set({ items: JSON.stringify({ answers: [{ number: choice, answer: "C" }] }), promptVersion: "read-answer-key@1" })
          .where(and(
            eq(pageReadings.bookId, id),
            eq(pageReadings.page, row!.page),
            eq(pageReadings.role, "answer-key"),
            eq(pageReadings.group, "mixed")
          )).pipe(Effect.orDie)
        const asked = sentFor("may have several parts").pipe(Effect.map((requests) => requests.length))
        const before = yield* asked
        yield* confirmAndExtract(curator, id, rangesOf(proposed))
        expect(yield* asked).toBe(before + 1)
        const after = yield* itemOf(id, choice)
        expect(after.parts.map((part) => part.key)).toEqual(["C"])
        expect(after.question.status).toBe("published")
      }),
      AllJobKinds
    ), 180_000)
})

describe("The golden set with Data Insights Questions", () => {
  test("a check reads a table, the sources of an MSR set and every Part again, and passes when nothing changed", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedFrom(curator, { edition: "First edition", di: true })
        yield* confirmAndExtract(curator, proposed.book.id, rangesOf(proposed))
        const golden = curator.api.golden
        const view = yield* golden.get()
        const picked = [di.table, di.twoPart, ...di.sources].map((number) =>
          view.candidates.find((each) => each.number === number)!
        )
        expect(picked.map((each) => each.stimulus?.kind ?? null)).toEqual(["table", null, "tabs", "tabs"])
        expect(picked[0]!.parts.map((part) => part.prompt)).toEqual([
          "North sold the most.",
          "Every region grew.",
          "East grew fastest."
        ])
        for (const each of picked) {
          yield* golden.approve({
            params: { questionId: each.questionId },
            payload: { primarySkill: each.primarySkill!, secondarySkills: [...each.secondarySkills] }
          })
        }
        yield* golden.check({ payload: { spendCap: 1 } })
        const done = yield* advanceUntil(
          golden.get().pipe(Effect.map((current) => (current.report !== null ? current : undefined))),
          { step: "200 millis", maxSteps: 3000 }
        )
        expect(done.report).toMatchObject({ items: 4, textExact: 4, partsExact: 4, keysExact: 4, tagAgreement: 1, passed: true })
      }),
      AllJobKinds
    ), 120_000)
})
