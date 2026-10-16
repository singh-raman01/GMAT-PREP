import { describe, expect, test } from "bun:test"
import { and, eq, inArray, ne } from "drizzle-orm"
import { Effect } from "effect"
import type { BookId } from "../src/api/Books.ts"
import { renderProblem } from "../src/api/richText.ts"
import { Db } from "../src/server/db/Database.ts"
import { questions, sessions, sources, stimuli } from "../src/server/db/schema.ts"
import { AllJobKinds } from "../src/server/jobs/kinds/index.ts"
import {
  bankItem,
  configure,
  confirmAndExtract,
  type Curator,
  curatorBrowser,
  proposedFrom,
  rangesOf,
  statusIs,
  upload,
  waitFor
} from "./bookFlow.ts"
import { fourPassages, type RcPassage, rcBook, withExtraQuestion } from "./fixtures/rcBook.ts"
import { advanceUntil, openBrowser, runWithWorker } from "./harness.ts"

const extractRcBook = (curator: Curator, title: string, passages: ReadonlyArray<RcPassage>) =>
  Effect.gen(function*() {
    const fixture = yield* Effect.promise(() => rcBook(title, passages))
    const book = yield* upload(curator, fixture.bytes, title)
    yield* waitFor(curator, book.id, statusIs("previewed"))
    yield* curator.api.books.start({ params: { id: book.id }, payload: { spendCap: 1 } })
    const proposed = yield* waitFor(curator, book.id, statusIs("map-proposed"))
    return yield* confirmAndExtract(curator, book.id, rangesOf(proposed))
  })

// A Book's own Questions, with their passages.
const ownQuestions = (bookId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    return yield* db.select({
      id: questions.id,
      number: sources.number,
      status: questions.status,
      reserve: questions.reserve,
      releasedAt: questions.releasedAt,
      stimulusId: questions.stimulusId,
      linkReasons: questions.linkReasons
    }).from(sources).innerJoin(questions, eq(questions.id, sources.questionId))
      .where(and(eq(sources.bookId, bookId), eq(sources.merged, false))).pipe(Effect.orDie)
  })

const plannedBy = (sessionId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const [row] = yield* db.select({ config: sessions.config }).from(sessions).where(eq(sessions.id, sessionId))
      .pipe(Effect.orDie)
    return (JSON.parse(row!.config) as { readonly planned: ReadonlyArray<string> }).planned
  })

describe("A passage two Books share", () => {
  test("keeps one Reserve decision: a later Book's new Question about a Reserve passage is held for Mocks too", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const first = yield* extractRcBook(curator, "Verbal Drills, First edition", fourPassages())
        const reserved = [
          ...new Set((yield* ownQuestions(first.book.id)).filter((row) => row.reserve === true).map((row) => row.stimulusId))
        ]
        // A quarter of 12 is 3: one passage of 3 joins the Reserve.
        expect(reserved).toHaveLength(1)

        const second = yield* extractRcBook(curator, "Verbal Drills, Second edition", withExtraQuestion(fourPassages()))
        expect(second.book.report).toMatchObject({ merged: 12, published: 4 })
        const added = (yield* ownQuestions(second.book.id)).find((row) => row.stimulusId === reserved[0])!
        // Four Questions still fit a Reading Comprehension slot.
        expect(added).toMatchObject({ status: "published", reserve: true, releasedAt: null })

        const asha = yield* openBrowser
        yield* asha.profiles.create({ payload: { name: "Asha" } })
        const started = yield* asha.practice.start({
          payload: { choice: { kind: "filters", status: "any", size: 20, section: "verbal" } }
        })
        const planned = yield* plannedBy(started.id)
        expect(planned).toHaveLength(12)
        expect(planned).not.toContain(added.id)
      }),
      AllJobKinds
    ), 120_000)
})

