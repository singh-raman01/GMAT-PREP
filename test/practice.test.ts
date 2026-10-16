import { describe, expect, test } from "bun:test"
import { and, eq, inArray, isNull } from "drizzle-orm"
import { Clock, Effect, Option } from "effect"
import { TestClock } from "effect/testing"
import type { BookId } from "../src/api/Books.ts"
import type { PracticeChoice, PracticeView } from "../src/api/Practice.ts"
import type { QuestionId } from "../src/api/Review.ts"
import { Db } from "../src/server/db/Database.ts"
import { BookExtraction } from "../src/server/books/extractJob.ts"
import {
  books,
  difficulty,
  parts,
  questions,
  responses,
  reviewItems,
  servedQuestions,
  sessions,
  sources
} from "../src/server/db/schema.ts"
import { JobStore } from "../src/server/jobs/JobStore.ts"
import { AllJobKinds } from "../src/server/jobs/kinds/index.ts"
import { FakeLlm } from "../src/server/llm/LlmTransport.ts"
import { ratedResponses } from "../src/server/ratings/rated.ts"
import { assignReserve, releaseOrder } from "../src/server/review/reserve.ts"
import { numbered, OtherPsSkill, PsSkill, seedBook, type SeedQuestion } from "./fixtures/bank.ts"
import { openBrowser, openInspectableBrowser, runWithWorkers } from "./harness.ts"

const learner = (name: string) =>
  Effect.gen(function*() {
    const api = yield* openBrowser
    const profile = yield* api.profiles.create({ payload: { name } })
    return { api, profileId: profile.id }
  })
type Learner = Effect.Success<ReturnType<typeof learner>>

const curator = Effect.gen(function*() {
  const browser = yield* openInspectableBrowser
  yield* browser.api.curatorAccess.setPassphrase({ payload: { passphrase: "correct horse battery" } })
  Option.getOrThrow(yield* browser.cookie("gp_curator"))
  return browser.api
})

const filters = (settings: Partial<Extract<PracticeChoice, { kind: "filters" }>> = {}): PracticeChoice => ({
  kind: "filters",
  status: "any",
  size: 10,
  ...settings
})

const book = (bookId: string, settings: { set?: string; from?: number; to?: number } = {}): PracticeChoice => ({
  kind: "book",
  bookId: bookId as BookId,
  ...settings
})

// Answers the Question on screen and moves on, until the set has served
// every Question; returns each Question served, in order.
const answerAll = (who: Learner, started: PracticeView, choice = "C") =>
  Effect.gen(function*() {
    let view = started
    const served: Array<string> = []
    while (view.current !== null) {
      const current = view.current
      served.push(current.question.id)
      view = yield* who.api.practice.answer({
        params: { id: view.id },
        payload: { seq: view.nextSeq, questionId: current.question.id, selection: [{ part: 0, choice }], guessed: false }
      })
      if (current.position + 1 >= view.total) break
      view = yield* who.api.practice.next({ params: { id: view.id }, payload: { position: current.position + 1 } })
    }
    return { view, served }
  })

const answer = (who: Learner, view: PracticeView, choice: string, options: { seq?: number; guessed?: boolean } = {}) =>
  who.api.practice.answer({
    params: { id: view.id },
    payload: {
      seq: options.seq ?? view.nextSeq,
      questionId: view.current!.question.id,
      selection: [{ part: 0, choice }],
      guessed: options.guessed ?? false
    }
  })

const preview = (who: Learner, choice: PracticeChoice) => who.api.practice.preview({ payload: { choice } })

