import { describe, expect, test } from "bun:test"
import { and, asc, eq, inArray, ne } from "drizzle-orm"
import { Effect } from "effect"
import type { BookId } from "../src/api/Books.ts"
import { normalizeText, renderProblem } from "../src/api/richText.ts"
import { sha256 } from "../src/server/access/tokens.ts"
import { linkCandidate, loadBank, loadPassages } from "../src/server/books/bankWrites.ts"
import type { Candidate, Letter } from "../src/server/books/linking.ts"
import { Db } from "../src/server/db/Database.ts"
import { options, parts, questions, sessions, sources, stimuli } from "../src/server/db/schema.ts"
import { AllJobKinds } from "../src/server/jobs/kinds/index.ts"
import { assignReserve } from "../src/server/review/reserve.ts"
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
import { type SeedQuestion, seedBook } from "./fixtures/bank.ts"
import { fourPassages, type RcPassage, rcBook, withExtraQuestion } from "./fixtures/rcBook.ts"
import { advanceUntil, openBrowser, runWithWorker, runWithWorkers } from "./harness.ts"

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

// The Questions a new Learner's Practice Set of verbal Questions would serve.
const practised = Effect.gen(function*() {
  const learner = yield* openBrowser
  yield* learner.profiles.create({ payload: { name: "Asha" } })
  const started = yield* learner.practice.start({
    payload: { choice: { kind: "filters", status: "any", size: 30, section: "verbal" } }
  })
  return yield* plannedBy(started.id)
})

// Waits until no Question is being checked.
const checked = (curator: Curator) =>
  advanceUntil(
    curator.api.review.drafts().pipe(Effect.map((drafts) => (drafts.checking === 0 ? drafts : undefined))),
    { step: "200 millis", maxSteps: 3000 }
  )

const details = (linkReasons: string) =>
  (JSON.parse(linkReasons) as ReadonlyArray<{ readonly detail: string }>).map((reason) => reason.detail)

const withStem = (passage: RcPassage, index: number, stem: (old: string) => string): RcPassage => ({
  ...passage,
  questions: passage.questions.map((question, i) => (i === index ? { ...question, stem: stem(question.stem) } : question))
})

// Each passage with a word of its first line changed, as another edition
// might print it.
const reprinted = (passages: ReadonlyArray<RcPassage>, from: string | RegExp, to: string, line = 0) =>
  passages.map((passage) => ({
    ...passage,
    lines: passage.lines.map((each, i) => (i === line ? each.replace(from, to) : each))
  }))

const secondItems = (curator: Curator, title: string) =>
  curator.api.review.list().pipe(
    Effect.map((items) => items.filter((item) => item.question?.sources.some((source) => source.bookTitle === title)))
  )

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