describe("A passage another edition prints with a word changed", () => {
  test("holds its Questions as near matches of the first edition's, which the Curator can merge", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const first = yield* extractRcBook(curator, "Verbal Drills, First edition", fourPassages())
        const second = yield* extractRcBook(
          curator,
          "Verbal Drills, Second edition",
          fourPassages({ passage: 0, from: "within one decade", to: "within a decade" })
        )
        expect(second.book.report).toMatchObject({ extracted: 12, merged: 9, published: 0, held: 3 })
        const items = (yield* curator.api.review.list()).filter((item) =>
          item.question?.sources.some((source) => source.bookTitle === "Verbal Drills, Second edition")
        )
        expect(items).toHaveLength(3)
        const earlier = yield* ownQuestions(first.book.id)
        for (const item of items) {
          expect(item.reasons).toEqual([{
            code: "near-match",
            detail: expect.stringMatching(/^It is worded like another Question, whose passage is 9\d% like its own/)
          }])
          expect(item.related?.stimulus?.body).toContain("within one decade")
          expect(item.question?.stimulus?.body).toContain("within a decade")
          expect(earlier.map((row) => row.id)).toContain(item.related!.id)
          yield* curator.api.review.merge({ params: { id: item.id } })
        }
        // Each joined the first edition's Question about the first passage.
        const db = yield* Db
        const live = yield* db.selectDistinct({ stimulusId: questions.stimulusId }).from(questions)
          .where(ne(questions.status, "withdrawn")).pipe(Effect.orDie)
        expect(live).toHaveLength(4)
      }),
      AllJobKinds
    ), 120_000)
})

describe("A passage one Book transcribed with broken math", () => {
  test("takes the text of a Book that reads it cleanly, and its held Questions are checked again", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const first = yield* extractRcBook(
          curator,
          "Verbal Drills, First edition",
          fourPassages({ passage: 0, from: "within one decade", to: "within \\(1 decade" })
        )
        const held = (yield* ownQuestions(first.book.id)).filter((row) => row.status === "held")
        expect(held).toHaveLength(3)
        expect(held.every((row) => row.linkReasons.includes("The passage does not render"))).toBe(true)

        const second = yield* extractRcBook(
          curator,
          "Verbal Drills, Second edition",
          withExtraQuestion(fourPassages({ passage: 0, from: "within one decade", to: "within \\(1\\) decade" }))
        )
        const db = yield* Db
        const [passage] = yield* db.select().from(stimuli).where(eq(stimuli.id, held[0]!.stimulusId!)).pipe(Effect.orDie)
        expect(renderProblem(passage!.body)).toBeUndefined()
        const added = (yield* ownQuestions(second.book.id)).find((row) => row.stimulusId === held[0]!.stimulusId)!
        expect(added.status).toBe("published")
        // The first Book's three joined the second's run, which published them.
        const again = yield* db.select({ status: questions.status, linkReasons: questions.linkReasons }).from(questions)
          .where(inArray(questions.id, held.map((row) => row.id))).pipe(Effect.orDie)
        expect(again.map((row) => row.status)).toEqual(["published", "published", "published"])
        expect(again.every((row) => !row.linkReasons.includes("does not render"))).toBe(true)
      }),
      AllJobKinds
    ), 120_000)
})

describe("Fixing a Book Map so a passage is read", () => {
  // The verbal fixture: the passage and question 15 on one page, 16 and 17 on the next.
  const startAfterPassage = (ranges: ReturnType<typeof rangesOf>) =>
    ranges.map((range) => (range.role === "questions" && range.group === "rc" ? { ...range, firstPage: range.lastPage } : range))
  const passageOf = (bookId: BookId) =>
    Effect.gen(function*() {
      const db = yield* Db
      const [passage] = yield* db.select({ id: stimuli.id }).from(stimuli).pipe(Effect.orDie)
      return passage?.id
    })

  test("attaches it to the Questions that waited for it, which are then published", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedFrom(curator, { edition: "First edition", verbal: true })
        const id = proposed.book.id
        const full = rangesOf(proposed)
        yield* confirmAndExtract(curator, id, startAfterPassage(full))
        const before = yield* bankItem(id, 16)
        expect(before.question).toMatchObject({ status: "held", stimulusId: null })

        yield* confirmAndExtract(curator, id, full)
        const passage = yield* passageOf(id)
        for (const number of [15, 16, 17]) {
          expect((yield* bankItem(id, number)).question).toMatchObject({ status: "published", stimulusId: passage })
        }
      }),
      AllJobKinds
    ), 120_000)

  test("attaches it when the key arrives in the same fix", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedFrom(curator, { edition: "First edition", verbal: true })
        const id = proposed.book.id
        const full = rangesOf(proposed)
        const first = startAfterPassage(full).filter((range) => !(range.role === "answer-key" && range.group === "rc"))
        yield* confirmAndExtract(curator, id, first)
        expect((yield* bankItem(id, 16)).question.status).toBe("held")

        yield* confirmAndExtract(curator, id, full)
        const after = yield* bankItem(id, 16)
        expect(after.question).toMatchObject({ status: "published", stimulusId: yield* passageOf(id) })
        expect(after.key).toBe("C")
      }),
      AllJobKinds
    ), 120_000)
})