describe("Choosing a Practice Set", () => {
  test("a set by Section and Question Type takes published Questions only, serving one at a time", () =>
    runWithWorkers(Effect.gen(function*() {
      const ps = yield* seedBook("Quant Review", [
        ...numbered(12),
        ...numbered(2, { status: "held" }, 13),
        ...numbered(1, { status: "draft" }, 15),
        ...numbered(1, { status: "withdrawn" }, 16)
      ])
      yield* seedBook("Verbal Review", numbered(3, { questionType: "verbal.cr-weaken", primarySkill: "verbal.arguments.causal" }))
      const asha = yield* learner("Asha")

      const started = yield* asha.api.practice.start({
        payload: { choice: filters({ section: "quant", questionType: "quant.ps", size: 10 }) }
      })
      expect(started).toMatchObject({ title: "Problem Solving", timed: false, status: "active", total: 10, nextSeq: 1 })
      expect(started.current).toMatchObject({ position: 0, response: null, debrief: null, bookmarked: false })
      expect(started.current?.question.questionType).toMatchObject({ id: "quant.ps", name: "Problem Solving" })
      expect(started.current?.question.parts[0]?.options.map((option) => option.label)).toEqual(["A", "B", "C", "D", "E"])
      expect(started.results).toHaveLength(1)

      const { view, served } = yield* answerAll(asha, started)
      const published = new Set([...ps.ids].filter(([number]) => number <= 12).map(([, id]) => id))
      expect(served).toHaveLength(10)
      expect(new Set(served).size).toBe(10)
      expect(served.every((id) => published.has(id))).toBe(true)
      expect(view.results.map((result) => result.correct)).toEqual(Array(10).fill(true))

      const verbal = yield* preview(asha, filters({ section: "verbal" }))
      expect(verbal).toMatchObject({ questions: 3, matching: 3 })
    })))

  test("Mock Reserve Questions stay out until the Curator releases them or the Profile has Seen them", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", [...numbered(4), ...numbered(4, { reserve: true }, 5)])
      const asha = yield* learner("Asha")
      expect(yield* preview(asha, filters({ size: 50 }))).toMatchObject({ questions: 4, matching: 4 })

      const admin = yield* curator
      const before = yield* admin.bank.reserve()
      expect(before.find((section) => section.id === "quant")).toMatchObject({ questions: 8, held: 4, released: 0 })
      const after = yield* admin.bank.releaseReserve({ payload: { section: "quant", count: 2 } })
      expect(after.find((section) => section.id === "quant")).toMatchObject({ questions: 8, held: 2, released: 2 })
      expect(yield* preview(asha, filters({ size: 50 }))).toMatchObject({ questions: 6 })

      // A Mock serves a Reserve Question; it opens to this Profile only.
      const db = yield* Db
      const now = yield* Clock.currentTimeMillis
      const [held] = yield* db.select({ id: questions.id }).from(questions)
        .where(and(eq(questions.reserve, true), isNull(questions.releasedAt))).limit(1).pipe(Effect.orDie)
      yield* db.insert(sessions).values({
        id: "mock-1",
        profileId: asha.profileId,
        kind: "mock",
        timed: true,
        config: "{}",
        status: "finished",
        createdAt: now
      }).pipe(Effect.orDie)
      yield* db.insert(servedQuestions).values({ sessionId: "mock-1", position: 0, questionId: held!.id, servedAt: now })
        .pipe(Effect.orDie)
      expect(yield* preview(asha, filters({ size: 50 }))).toMatchObject({ questions: 7 })
      const ravi = yield* learner("Ravi")
      expect(yield* preview(ravi, filters({ size: 50 }))).toMatchObject({ questions: 6 })
    })))

  test("a book-order set follows the printed order and shows unseen Reserve Questions as held for Mocks", () =>
    runWithWorkers(Effect.gen(function*() {
      const seeded = yield* seedBook("Official Guide", [
        { number: 1 },
        { number: 2, page: 10 },
        { number: 3, page: 11, reserve: true },
        { number: 4, page: 9 },
        { number: 5, page: 12, status: "held" },
        { number: 6, page: 13, reserve: true },
        { number: 7, page: 14 },
        { number: 8, page: 15 },
        { number: 1, set: "Data Sufficiency", page: 20, questionType: "di.ds" }
      ])
      const asha = yield* learner("Asha")
      const choice = book(seeded.bookId, { set: "problem solving", from: 2, to: 7 })
      expect(yield* preview(asha, choice)).toMatchObject({ questions: 3, heldForMocks: 2, unavailable: 1 })

      const started = yield* asha.api.practice.start({ payload: { choice } })
      expect(started.title).toBe("Official Guide, problem solving 2 to 7")
      expect(started.heldForMocks.map((item) => item.number)).toEqual([3, 6])
      expect(started.unavailable.map((item) => item.number)).toEqual([5])
      expect(started.total).toBe(3)
      const { served } = yield* answerAll(asha, started)
      const numberOf = new Map([...seeded.ids].map(([number, id]) => [id, number]))
      // Item 4 is printed on page 9, before item 2 on page 10.
      expect(served.map((id) => numberOf.get(id))).toEqual([4, 2, 7])

      const options = yield* asha.api.practice.options()
      expect(options.books).toHaveLength(1)
      expect(options.books[0]?.sets).toEqual([
        { name: "Problem Solving", first: 1, last: 8, questions: 7 },
        { name: "Data Sufficiency", first: 1, last: 1, questions: 1 }
      ])
    })))

  test("Difficulty Band filters read the current Difficulty, not the seed", () =>
    runWithWorkers(Effect.gen(function*() {
      const seeded = yield* seedBook("Quant Review", numbered(3, { seed: 0 }))
      const db = yield* Db
      // As if Rated Responses had moved two of them.
      yield* db.insert(difficulty).values([
        { questionId: seeded.ids.get(1)!, value: 1.2, ratedResponses: 4 },
        { questionId: seeded.ids.get(2)!, value: -0.8, ratedResponses: 4 }
      ]).pipe(Effect.orDie)
      const asha = yield* learner("Asha")
      expect(yield* preview(asha, filters({ band: "hard" }))).toMatchObject({ questions: 1 })
      expect(yield* preview(asha, filters({ band: "easy" }))).toMatchObject({ questions: 1 })
      expect(yield* preview(asha, filters({ band: "medium" }))).toMatchObject({ questions: 1 })

      const started = yield* asha.api.practice.start({ payload: { choice: filters({ band: "hard" }) } })
      expect(started.title).toBe("Every Section, Hard")
      const answered = yield* answer(asha, started, "C")
      expect(answered.current?.question.id).toBe(seeded.ids.get(1) as QuestionId)
      expect(answered.current?.debrief).toMatchObject({ difficulty: 1.2, band: "hard" })
    })))

  test("status filters find unseen, missed and Bookmarked Questions, scored against the current key", () =>
    runWithWorkers(Effect.gen(function*() {
      const seeded = yield* seedBook("Quant Review", numbered(6))
      const asha = yield* learner("Asha")
      let view = yield* asha.api.practice.start({ payload: { choice: filters({ size: 3 }) } })
      const picks = ["A", "C", "B"]
      const served: Array<QuestionId> = []
      for (const [position, pick] of picks.entries()) {
        served.push(view.current!.question.id)
        view = yield* answer(asha, view, pick)
        if (position === 1) {
          view = yield* asha.api.practice.bookmark({
            params: { id: view.id },
            payload: { questionId: view.current!.question.id, bookmarked: true }
          })
          expect(view.current?.bookmarked).toBe(true)
        }
        if (position < 2) view = yield* asha.api.practice.next({ params: { id: view.id }, payload: { position: position + 1 } })
      }
      view = yield* asha.api.practice.finish({ params: { id: view.id } })
      expect(view).toMatchObject({ status: "finished", current: null })
      expect(view.results.map((result) => [result.correct, result.bookmarked])).toEqual([
        [false, false],
        [true, true],
        [false, false]
      ])

      expect(yield* preview(asha, filters({ status: "unseen" }))).toMatchObject({ questions: 3 })
      expect(yield* preview(asha, filters({ status: "missed" }))).toMatchObject({ questions: 2 })
      expect(yield* preview(asha, filters({ status: "bookmarked" }))).toMatchObject({ questions: 1 })
      const missed = yield* asha.api.practice.start({ payload: { choice: filters({ status: "missed" }) } })
      expect(missed.title).toBe("Every Section, missed before")
      expect([served[0], served[2]]).toContain(missed.current!.question.id)

      // A changed key re-scores past Responses: the right answer is now
      // wrong and the wrong one right.
      const db = yield* Db
      yield* db.update(parts).set({ key: "A" }).where(eq(parts.questionId, served[0]!)).pipe(Effect.orDie)
      yield* db.update(parts).set({ key: "D" }).where(eq(parts.questionId, served[1]!)).pipe(Effect.orDie)
      expect(yield* preview(asha, filters({ status: "missed" }))).toMatchObject({ questions: 2 })
      const sets = yield* asha.api.practice.list()
      expect(sets.map((set) => [set.status, set.answered, set.correct])).toEqual([["active", 0, 0], ["finished", 3, 1]])
      expect(seeded.ids.size).toBe(6)
    })))

  test("filters the Taxonomy lacks, or that do not fit together, are refused", () =>
    runWithWorkers(Effect.gen(function*() {
      const seeded = yield* seedBook("Quant Review", numbered(2))
      const asha = yield* learner("Asha")
      const refused = (choice: PracticeChoice) => asha.api.practice.start({ payload: { choice } }).pipe(Effect.flip)
      expect(yield* refused(filters({ section: "physics" }))).toMatchObject({
        _tag: "FiltersInvalid",
        problems: ["There is no Section physics."]
      })
      expect(yield* refused(filters({ section: "verbal", questionType: "quant.ps" }))).toMatchObject({
        _tag: "FiltersInvalid",
        problems: ["Problem Solving is not in Verbal Reasoning."]
      })
      expect(yield* refused(book(seeded.bookId, { from: 1 }))).toMatchObject({ _tag: "FiltersInvalid" })
      expect(yield* refused(book(seeded.bookId, { set: "Problem Solving", from: 2, to: 1 }))).toMatchObject({
        _tag: "FiltersInvalid",
        problems: ["Item 2 comes after item 1."]
      })
      expect(yield* refused(book("no-such-book"))).toMatchObject({ _tag: "BookNotFound" })
      expect(yield* refused(filters({ section: "verbal" }))).toMatchObject({
        _tag: "NoQuestionsMatch",
        heldForMocks: 0,
        unavailable: 0
      })
    })))

  test("a book range whose Questions are all held for Mocks starts nothing and says so", () =>
    runWithWorkers(Effect.gen(function*() {
      const seeded = yield* seedBook("Official Guide", numbered(3, { reserve: true }))
      const asha = yield* learner("Asha")
      const error = yield* asha.api.practice.start({ payload: { choice: book(seeded.bookId) } }).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "NoQuestionsMatch", heldForMocks: 3, unavailable: 0 })
    })))
})