describe("A Reserve passage with a Question waiting as a near match", () => {
  test("is not released for it, and stays held once the Curator merges it", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        // Four passages of four questions: a quarter of 16 is one passage.
        const first = yield* extractRcBook(curator, "Verbal Drills, First edition", withExtraQuestion(fourPassages()))
        const firstOwn = yield* ownQuestions(first.book.id)
        const reserved = [...new Set(firstOwn.filter((row) => row.reserve === true).map((row) => row.stimulusId))]
        expect(reserved).toHaveLength(1)
        const passage = reserved[0]!

        // The second edition rewords one question about each passage a little.
        const reworded = withExtraQuestion(fourPassages()).map((each) =>
          withStem(each, 1, (stem) => stem.replace("suggests that", "indicates that"))
        )
        const second = yield* extractRcBook(curator, "Verbal Drills, Second edition", reworded)
        expect(second.book.report).toMatchObject({ merged: 12, held: 4 })
        const db = yield* Db
        const onPassage = () =>
          db.select({ id: questions.id, status: questions.status, reserve: questions.reserve, releasedAt: questions.releasedAt })
            .from(questions).where(and(eq(questions.stimulusId, passage), ne(questions.status, "withdrawn"))).pipe(Effect.orDie)
        const before = yield* onPassage()
        expect(before.map((row) => row.status).toSorted()).toEqual(["held", "published", "published", "published", "published"])
        expect(before.filter((row) => row.status === "published").every((row) => row.reserve && row.releasedAt === null))
          .toBe(true)

        const [item] = (yield* curator.api.review.list()).filter((each) => before.some((row) => row.id === each.question?.id))
        yield* curator.api.review.merge({ params: { id: item!.id } })
        const after = yield* onPassage()
        expect(after).toHaveLength(4)
        expect(after.every((row) => row.reserve === true && row.releasedAt === null)).toBe(true)
        const planned = yield* practised
        expect(planned).toHaveLength(12)
        expect(planned.some((id) => after.some((row) => row.id === id))).toBe(false)
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
          expect(item.related?.passage).toContain("within one decade")
          expect(item.question?.passage).toContain("within a decade")
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

  test("holds a new Question about it until the Curator says it is the same passage, which moves it there", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const first = yield* extractRcBook(curator, "Verbal Drills, First edition", fourPassages())
        const reserved = [
          ...new Set((yield* ownQuestions(first.book.id)).filter((row) => row.reserve === true).map((row) => row.stimulusId))
        ]
        expect(reserved).toHaveLength(1)

        // The second edition changes a word in each passage and adds a
        // fourth question about each.
        const edition = "Verbal Drills, Second edition"
        const second = yield* extractRcBook(curator, edition, withExtraQuestion(reprinted(fourPassages(), " the ", " a ")))
        expect(second.book.report).toMatchObject({ extracted: 16, held: 16 })
        const items = yield* secondItems(curator, edition)
        const fresh = items.filter((item) => item.reasons.some((reason) => reason.detail.startsWith("Its passage is")))
        expect(fresh).toHaveLength(4)
        for (const item of items) {
          if (!fresh.includes(item)) yield* curator.api.review.merge({ params: { id: item.id } })
        }
        // Each new one moves to the passage of the Question it was compared with.
        const db = yield* Db
        const passageOf = (questionId: string) =>
          db.select({ stimulusId: questions.stimulusId }).from(questions).where(eq(questions.id, questionId))
            .pipe(Effect.orDie, Effect.map((rows) => rows[0]?.stimulusId))
        const targets = new Map<string, string | null | undefined>()
        for (const item of fresh) {
          targets.set(item.question!.id, yield* passageOf(item.related!.id))
          yield* curator.api.review.usePassage({ params: { id: item.id } })
        }
        yield* checked(curator)
        const moved = yield* db.select().from(questions)
          .where(inArray(questions.id, [...targets.keys()])).pipe(Effect.orDie)
        for (const row of moved) {
          expect(row).toMatchObject({ stimulusId: targets.get(row.id), status: "published", linkReasons: "[]" })
        }
        // The one about the Reserve passage takes its decision, and four
        // Questions still fit its slot.
        const onReserve = yield* db.select({ id: questions.id, reserve: questions.reserve, releasedAt: questions.releasedAt })
          .from(questions).where(and(eq(questions.stimulusId, reserved[0]!), ne(questions.status, "withdrawn")))
          .pipe(Effect.orDie)
        expect(onReserve).toHaveLength(4)
        expect(onReserve.every((row) => row.reserve === true && row.releasedAt === null)).toBe(true)
        expect(moved.filter((row) => row.stimulusId === reserved[0]).map((row) => row.id))
          .toEqual(onReserve.filter((row) => targets.has(row.id)).map((row) => row.id))
        // Only the first edition's passages have Questions, and Practice
        // serves none about the Reserve passage.
        const live = yield* db.selectDistinct({ stimulusId: questions.stimulusId }).from(questions)
          .where(ne(questions.status, "withdrawn")).pipe(Effect.orDie)
        expect(live.map((row) => row.stimulusId).toSorted())
          .toEqual([...new Set([...targets.values()])].toSorted() as Array<string>)
        const planned = yield* practised
        expect(planned).toHaveLength(12)
        expect(planned.some((id) => onReserve.some((row) => row.id === id))).toBe(false)

        // Linking the second edition again leaves them where the Curator put them.
        yield* confirmAndExtract(curator, second.book.id, rangesOf(second))
        const again = yield* db.select({ id: questions.id, stimulusId: questions.stimulusId, status: questions.status })
          .from(questions).where(inArray(questions.id, [...targets.keys()])).pipe(Effect.orDie)
        for (const row of again) expect(row).toMatchObject({ stimulusId: targets.get(row.id), status: "published" })
      }),
      AllJobKinds
    ), 180_000)

  test("holds a third edition's new Question though the second edition's copy has no Questions left", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const first = yield* extractRcBook(curator, "Verbal Drills, First edition", fourPassages())
        const second = reprinted(fourPassages(), " the ", " a ")
        const two = yield* extractRcBook(curator, "Verbal Drills, Second edition", second)
        expect(two.book.report).toMatchObject({ extracted: 12, held: 12 })
        for (const item of yield* secondItems(curator, "Verbal Drills, Second edition")) {
          yield* curator.api.review.merge({ params: { id: item.id } })
        }
        // The third edition changes one more word and adds a question about
        // each passage.
        const third = withExtraQuestion(reprinted(second, /\.$/, " too.", 1))
        const three = yield* extractRcBook(curator, "Verbal Drills, Third edition", third)
        expect(three.book.report).toMatchObject({ extracted: 16, held: 16, published: 0 })
        // Each new one is compared with a first edition Question.
        const firstIds = (yield* ownQuestions(first.book.id)).map((row) => row.id)
        const fresh = (yield* secondItems(curator, "Verbal Drills, Third edition"))
          .filter((item) => item.reasons.some((reason) => reason.detail.startsWith("Its passage is")))
        expect(fresh).toHaveLength(4)
        expect(fresh.every((item) => firstIds.includes(item.related!.id))).toBe(true)
      }),
      AllJobKinds
    ), 180_000)
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

  test("keeps a Question held whose own words do not render either", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        // The first reading broke the math in the passage and in its first question.
        const broken = fourPassages({ passage: 0, from: "within one decade", to: "within \\(1 decade" })
        broken[0] = withStem(broken[0]!, 0, (stem) => stem.replace("passage about", "\\(passage about"))
        const first = yield* extractRcBook(curator, "Verbal Drills, First edition", broken)
        const own = (yield* ownQuestions(first.book.id)).find((row) => row.number === 1)!
        expect(details(own.linkReasons)).toEqual([
          expect.stringMatching(/^The passage does not render/),
          expect.stringMatching(/^The question does not render/)
        ])

        yield* extractRcBook(
          curator,
          "Verbal Drills, Second edition",
          fourPassages({ passage: 0, from: "within one decade", to: "within \\(1\\) decade" })
        )
        yield* checked(curator)
        const db = yield* Db
        const [after] = yield* db.select().from(questions).where(eq(questions.id, own.id)).pipe(Effect.orDie)
        expect(after!.status).toBe("held")
        expect(details(after!.linkReasons)).toEqual([expect.stringMatching(/^The question does not render/)])
        const item = (yield* curator.api.review.list()).find((each) => each.question?.id === own.id)
        expect(item?.reasons.map((reason) => reason.detail)).toEqual([expect.stringMatching(/^The question does not render/)])
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

describe("A Book Map fix that moves a Question to another passage", () => {
  const passageA = "Passage A: the town council met twice before it chose a site for the new library."
  const passageB = "Passage B: the glacier retreated faster after 1990 than in any decade before it."
  const rc = (number: number, passage: string, page: number, reserve: boolean): SeedQuestion => ({
    number,
    page,
    set: "Reading Comprehension",
    questionType: "verbal.rc-detail",
    primarySkill: "verbal.reading.stated-info",
    passage,
    reserve
  })

  test("gives it that passage's Reserve decision once it is checked again", () =>
    runWithWorkers(Effect.gen(function*() {
      const seeded = yield* seedBook("Verbal Review", [
        rc(1, passageA, 10, true),
        rc(2, passageA, 10, true),
        rc(3, passageA, 10, true),
        rc(4, passageB, 12, false),
        rc(5, passageB, 12, false),
        rc(6, passageB, 12, false)
      ])
      const db = yield* Db
      // Stored passages carry their real hash, as linking writes them.
      for (const body of [passageA, passageB]) {
        yield* db.update(stimuli).set({ normalizedHash: sha256(normalizeText(body)) }).where(eq(stimuli.body, body))
          .pipe(Effect.orDie)
      }
      const four = seeded.ids.get(4)!
      const [question] = yield* db.select().from(questions).where(eq(questions.id, four)).pipe(Effect.orDie)
      const [part] = yield* db.select().from(parts).where(and(eq(parts.questionId, four), eq(parts.position, 0)))
        .pipe(Effect.orDie)
      const choices = yield* db.select().from(options).where(eq(options.partId, part!.id)).orderBy(asc(options.position))
        .pipe(Effect.orDie)
      const [onA] = yield* db.select({ id: stimuli.id }).from(stimuli).where(eq(stimuli.body, passageA)).pipe(Effect.orDie)

      // The fixed Book Map's readings give item 4 passage A.
      const candidate: Candidate = {
        _tag: "Candidate",
        number: 4,
        page: 12,
        section: "verbal",
        questionType: "verbal.rc-detail",
        passage: passageA,
        rivalPassage: null,
        stem: question!.stem,
        options: choices.map((choice) => ({ label: choice.label as Letter, text: choice.text })),
        figure: false,
        answerKey: "C",
        explanationAnswer: "C",
        key: "C",
        keyAnswers: [],
        explanationAnswers: [],
        explanation: "Route 1.",
        label: null
      }
      const outcome = yield* linkCandidate(
        { bookId: seeded.bookId, set: "Reading Comprehension", mapVersion: 2, candidate, origin: { model: "m", promptVersion: "p" } },
        yield* loadBank("verbal"),
        yield* loadPassages
      )
      expect(outcome.linked).toBe("relinked")
      // Its decision, tags and Approaches are made again with its new passage.
      const [moved] = yield* db.select().from(questions).where(eq(questions.id, four)).pipe(Effect.orDie)
      expect(moved).toMatchObject({ stimulusId: onA!.id, status: "draft", reserve: null, taggedAt: null, enrichment: "key-content" })

      // The gate publishes it again, and the Book's Reserve decision is made.
      yield* db.update(questions).set({ status: "published" }).where(eq(questions.id, four)).pipe(Effect.orDie)
      yield* assignReserve(seeded.bookId).pipe(Effect.orDie)
      const onPassageA = yield* db.select({ reserve: questions.reserve, releasedAt: questions.releasedAt })
        .from(questions).where(eq(questions.stimulusId, onA!.id)).pipe(Effect.orDie)
      expect(onPassageA).toHaveLength(4)
      expect(onPassageA.every((row) => row.reserve === true && row.releasedAt === null)).toBe(true)
      const planned = yield* practised
      expect(planned.toSorted()).toEqual([seeded.ids.get(5)!, seeded.ids.get(6)!].toSorted())
    })))
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