describe("An answer key page the Book Map calls mixed", () => {
  test("is read, so the Questions it keys get their keys", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedFrom(curator, { edition: "First edition", verbal: true })
        const id = proposed.book.id
        const ranges = rangesOf(proposed).map((range) =>
          range.role === "answer-key" && range.group === "rc" ? { ...range, group: "mixed" as const } : range
        )
        yield* confirmAndExtract(curator, id, ranges)
        const rc = yield* Effect.forEach([15, 16, 17], (number) => bankItem(id, number))
        expect(rc.map((item) => [item.question.status, item.key])).toEqual([
          ["published", "C"],
          ["published", "C"],
          ["published", "C"]
        ])
      }),
      AllJobKinds
    ), 120_000)
})

describe("Checking the golden set", () => {
  // Critical Reasoning 1 to 3 on page 2, then Reading Comprehension numbered
  // from 1 again on page 4, each chapter with its own answer key.
  const restartingBook = async () => {
    const { PDFDocument, StandardFonts } = await import("pdf-lib")
    const doc = await PDFDocument.create()
    doc.setCreationDate(new Date(Date.UTC(2026, 0, 1)))
    doc.setModificationDate(new Date(Date.UTC(2026, 0, 1)))
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const page = (lines: ReadonlyArray<string>) => {
      const added = doc.addPage([612, 792])
      lines.forEach((line, i) => added.drawText(line, { x: 40, y: 760 - i * 16, size: 9, font }))
    }
    const choices = (topic: string) => ["A", "B", "C", "D", "E"].map((label, i) => `(${label}) ${topic} choice ${i + 1}`)
    page(["Restarting Numbers", "A made-up book"])
    page([
      "Critical Reasoning",
      "1. Town officials say a new bus route will cut traffic downtown, because drivers will take the bus.",
      "Which of the following, if true, most seriously weakens the officials' argument?",
      ...choices("bus"),
      "2. Sales of the phone fell last year. Yet the company's profits rose, because it cut costs.",
      "Which of the following most helps to explain the rise in profits?",
      ...choices("phone"),
      "3. A cafe plans to open at 6 a.m., expecting to sell more coffee to commuters.",
      "Which of the following would be most useful to know in evaluating the plan?",
      ...choices("cafe")
    ])
    page(["Critical Reasoning Answer Key", "1. C", "2. C", "3. C"])
    page([
      "Reading Comprehension",
      "Questions 1 to 3 refer to the passage below.",
      "In the 1890s, the town council debated whether to build a public library.",
      "Supporters argued that a library would raise reading rates among workers.",
      "1. The primary purpose of the passage is to",
      ...choices("purpose"),
      "2. According to the passage, the supporters argued that a library would",
      ...choices("detail"),
      "3. The author would most likely agree that the council",
      ...choices("inference")
    ])
    page(["Reading Comprehension Answer Key", "1. C", "2. C", "3. C"])
    return doc.save()
  }

  test("links each set from its own pages, so numbers another set repeats nearby do not hide a Question", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const added = yield* upload(curator, yield* Effect.promise(restartingBook), "Restarting Numbers")
        yield* waitFor(curator, added.id, statusIs("previewed"))
        yield* curator.api.books.start({ params: { id: added.id }, payload: { spendCap: 1 } })
        const proposed = yield* waitFor(curator, added.id, statusIs("map-proposed"))
        yield* confirmAndExtract(curator, added.id, rangesOf(proposed))
        const golden = curator.api.golden
        const view = yield* golden.get()
        const pick = (set: string, number: number) => view.candidates.find((each) => each.set === set && each.number === number)!
        for (const each of [pick("Critical Reasoning", 1), pick("Reading Comprehension", 1)]) {
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
        expect(done.report).toMatchObject({ items: 2, textExact: 2, keysExact: 2, tagAgreement: 1, passed: true })
      }),
      AllJobKinds
    ), 120_000)
})