describe("Reading Comprehension passages", () => {
  const passage = (n: number) => `Passage ${n}: the town council met twice before it chose a site.`
  const rc = (number: number, n: number) =>
    ({ number, questionType: "verbal.rc-detail", primarySkill: "verbal.reading.stated-info", passage: passage(n) }) as const

  test("a passage's Questions are served one after another, each beside the passage", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Verbal Review", [rc(1, 1), rc(2, 1), rc(3, 1), rc(4, 2), rc(5, 2), rc(6, 2)])
      yield* seedBook("Quant Review", numbered(4))
      const asha = yield* learner("Asha")
      for (const size of [10, 4]) {
        const started = yield* asha.api.practice.start({ payload: { choice: filters({ size }) } })
        const { view, served } = yield* answerAll(asha, started)
        expect(served).toHaveLength(size)
        const passages = yield* Effect.forEach(
          view.results,
          (result) => asha.api.practice.review({ params: { id: view.id, position: result.position } })
        ).pipe(Effect.map((reviews) => reviews.map((each) => each.question.stimulus)))
        // Each passage's Questions sit together, whatever comes between.
        const runs = passages.filter((text, index) => text !== null && passages[index - 1] !== text)
        expect(new Set(runs).size).toBe(runs.length)
      }
      const started = yield* asha.api.practice.start({ payload: { choice: filters({ section: "verbal", size: 3 }) } })
      expect(started.current?.question.stimulus).toMatch(/^Passage \d/)
    })))

  test("Practise 3 similar serves the Questions it picks about one passage one after another", () =>
    runWithWorkers(Effect.gen(function*() {
      const seeded = yield* seedBook("Verbal Review", [
        rc(1, 1), rc(2, 1), rc(3, 1), rc(4, 2), rc(5, 2), rc(6, 2), rc(7, 3), rc(8, 3), rc(9, 3)
      ])
      const passageOf = new Map([...seeded.ids].map(([number, id]) => [id, Math.ceil(number / 3)] as const))
      const asha = yield* learner("Asha")
      const db = yield* Db
      for (let attempt = 0; attempt < 8; attempt++) {
        const started = yield* asha.api.practice.similar({ payload: { questionId: seeded.ids.get(1)! as QuestionId } })
        const [row] = yield* db.select({ config: sessions.config }).from(sessions).where(eq(sessions.id, started.id))
          .pipe(Effect.orDie)
        const order = (JSON.parse(row!.config) as { readonly planned: ReadonlyArray<string> }).planned
          .map((id) => passageOf.get(id)!)
        const runs = order.filter((n, index) => index === 0 || order[index - 1] !== n)
        expect(new Set(runs).size).toBe(runs.length)
        yield* asha.api.practice.finish({ params: { id: started.id } })
      }
    })))
})

describe("Answering", () => {
  test("a submit sent twice is recorded once, a Response is never edited, and time is the server's", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(3))
      const asha = yield* learner("Asha")
      const started = yield* asha.api.practice.start({ payload: { choice: filters({ size: 3 }) } })
      const first = started.current!.question.id

      // The Question stays unanswered until submitted, so moving on waits.
      const early = yield* asha.api.practice.next({ params: { id: started.id }, payload: { position: 1 } }).pipe(Effect.flip)
      expect(early).toMatchObject({ _tag: "PracticeOutOfStep", reason: "not-answered" })

      yield* TestClock.adjust("42 seconds")
      const answered = yield* answer(asha, started, "B", { seq: 1, guessed: true })
      expect(answered.current?.response).toMatchObject({
        selection: [{ part: 0, choice: "B" }],
        guessed: true,
        timeSpentMs: 42_000,
        correct: false,
        rated: false
      })
      expect(answered.nextSeq).toBe(2)
      const again = yield* answer(asha, started, "B", { seq: 1, guessed: true })
      expect(again.current?.response?.timeSpentMs).toBe(42_000)
      const changed = yield* answer(asha, started, "C", { seq: 2 }).pipe(Effect.flip)
      expect(changed).toMatchObject({ _tag: "PracticeOutOfStep", reason: "answered" })

      const db = yield* Db
      const stored = yield* db.select().from(responses).where(eq(responses.questionId, first)).pipe(Effect.orDie)
      expect(stored.map((row) => [row.seq, JSON.parse(row.selection), row.kind])).toEqual([
        [1, [{ part: 0, choice: "B" }], "first"]
      ])

      const moved = yield* asha.api.practice.next({ params: { id: started.id }, payload: { position: 1 } })
      const movedAgain = yield* asha.api.practice.next({ params: { id: started.id }, payload: { position: 1 } })
      expect(movedAgain.current?.question.id).toBe(moved.current!.question.id)
      expect(movedAgain.results).toHaveLength(2)
      const skipping = yield* asha.api.practice.next({ params: { id: started.id }, payload: { position: 3 } }).pipe(Effect.flip)
      expect(skipping).toMatchObject({ _tag: "PracticeOutOfStep", reason: "not-current" })
      const stale = yield* asha.api.practice.answer({
        params: { id: started.id },
        payload: { seq: 2, questionId: first, selection: [{ part: 0, choice: "C" }], guessed: false }
      }).pipe(Effect.flip)
      expect(stale).toMatchObject({ _tag: "PracticeOutOfStep", reason: "not-current" })
      expect(stale._tag === "PracticeOutOfStep" && stale.view.current?.question.id).toBe(moved.current!.question.id)
    })))

  test("a selection must give one of the Question's own options", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(1))
      const asha = yield* learner("Asha")
      const started = yield* asha.api.practice.start({ payload: { choice: filters() } })
      const send = (selection: ReadonlyArray<{ part: number; choice: string }>) =>
        asha.api.practice.answer({
          params: { id: started.id },
          payload: { seq: 1, questionId: started.current!.question.id, selection, guessed: false }
        }).pipe(Effect.flip)
      expect(yield* send([{ part: 0, choice: "F" }])).toMatchObject({
        _tag: "SelectionInvalid",
        problems: ["F is not an option."]
      })
      expect(yield* send([{ part: 0, choice: "A" }, { part: 0, choice: "B" }])).toMatchObject({
        problems: ["Choose one answer."]
      })
      expect(yield* send([{ part: 1, choice: "A" }])).toMatchObject({
        problems: ["The Question has no Part 2.", "Choose an answer."]
      })
      const db = yield* Db
      expect(yield* db.select().from(responses).pipe(Effect.orDie)).toHaveLength(0)
    })))

  test("every Question served is Seen, answered or not", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(5))
      const asha = yield* learner("Asha")
      const started = yield* asha.api.practice.start({ payload: { choice: filters({ size: 5 }) } })
      const answered = yield* answer(asha, started, "C")
      yield* asha.api.practice.next({ params: { id: answered.id }, payload: { position: 1 } })
      const finished = yield* asha.api.practice.finish({ params: { id: started.id } })
      expect(finished.results.map((result) => result.correct)).toEqual([true, null])
      expect(yield* preview(asha, filters({ status: "unseen" }))).toMatchObject({ questions: 3 })

      // Once the set is over, the unanswered Question's Debrief can be read.
      const review = yield* asha.api.practice.review({ params: { id: started.id, position: 1 } })
      expect(review).toMatchObject({ response: null, debrief: { correct: false } })
      const late = yield* answer(asha, { ...answered, nextSeq: 2 } as PracticeView, "C").pipe(Effect.flip)
      expect(late).toMatchObject({ _tag: "PracticeOutOfStep", reason: "finished" })
    })))

  test("the Debrief shows the Trap Note picked and the Approaches that reach the key, fastest first, with no LLM call", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", [{
        number: 1,
        key: "C",
        approaches: [
          { strategy: "quant.strategy.solve-directly", expectedSeconds: 90, author: "book", validWhen: "Always." },
          { strategy: "quant.strategy.work-backward", expectedSeconds: 60, validWhen: "When the options are numbers." },
          // Written against a key since replaced.
          { strategy: "quant.strategy.pick-numbers", expectedSeconds: 30, answer: "B" }
        ]
      }])
      const asha = yield* learner("Asha")
      const started = yield* asha.api.practice.start({ payload: { choice: filters() } })
      const answered = yield* answer(asha, started, "A")
      const debrief = answered.current!.debrief!
      expect(debrief).toMatchObject({
        correct: false,
        keys: [{ part: 0, key: "C" }],
        skill: { id: PsSkill, name: "Linear equations and systems" },
        band: "medium"
      })
      expect(debrief.trapNotes).toEqual([
        expect.objectContaining({
          part: 0,
          label: "A",
          note: "A tempts by answering a different quantity.",
          mistakeType: expect.objectContaining({ id: "trap", name: "Trap" }),
          trapPattern: expect.objectContaining({ id: "quant.trap.wrong-quantity", name: "Answers a different quantity" })
        })
      ])
      expect(debrief.approaches.map((route) => [route.strategy.name, route.expectedSeconds, route.validWhen, route.fromBook]))
        .toEqual([
          ["Work backward from the options", 60, "When the options are numbers.", false],
          ["Solve directly", 90, "Always.", true]
        ])
      expect(yield* (yield* FakeLlm).requests).toHaveLength(0)
    })))

  test("untimed Responses are never Rated and leave Difficulty where it is", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(4))
      const asha = yield* learner("Asha")
      const started = yield* asha.api.practice.start({ payload: { choice: filters({ size: 4 }) } })
      const { view } = yield* answerAll(asha, started, "A")
      const reviews = yield* Effect.forEach(view.results, (result) =>
        asha.api.practice.review({ params: { id: view.id, position: result.position } }))
      expect(reviews.map((review) => review.response?.rated)).toEqual([false, false, false, false])
      const db = yield* Db
      expect(yield* db.select().from(difficulty).pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* preview(asha, filters({ band: "medium", size: 50 }))).toMatchObject({ questions: 4 })
    })))
})

describe("Rated Responses", () => {
  const served = (questionId: string, sessionId: string | null, timed: boolean, at: number) => ({
    questionId,
    sessionId,
    timed,
    at
  })
  const fact = (id: string, sessionId: string, questionId: string, seq: number, kind = "first") => ({
    id,
    sessionId,
    questionId,
    seq,
    kind
  })

  test("only the final Response in the timed Session that first showed the Question is Rated", () => {
    const rated = ratedResponses(
      [
        served("q1", "timed-1", true, 1),
        served("q1", "timed-2", true, 5),
        served("q2", "untimed", false, 1),
        served("q2", "timed-2", true, 5),
        served("q3", "timed-1", true, 1),
        served("q4", null, false, 0),
        served("q4", "timed-2", true, 5)
      ],
      [
        fact("q1-first", "timed-1", "q1", 1),
        fact("q1-edit", "timed-1", "q1", 4, "edit"),
        fact("q1-later", "timed-2", "q1", 1),
        fact("q2-untimed", "untimed", "q2", 1),
        fact("q2-timed", "timed-2", "q2", 2),
        fact("q3-time-out", "timed-1", "q3", 2, "time-out"),
        fact("q4-after-paper", "timed-2", "q4", 3)
      ]
    )
    expect([...rated]).toEqual(["q1-edit"])
  })

  test("of two servings in the same millisecond, the one recorded first showed the Question first", () => {
    const facts = [fact("untimed-answer", "untimed", "q1", 1), fact("timed-answer", "timed", "q1", 1)]
    const untimedFirst = { ...served("q1", "untimed", false, 7), order: 1 }
    const timedSecond = { ...served("q1", "timed", true, 7), order: 2 }
    expect([...ratedResponses([untimedFirst, timedSecond], facts)]).toEqual([])
    expect([...ratedResponses([timedSecond, untimedFirst], facts)]).toEqual([])
  })
})

describe("Practise 3 similar", () => {
  test("starts an untimed set of unseen Questions with the same primary Skill and Question Type within 0.5", () =>
    runWithWorkers(Effect.gen(function*() {
      const seeded = yield* seedBook("Quant Review", [
        { number: 1, seed: 0 },
        { number: 2, seed: 0.3 },
        { number: 3, seed: -0.5 },
        { number: 4, seed: 0.6 },
        { number: 5, seed: 0, primarySkill: OtherPsSkill, secondarySkills: [PsSkill] },
        { number: 6, seed: 0, reserve: true },
        { number: 7, seed: 0.1, status: "held" },
        { number: 8, seed: 0.2, questionType: "di.ds" }
      ])
      const asha = yield* learner("Asha")
      const first = yield* asha.api.practice.start({
        payload: { choice: book(seeded.bookId, { set: "Problem Solving", from: 1, to: 1 }) }
      })
      const answered = yield* answer(asha, first, "A")
      const similar = yield* asha.api.practice.similar({ payload: { questionId: answered.current!.question.id } })
      expect(similar).toMatchObject({
        title: "Similar: Linear equations and systems, Problem Solving",
        timed: false,
        total: 2,
        requested: 3
      })
      const { served } = yield* answerAll(asha, similar)
      expect(new Set(served)).toEqual(new Set([seeded.ids.get(2)!, seeded.ids.get(3)!]))
      const none = yield* asha.api.practice.similar({ payload: { questionId: answered.current!.question.id } }).pipe(
        Effect.flip
      )
      expect(none).toMatchObject({ _tag: "NoQuestionsMatch" })
      const unknown = yield* asha.api.practice.similar({ payload: { questionId: "nope" as QuestionId } }).pipe(Effect.flip)
      expect(unknown._tag).toBe("QuestionNotFound")
      // The first set waits where it was.
      const sets = yield* asha.api.practice.list()
      expect(sets.map((set) => set.status)).toEqual(["active", "active"])
    })))
})

describe("Profiles keep their own sets", () => {
  test("another Profile can neither open a set nor share its history", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(4))
      const asha = yield* learner("Asha")
      const started = yield* asha.api.practice.start({ payload: { choice: filters({ size: 2 }) } })
      yield* answer(asha, started, "A")
      const ravi = yield* learner("Ravi")
      const error = yield* ravi.api.practice.get({ params: { id: started.id } }).pipe(Effect.flip)
      expect(error._tag).toBe("PracticeNotFound")
      expect(yield* preview(ravi, filters({ status: "unseen" }))).toMatchObject({ questions: 4 })
      expect(yield* preview(ravi, filters({ status: "missed" }))).toMatchObject({ questions: 0 })
      expect(yield* ravi.api.practice.list()).toHaveLength(0)
    })))
})

describe("Responses are facts", () => {
  test("a Question merged away after a Session served it is withdrawn, so its Responses stay", () =>
    runWithWorkers(Effect.gen(function*() {
      const seeded = yield* seedBook("Quant Review", numbered(2))
      const asha = yield* learner("Asha")
      const started = yield* asha.api.practice.start({
        payload: { choice: book(seeded.bookId, { set: "Problem Solving", from: 2, to: 2 }) }
      })
      yield* answer(asha, started, "A")
      // A Book Map fix later finds it repeats item 1, and holds it.
      const db = yield* Db
      const now = yield* Clock.currentTimeMillis
      const repeat = seeded.ids.get(2)!
      yield* db.update(questions).set({ status: "held", relatedQuestionId: seeded.ids.get(1)! })
        .where(eq(questions.id, repeat)).pipe(Effect.orDie)
      yield* db.insert(reviewItems).values({
        id: "item-1",
        questionId: repeat,
        reasons: JSON.stringify([{ code: "near-match", detail: "Close to item 1." }]),
        relatedQuestionId: seeded.ids.get(1)!,
        status: "open",
        createdAt: now
      }).pipe(Effect.orDie)
      const admin = yield* curator
      yield* admin.review.merge({ params: { id: "item-1" as never } })
      const [kept] = yield* db.select({ status: questions.status }).from(questions).where(eq(questions.id, repeat))
        .pipe(Effect.orDie)
      expect(kept?.status).toBe("withdrawn")
      expect(yield* db.select().from(responses).where(eq(responses.questionId, repeat)).pipe(Effect.orDie)).toHaveLength(1)
      const review = yield* asha.api.practice.review({ params: { id: started.id, position: 0 } })
      expect(review.response?.correct).toBe(false)
    })))
})

describe("Releasing the Mock Reserve", () => {
  test("release takes from the fullest Question Type and Band first, so the Reserve keeps its spread", () => {
    const held = [
      ...["a", "b", "c", "d"].map((hash) => ({
        id: `medium-${hash}`,
        size: 1,
        questionType: "quant.ps",
        band: "medium" as const,
        hash
      })),
      ...["a", "b"].map((hash) => ({ id: `hard-${hash}`, size: 1, questionType: "quant.ps", band: "hard" as const, hash }))
    ]
    expect(releaseOrder(held, 3)).toEqual(["medium-d", "medium-c", "hard-b"])
    expect(releaseOrder(held, 10)).toHaveLength(6)
  })

  test("a passage is released whole, and one larger than what is left to release is passed over", () => {
    const passage = (id: string, size: number, hash: string) =>
      ({ id, size, questionType: "verbal.rc-detail", band: "medium" as const, hash })
    const single = { id: "cr", size: 1, questionType: "verbal.cr-weaken", band: "medium" as const, hash: "z" }
    const held = [passage("p1", 4, "a"), passage("p2", 3, "b"), single]
    // The passages hold the most, so the later one in hash order goes first;
    // then only the single Question still fits.
    expect(releaseOrder(held, 4)).toEqual(["p2", "cr"])
    expect(releaseOrder(held, 2)).toEqual(["cr"])
    expect(releaseOrder(held, 8)).toEqual(["p2", "p1", "cr"])
  })

  test("a Section the Taxonomy lacks is refused", () =>
    runWithWorkers(Effect.gen(function*() {
      const admin = yield* curator
      const error = yield* admin.bank.releaseReserve({ payload: { section: "physics", count: 1 } }).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "UnknownSection", section: "physics" })
    })))

  const passage = "The council met twice before it chose a site for the library."
  const rc = (number: number, settings: Partial<SeedQuestion> = {}): SeedQuestion =>
    ({ number, questionType: "verbal.rc-detail", primarySkill: "verbal.reading.stated-info", passage, ...settings })
  const shown = (who: Learner) =>
    preview(who, filters({ section: "verbal" })).pipe(Effect.map((each) => each.questions))
  const releasedOf = (ids: ReadonlyArray<string>) =>
    Effect.gen(function*() {
      const db = yield* Db
      const rows = yield* db.select({ releasedAt: questions.releasedAt }).from(questions)
        .where(inArray(questions.id, [...ids])).pipe(Effect.orDie)
      return rows.filter((row) => row.releasedAt !== null).length
    })

  test("a passage is released with a Question of it being checked again at the time", () =>
    runWithWorkers(Effect.gen(function*() {
      const seeded = yield* seedBook("Verbal Review", [1, 2, 3].map((n) => rc(n, { reserve: true })))
      const db = yield* Db
      const third = seeded.ids.get(3)!
      yield* db.update(questions).set({ status: "held" }).where(eq(questions.id, third)).pipe(Effect.orDie)
      const admin = yield* curator
      yield* admin.bank.releaseReserve({ payload: { section: "verbal", count: 3 } })
      expect(yield* releasedOf([...seeded.ids.values()])).toBe(3)
      yield* db.update(questions).set({ status: "published" }).where(eq(questions.id, third)).pipe(Effect.orDie)
      expect(yield* shown(yield* learner("Asha"))).toBe(3)
    })))

  test("a passage in the Reserve that a later Question takes past every slot is released", () =>
    runWithWorkers(Effect.gen(function*() {
      const seeded = yield* seedBook("Verbal Review", [1, 2, 3, 4, 5].map((n) => rc(n, { reserve: true })))
      const db = yield* Db
      // Held at the run's end, so undecided, and published later.
      yield* db.update(questions).set({ reserve: null, reserveDecidedAt: null }).where(eq(questions.id, seeded.ids.get(5)!))
        .pipe(Effect.orDie)
      yield* assignReserve(seeded.bookId).pipe(Effect.orDie)
      expect(yield* releasedOf([...seeded.ids.values()])).toBe(5)
      expect(yield* shown(yield* learner("Asha"))).toBe(5)
    })))

  test("a passage in the Reserve left too small by a withdrawal is released", () =>
    runWithWorkers(Effect.gen(function*() {
      const seeded = yield* seedBook("Verbal Review", [1, 2, 3].map((n) => rc(n, { reserve: true })))
      const db = yield* Db
      const now = yield* Clock.currentTimeMillis
      const third = seeded.ids.get(3)!
      yield* db.update(questions).set({ status: "held" }).where(eq(questions.id, third)).pipe(Effect.orDie)
      const itemId = crypto.randomUUID()
      yield* db.insert(reviewItems).values({
        id: itemId,
        questionId: third,
        reasons: JSON.stringify([{ code: "solver-disagreement", detail: "Solves disagree." }]),
        status: "open",
        createdAt: now
      }).pipe(Effect.orDie)
      const admin = yield* curator
      yield* admin.review.withdraw({ params: { id: itemId as never } })
      expect(yield* releasedOf([seeded.ids.get(1)!, seeded.ids.get(2)!])).toBe(2)
      expect(yield* shown(yield* learner("Asha"))).toBe(2)
    })))
})

// Puts a Question in the Review Queue as a repeat of another, as a Book Map
// fix's check would.
const holdAsRepeat = (questionId: string, of: string, itemId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const now = yield* Clock.currentTimeMillis
    yield* db.update(questions).set({ status: "held", relatedQuestionId: of }).where(eq(questions.id, questionId))
      .pipe(Effect.orDie)
    yield* db.insert(reviewItems).values({
      id: itemId,
      questionId,
      reasons: JSON.stringify([{ code: "near-match", detail: "Close to the other item." }]),
      relatedQuestionId: of,
      status: "open",
      createdAt: now
    }).pipe(Effect.orDie)
  })

describe("When the Question Bank changes under a set", () => {
  test("Questions whose Reserve decision is still to come stay out, and a run that stops makes the decision", () =>
    runWithWorkers(Effect.gen(function*() {
      const seeded = yield* seedBook("Quant Review", numbered(8))
      const db = yield* Db
      // As while the Book's run goes on: published, the Reserve not decided.
      yield* db.update(questions).set({ reserve: null, reserveDecidedAt: null })
        .where(inArray(questions.id, [...seeded.ids.values()])).pipe(Effect.orDie)
      const store = yield* JobStore
      const run = yield* store.create(BookExtraction, { bookId: seeded.bookId, title: "Quant Review", mapVersion: 1 }, 1)
      yield* db.update(books).set({ status: "extracting", jobId: run.id }).where(eq(books.id, seeded.bookId))
        .pipe(Effect.orDie)
      const asha = yield* learner("Asha")
      expect(yield* preview(asha, filters({ size: 50 }))).toMatchObject({ questions: 0 })
      const inOrder = yield* preview(asha, book(seeded.bookId))
      expect(inOrder).toMatchObject({ questions: 0, heldForMocks: 8 })

      // The Curator cancels the run: what it published gets its decision.
      yield* store.cancel(run.id)
      const decided = yield* db.select({ reserve: questions.reserve }).from(questions)
        .where(inArray(questions.id, [...seeded.ids.values()])).pipe(Effect.orDie)
      expect(decided.filter((row) => row.reserve === null)).toHaveLength(0)
      expect(decided.filter((row) => row.reserve === true)).toHaveLength(2)
      expect(yield* preview(asha, filters({ size: 50 }))).toMatchObject({ questions: 6 })
    }), AllJobKinds))

  test("a planned Question merged into one the set already has leaves the set, which ends when nothing is left", () =>
    runWithWorkers(Effect.gen(function*() {
      const seeded = yield* seedBook("Quant Review", numbered(2))
      const asha = yield* learner("Asha")
      const started = yield* asha.api.practice.start({ payload: { choice: book(seeded.bookId) } })
      expect(started.total).toBe(2)
      // Item 2, planned but not served, is merged into item 1, on screen.
      yield* holdAsRepeat(seeded.ids.get(2)!, seeded.ids.get(1)!, "item-planned")
      yield* (yield* curator).review.merge({ params: { id: "item-planned" as never } })
      const answered = yield* answer(asha, started, "C")
      const ended = yield* asha.api.practice.next({ params: { id: answered.id }, payload: { position: 1 } })
      expect(ended).toMatchObject({ status: "finished", total: 1 })
      expect(ended.results).toHaveLength(1)
      // Asking past the plan is still refused.
      const past = yield* asha.api.practice.next({ params: { id: answered.id }, payload: { position: 2 } }).pipe(Effect.flip)
      expect(past).toMatchObject({ _tag: "PracticeOutOfStep", reason: "finished" })
    })))

  test("a planned Question merged into one the set lacks gives way to it", () =>
    runWithWorkers(Effect.gen(function*() {
      const seeded = yield* seedBook("Quant Review", numbered(3))
      const asha = yield* learner("Asha")
      const started = yield* asha.api.practice.start({
        payload: { choice: book(seeded.bookId, { set: "Problem Solving", from: 1, to: 2 }) }
      })
      yield* holdAsRepeat(seeded.ids.get(2)!, seeded.ids.get(3)!, "item-planned")
      yield* (yield* curator).review.merge({ params: { id: "item-planned" as never } })
      yield* answer(asha, started, "C")
      const next = yield* asha.api.practice.next({ params: { id: started.id }, payload: { position: 1 } })
      expect(next.current?.question.id).toBe(seeded.ids.get(3)! as QuestionId)
      const db = yield* Db
      const [twin] = yield* db.select().from(questions).where(eq(questions.id, seeded.ids.get(2)!)).pipe(Effect.orDie)
      expect(twin).toMatchObject({ status: "withdrawn", mergedInto: seeded.ids.get(3)! })
      const [item] = yield* db.select().from(reviewItems).where(eq(reviewItems.id, "item-planned")).pipe(Effect.orDie)
      expect(item).toMatchObject({ decision: "merged", questionId: seeded.ids.get(2)! })
    })))

  test("history with a merged Question counts for the Question it joined", () =>
    runWithWorkers(Effect.gen(function*() {
      const seeded = yield* seedBook("Quant Review", numbered(2))
      const asha = yield* learner("Asha")
      const started = yield* asha.api.practice.start({
        payload: { choice: book(seeded.bookId, { set: "Problem Solving", from: 2, to: 2 }) }
      })
      // Asha misses item 2 and Bookmarks it; it is then merged into item 1.
      yield* answer(asha, started, "A")
      yield* asha.api.practice.bookmark({
        params: { id: started.id },
        payload: { questionId: seeded.ids.get(2)! as QuestionId, bookmarked: true }
      })
      yield* holdAsRepeat(seeded.ids.get(2)!, seeded.ids.get(1)!, "item-twin")
      yield* (yield* curator).review.merge({ params: { id: "item-twin" as never } })
      expect(yield* preview(asha, filters({ status: "missed" }))).toMatchObject({ questions: 1 })
      expect(yield* preview(asha, filters({ status: "unseen" }))).toMatchObject({ questions: 0 })
      const marked = yield* asha.api.practice.start({ payload: { choice: filters({ status: "bookmarked" }) } })
      expect(marked.current).toMatchObject({ question: { id: seeded.ids.get(1)! }, bookmarked: true })
    })))

  test("a Bookmark is the Profile's: a later set shows it, and clearing it there clears it", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(3))
      const asha = yield* learner("Asha")
      const first = yield* asha.api.practice.start({ payload: { choice: filters({ size: 1 }) } })
      const marked = first.current!.question.id
      yield* asha.api.practice.bookmark({ params: { id: first.id }, payload: { questionId: marked, bookmarked: true } })
      yield* asha.api.practice.finish({ params: { id: first.id } })
      const second = yield* asha.api.practice.start({ payload: { choice: filters({ status: "bookmarked" }) } })
      expect(second.current).toMatchObject({ question: { id: marked }, bookmarked: true })
      const cleared = yield* asha.api.practice.bookmark({
        params: { id: second.id },
        payload: { questionId: marked, bookmarked: false }
      })
      expect(cleared.current?.bookmarked).toBe(false)
      expect(yield* preview(asha, filters({ status: "bookmarked" }))).toMatchObject({ questions: 0 })
      // The first set's summary agrees.
      expect((yield* asha.api.practice.get({ params: { id: first.id } })).results[0]?.bookmarked).toBe(false)
    })))

  test("Trap Notes written for a key since changed wait to be written again", () =>
    runWithWorkers(Effect.gen(function*() {
      const seeded = yield* seedBook("Quant Review", [{ number: 1, key: "C" }])
      const asha = yield* learner("Asha")
      const started = yield* asha.api.practice.start({ payload: { choice: filters() } })
      const questionId = seeded.ids.get(1)!
      const db = yield* Db
      const now = yield* Clock.currentTimeMillis
      yield* db.update(questions).set({ status: "held" }).where(eq(questions.id, questionId)).pipe(Effect.orDie)
      yield* db.insert(reviewItems).values({
        id: "item-key",
        questionId,
        reasons: JSON.stringify([{ code: "solver-disagreement", detail: "Solvers say B." }]),
        relatedQuestionId: null,
        status: "open",
        createdAt: now
      }).pipe(Effect.orDie)
      yield* (yield* curator).review.overrideKey({
        params: { id: "item-key" as never },
        payload: { key: "B", reason: "Erratum" }
      })
      const debrief = (yield* answer(asha, started, "D")).current!.debrief!
      expect(debrief.keys).toEqual([{ part: 0, key: "B" }])
      expect(debrief.trapNotes).toEqual([])
      expect(debrief.approaches).toEqual([])
    })))
})

describe("Book order", () => {
  test("a Question the Book prints twice shows the item the set serves it at", () =>
    runWithWorkers(Effect.gen(function*() {
      const seeded = yield* seedBook("Official Guide", [{ number: 3, set: "Chapter 1", page: 3 }])
      const db = yield* Db
      const now = yield* Clock.currentTimeMillis
      // The same Question, linked earlier from the Book's review set.
      yield* db.insert(sources).values({
        id: crypto.randomUUID(),
        questionId: seeded.ids.get(3)!,
        bookId: seeded.bookId,
        set: "Review",
        number: 7,
        page: 40,
        bookKey: "C",
        explanation: null,
        explanationAnswer: null,
        merged: true,
        mapVersion: 1,
        createdAt: now - 1000
      }).pipe(Effect.orDie)
      const asha = yield* learner("Asha")
      const started = yield* asha.api.practice.start({ payload: { choice: book(seeded.bookId, { set: "Chapter 1" }) } })
      expect(started.current?.question.source).toMatchObject({ set: "Chapter 1", number: 3, page: 3 })
    })))

  test("on a page two sets share, the set that started first comes first", () =>
    runWithWorkers(Effect.gen(function*() {
      const seeded = yield* seedBook("Official Guide", [
        { number: 28, set: "Set A", page: 4 },
        { number: 29, set: "Set A", page: 5 },
        { number: 30, set: "Set A", page: 5 },
        { number: 1, set: "Set B", page: 5 },
        { number: 2, set: "Set B", page: 6 }
      ])
      const asha = yield* learner("Asha")
      const started = yield* asha.api.practice.start({ payload: { choice: book(seeded.bookId) } })
      const { served } = yield* answerAll(asha, started)
      const numberOf = new Map([...seeded.ids].map(([number, id]) => [id, number]))
      expect(served.map((id) => numberOf.get(id))).toEqual([28, 29, 30, 1, 2])
    })))

  test("skipped items say why, and a set's range counts every item it prints", () =>
    runWithWorkers(Effect.gen(function*() {
      const seeded = yield* seedBook("Official Guide", [
        { number: 1 },
        { number: 2, status: "withdrawn" },
        { number: 3, status: "held" },
        { number: 4, reserve: true },
        { number: 5 }
      ])
      const asha = yield* learner("Asha")
      const started = yield* asha.api.practice.start({ payload: { choice: book(seeded.bookId) } })
      expect(started.unavailable).toMatchObject([{ number: 2, reason: "withdrawn" }, { number: 3, reason: "checking" }])
      expect(started.heldForMocks).toMatchObject([{ number: 4, reason: "reserve" }])
      const options = yield* asha.api.practice.options()
      expect(options.books[0]?.sets).toEqual([{ name: "Problem Solving", first: 1, last: 5, questions: 3 }])
    })))
})

describe("Sets and submits", () => {
  test("every set is listed", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(3))
      const asha = yield* learner("Asha")
      for (let i = 0; i < 22; i++) {
        const set = yield* asha.api.practice.start({ payload: { choice: filters({ size: 1 }) } })
        yield* asha.api.practice.finish({ params: { id: set.id } })
      }
      expect(yield* asha.api.practice.list()).toHaveLength(22)
    })))

  test("a sequence number used again for another Question or answer is refused", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(2))
      const asha = yield* learner("Asha")
      const started = yield* asha.api.practice.start({ payload: { choice: filters({ size: 2 }) } })
      yield* answer(asha, started, "C", { seq: 1 })
      // The same submit again is recorded once; another with its number is not.
      expect((yield* answer(asha, started, "C", { seq: 1 })).current?.response?.selection).toEqual([{ part: 0, choice: "C" }])
      const changed = yield* answer(asha, started, "A", { seq: 1 }).pipe(Effect.flip)
      expect(changed).toMatchObject({ _tag: "PracticeOutOfStep", reason: "not-current" })
      const second = yield* asha.api.practice.next({ params: { id: started.id }, payload: { position: 1 } })
      const stale = yield* answer(asha, second, "A", { seq: 1 }).pipe(Effect.flip)
      expect(stale).toMatchObject({ _tag: "PracticeOutOfStep", reason: "not-current" })
    })))
})

