import { describe, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Effect, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { Api } from "../src/api/Api.ts"
import { DefaultBlueprint } from "../src/api/blueprint.ts"
import { BookId } from "../src/api/Books.ts"
import { cursorOf, type ErrorLogFilters } from "../src/api/ErrorLog.ts"
import type { PracticeChoice, PracticeView } from "../src/api/Practice.ts"
import { QuestionId } from "../src/api/Review.ts"
import { Db } from "../src/server/db/Database.ts"
import { parts, questions, responses, sessions, sources } from "../src/server/db/schema.ts"
import { encodeConfig } from "../src/server/sections/config.ts"
import { numbered, OtherPsSkill, seedBook } from "./fixtures/bank.ts"
import { seedExamBank, SmallBlueprint } from "./fixtures/examBank.ts"
import { openBrowser, runWithWorkers } from "./harness.ts"

// One tab of a browser that names itself as a device.
const learner = (name: string) =>
  Effect.gen(function*() {
    const jar = yield* Ref.make(Cookies.empty)
    const tab = yield* HttpApiClient.make(Api, {
      transformClient: (client) =>
        client.pipe(HttpClient.withCookiesRef(jar), HttpClient.mapRequest(HttpClientRequest.setHeader("x-gp-device", "tab-1")))
    })
    const profile = yield* tab.profiles.create({ payload: { name, timeZone: "UTC" } })
    return Object.assign(tab, { profileId: profile.id })
  })
type Tab = Effect.Success<ReturnType<typeof learner>>

const untimed = (size = 3): PracticeChoice => ({ kind: "filters", status: "any", size })
const timed = (size = 3): PracticeChoice => ({ kind: "filters", status: "any", size, timed: true })

// Answers the Question on screen after the given time, and in an untimed set
// moves on to the next.
const answer = (tab: Tab, view: PracticeView, choice: string, options: { seconds?: number; guessed?: boolean } = {}) =>
  Effect.gen(function*() {
    yield* TestClock.adjust(`${options.seconds ?? 60} seconds`)
    const current = view.current!
    const answered = yield* tab.practice.answer({
      params: { id: view.id },
      payload: {
        seq: view.nextSeq,
        questionId: current.question.id,
        selection: [{ part: 0, choice }],
        guessed: options.guessed ?? false
      }
    })
    if (view.timed || current.position + 1 >= answered.total) return answered
    return yield* tab.practice.next({ params: { id: view.id }, payload: { position: current.position + 1 } })
  })

const list = (tab: Tab, filters: ErrorLogFilters = {}) => tab.errorLog.list({ query: filters })

describe("The Error Log", () => {
  test("takes an untimed set's wrong answers at once, with the picked option's Mistake Type, the latest first", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(3))
      const asha = yield* learner("Asha")
      let view = yield* asha.practice.start({ payload: { choice: untimed() } })
      const ids = [] as Array<QuestionId>
      for (const choice of ["A", "C", "B"]) {
        ids.push(view.current!.question.id)
        view = yield* answer(asha, view, choice)
      }
      const log = yield* list(asha)
      expect(log.total).toBe(2)
      expect(log.entries.map((entry) => [entry.questionId, entry.reasons, entry.parts.map((part) => [part.picked, part.mistakeType?.name, part.trapPattern?.id ?? null])]))
        .toEqual([
          [ids[2]!, ["wrong"], [["B", "Calculation slip", null]]],
          [ids[0]!, ["wrong"], [["A", "Trap", "quant.trap.wrong-quantity"]]]
        ])
      expect(log.entries[0]).toMatchObject({ section: { id: "quant" }, questionType: { id: "quant.ps" }, status: "open", misses: 1, band: "medium" })
      expect(log.entries[0]!.books.map((book) => book.name)).toEqual(["Quant Review"])
      expect(log.facets.mistakeTypes.map((each) => [each.name, each.entries])).toEqual([["Calculation slip", 1], ["Trap", 1]])
      expect(log.facets.statuses).toEqual([{ id: "open", name: "Open", entries: 2 }])
    })))

  test("takes a timed set's misses when it ends, with slow and guessed answers, and time pressure for a rushed one", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(4))
      const asha = yield* learner("Asha")
      let view = yield* asha.practice.start({ payload: { choice: timed(4) } })
      // Target Time is 129 seconds: 194 is slow, 32 is rushed.
      view = yield* answer(asha, view, "C", { seconds: 194 })
      view = yield* answer(asha, view, "A", { seconds: 60 })
      view = yield* answer(asha, view, "C", { seconds: 60, guessed: true })
      expect((yield* list(asha)).total).toBe(0)
      view = yield* answer(asha, view, "B", { seconds: 32 })
      expect(view.status).toBe("finished")
      const log = yield* list(asha)
      expect(log.entries.map((entry) => [entry.reasons, entry.parts.map((part) => part.mistakeType?.id)]).toSorted()).toEqual([
        [["guessed"], []],
        [["slow"], []],
        [["wrong"], ["time-pressure"]],
        [["wrong"], ["trap"]]
      ].toSorted())
      expect((yield* list(asha, { mistakeType: "slow" })).entries.map((entry) => entry.reasons)).toEqual([["slow"]])
      expect((yield* list(asha, { mistakeType: "guessed" })).entries).toHaveLength(1)
      expect((yield* list(asha, { mistakeType: "time-pressure" })).entries).toHaveLength(1)
      expect(log.facets.mistakeTypes.map((each) => each.name)).toEqual(["Guessed", "Slow", "Time pressure", "Trap"])
    })))

  test("keeps the Learner's Mistake Type as a fact, through a key change", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(1))
      const asha = yield* learner("Asha")
      const view = yield* asha.practice.start({ payload: { choice: untimed(1) } })
      const questionId = view.current!.question.id
      yield* answer(asha, view, "A")
      const [entry] = (yield* list(asha)).entries
      const changed = yield* asha.errorLog.setMistakeType({
        params: { questionId },
        payload: { responseId: entry!.responseId, part: 0, mistakeType: "misread" }
      })
      expect(changed.parts[0]).toMatchObject({ mistakeType: { id: "misread", name: "Misread" }, basis: "learner" })
      // The Curator changes the key to B: A is still wrong, and the label stays.
      const db = yield* Db
      yield* db.update(parts).set({ key: "B" }).where(eq(parts.questionId, questionId)).pipe(Effect.orDie)
      expect((yield* list(asha, { mistakeType: "misread" })).entries.map((each) => each.parts[0]!.basis)).toEqual(["learner"])
      // A key of A makes the answer right, and the entry goes.
      yield* db.update(parts).set({ key: "A" }).where(eq(parts.questionId, questionId)).pipe(Effect.orDie)
      expect((yield* list(asha)).total).toBe(0)

      yield* db.update(parts).set({ key: "C" }).where(eq(parts.questionId, questionId)).pipe(Effect.orDie)
      const unknown = yield* asha.errorLog.setMistakeType({
        params: { questionId },
        payload: { responseId: entry!.responseId, part: 0, mistakeType: "bad-luck" }
      }).pipe(Effect.flip)
      expect(unknown).toMatchObject({ _tag: "MistakeTypeInvalid", problem: "There is no Mistake Type bad-luck." })
      const noPart = yield* asha.errorLog.setMistakeType({
        params: { questionId },
        payload: { responseId: entry!.responseId, part: 1, mistakeType: "trap" }
      }).pipe(Effect.flip)
      expect(noPart._tag).toBe("MistakeTypeInvalid")
      const ben = yield* learner("Ben")
      const notHis = yield* ben.errorLog.setMistakeType({
        params: { questionId },
        payload: { responseId: entry!.responseId, part: 0, mistakeType: "trap" }
      }).pipe(Effect.flip)
      expect(notHis._tag).toBe("ErrorLogEntryNotFound")
    })))

  test("shows a wrong answer's Mistake Types with its Debrief, where the Learner can change them", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(2))
      const asha = yield* learner("Asha")
      const view = yield* asha.practice.start({ payload: { choice: untimed(2) } })
      yield* TestClock.adjust("60 seconds")
      const answered = yield* asha.practice.answer({
        params: { id: view.id },
        payload: { seq: view.nextSeq, questionId: view.current!.question.id, selection: [{ part: 0, choice: "A" }], guessed: false }
      })
      const mistakes = answered.current!.mistakes!
      expect(mistakes.parts.map((part) => [part.picked, part.mistakeType?.id, part.basis])).toEqual([["A", "trap", "option"]])
      expect(mistakes.choices.map((choice) => choice.id)).toEqual([
        "concept-gap",
        "wrong-approach",
        "trap",
        "calculation-slip",
        "misread",
        "time-pressure"
      ])
      yield* asha.errorLog.setMistakeType({
        params: { questionId: mistakes.questionId },
        payload: { responseId: mistakes.responseId, part: 0, mistakeType: "concept-gap" }
      })
      const again = yield* asha.practice.get({ params: { id: view.id } })
      expect(again.current!.mistakes!.parts[0]).toMatchObject({ mistakeType: { id: "concept-gap" }, basis: "learner" })
      // A right answer has none.
      const next = yield* asha.practice.next({ params: { id: view.id }, payload: { position: 1 } })
      yield* TestClock.adjust("60 seconds")
      const right = yield* asha.practice.answer({
        params: { id: view.id },
        payload: { seq: next.nextSeq, questionId: next.current!.question.id, selection: [{ part: 0, choice: "C" }], guessed: false }
      })
      expect(right.current!.mistakes).toBeNull()
    })))

  test("holds every Response to the Question, with the Debrief of the latest miss", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(1))
      const asha = yield* learner("Asha")
      const first = yield* asha.practice.start({ payload: { choice: untimed(1) } })
      const questionId = first.current!.question.id
      yield* answer(asha, first, "E")
      const second = yield* asha.practice.start({ payload: { choice: untimed(1) } })
      expect(second.current!.question.id).toBe(questionId)
      yield* answer(asha, second, "C")
      const detail = yield* asha.errorLog.get({ params: { questionId } })
      expect(detail.entry).toMatchObject({ misses: 1, reasons: ["wrong"] })
      expect(detail.history.map((item) => [item.sessionKind, item.correct, item.reasons])).toEqual([
        ["practice", false, ["wrong"]],
        ["practice", true, []]
      ])
      expect(detail.served.debrief!.trapNotes.map((note) => note.label)).toEqual(["E"])
      expect(detail.served.question.id).toBe(questionId)
      expect(detail.served.response).toMatchObject({ selection: [{ part: 0, choice: "E" }], correct: false, rated: false })
      expect(detail.served.mistakes!.parts.map((part) => part.picked)).toEqual(["E"])
      expect(yield* asha.errorLog.get({ params: { questionId: QuestionId.make(crypto.randomUUID()) } })
        .pipe(Effect.flip, Effect.map((error) => error._tag))).toBe("ErrorLogEntryNotFound")
    })))

  test("filters by Skill, Question Type, Book, Difficulty Band, Trap Pattern, status and day", () =>
    runWithWorkers(Effect.gen(function*() {
      const og = yield* seedBook("Official Guide", numbered(2, { seed: 1.5 }))
      yield* seedBook("Review Book", numbered(2, { primarySkill: OtherPsSkill, secondarySkills: ["quant.number-properties.divisibility"] }, 3))
      const asha = yield* learner("Asha")
      // One miss a day, from the Official Guide first.
      for (let day = 0; day < 4; day++) {
        const view = yield* asha.practice.start({
          payload: { choice: { kind: "filters", status: "unseen", size: 1, band: day < 2 ? "hard" : "medium" } }
        })
        yield* answer(asha, view, day % 2 === 0 ? "A" : "B")
        yield* TestClock.adjust("1 day")
        // A day idle ends the unlock.
        yield* asha.profiles.unlock({ params: { id: asha.profileId }, payload: {} })
      }
      const all = yield* list(asha)
      expect(all.total).toBe(4)
      const count = (filters: ErrorLogFilters) => list(asha, filters).pipe(Effect.map((log) => log.entries.length))
      expect(yield* count({ book: og.bookId })).toBe(2)
      expect(yield* count({ band: "hard" })).toBe(2)
      expect(yield* count({ skill: OtherPsSkill })).toBe(2)
      expect(yield* count({ skill: "quant.number-properties.divisibility" })).toBe(2)
      expect(yield* count({ questionType: "quant.ps", section: "quant" })).toBe(4)
      expect(yield* count({ trapPattern: "quant.trap.wrong-quantity" })).toBe(2)
      expect(yield* count({ mistakeType: "calculation-slip" })).toBe(2)
      // The first miss was on 1 January 1970, at the fake clock's start.
      expect(yield* count({ from: "1970-01-02", to: "1970-01-03" })).toBe(2)
      expect(all.facets.books.map((book) => [book.name, book.entries])).toEqual([["Official Guide", 2], ["Review Book", 2]])
      // A Withdrawn Question's entry closes as withdrawn.
      const db = yield* Db
      yield* db.update(questions).set({ status: "withdrawn" }).where(eq(questions.id, og.ids.get(1)!)).pipe(Effect.orDie)
      expect((yield* list(asha, { status: "withdrawn" })).entries.map((entry) => String(entry.questionId))).toEqual([og.ids.get(1)!])
      expect(yield* count({ status: "open" })).toBe(3)
    })))
})

describe("Sections in the Error Log", () => {
  test("a Sectional's misses enter when it closes, and an answer fixed in Review & Edit stays out", () =>
    runWithWorkers(Effect.gen(function*() {
      const curator = yield* openBrowser
      yield* curator.curatorAccess.setPassphrase({ payload: { passphrase: "correct horse battery" } })
      yield* curator.settings.saveBlueprint({ payload: { blueprint: { ...DefaultBlueprint, ps: 4 } } })
      yield* seedBook("Quant Review", numbered(10, { reserve: true, seed: 0 }))
      const asha = yield* learner("Asha")
      let view = yield* asha.sectionals.start({ payload: { section: "quant" } })
      const first = view.current!.question.id
      while (view.stage === "question") {
        yield* TestClock.adjust("60 seconds")
        view = yield* asha.sectionals.answer({
          params: { id: view.id },
          payload: { seq: view.nextSeq, questionId: view.current!.question.id, selection: [{ part: 0, choice: "A" }] }
        })
      }
      view = yield* asha.sectionals.change({
        params: { id: view.id },
        payload: { seq: view.nextSeq, questionId: first, selection: [{ part: 0, choice: "C" }] }
      })
      expect((yield* list(asha)).total).toBe(0)
      yield* asha.sectionals.finish({ params: { id: view.id } })
      const log = yield* list(asha)
      expect(log.total).toBe(3)
      expect(log.entries.map((entry) => entry.questionId)).not.toContain(first)
    })))

  test("a Mock's Section enters only once the Mock is over", () =>
    runWithWorkers(Effect.gen(function*() {
      const curator = yield* openBrowser
      yield* curator.curatorAccess.setPassphrase({ payload: { passphrase: "correct horse battery" } })
      yield* curator.settings.saveBlueprint({ payload: { blueprint: SmallBlueprint } })
      yield* seedExamBank()
      const asha = yield* learner("Asha")
      let mock = yield* asha.mocks.start({ payload: { order: ["quant", "verbal", "di"] } })
      for (let place = 1; place <= 3; place++) {
        const id = mock.sections.find((section) => section.place === mock.current)!.sessionId!
        let view = yield* asha.sectionals.get({ params: { id } })
        while (view.stage === "question") {
          yield* TestClock.adjust("60 seconds")
          const question = view.current!.question
          view = yield* asha.sectionals.answer({
            params: { id },
            payload: {
              seq: view.nextSeq,
              questionId: question.id,
              selection: question.parts.map((part) => ({ part: part.position, choice: part.options[0]!.label }))
            }
          })
        }
        yield* asha.sectionals.finish({ params: { id } })
        mock = yield* asha.mocks.get({ params: { id: mock.id } })
        if (place < 3) expect((yield* list(asha)).total).toBe(0)
        if (mock.stage === "break") mock = yield* asha.mocks.goOn({ params: { id: mock.id } })
      }
      expect(mock.stage).toBe("finished")
      const log = yield* list(asha)
      expect(log.total).toBeGreaterThan(0)
      expect(log.facets.sections.map((section) => section.id).toSorted()).toEqual(["di", "quant", "verbal"])
    })))
})

// What the Curator's merge does to the merged Question (ReviewQueue.ts).
const merge = (from: string, into: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    yield* db.update(sources).set({ questionId: into, merged: true }).where(eq(sources.questionId, from))
    yield* db.update(questions).set({ status: "withdrawn", mergedInto: into }).where(eq(questions.id, from))
  }).pipe(Effect.orDie)

const bookItem = (bookId: string, number: number): PracticeChoice => ({
  kind: "book",
  bookId: BookId.make(bookId),
  set: "Problem Solving",
  from: number,
  to: number
})

describe("Review fixes in the Error Log", () => {
  test("an untimed answer is never slow, however long the Question sat open", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(1))
      const asha = yield* learner("Asha")
      yield* answer(asha, yield* asha.practice.start({ payload: { choice: untimed(1) } }), "C", { seconds: 600 })
      expect((yield* list(asha)).total).toBe(0)
    })))

  test("a merged Question's Responses count for the one it became, judged by its key, every one in the history", () =>
    runWithWorkers(Effect.gen(function*() {
      const a = yield* seedBook("Book A", numbered(1))
      const b = yield* seedBook("Book B", numbered(1))
      const q1 = a.ids.get(1)!
      const q2 = b.ids.get(1)!
      const asha = yield* learner("Asha")
      // Right on Book B's copy, then wrong on Book A's, then wrong on B's.
      yield* answer(asha, yield* asha.practice.start({ payload: { choice: bookItem(b.bookId, 1) } }), "C")
      yield* answer(asha, yield* asha.practice.start({ payload: { choice: bookItem(a.bookId, 1) } }), "A")
      yield* answer(asha, yield* asha.practice.start({ payload: { choice: bookItem(b.bookId, 1) } }), "B")
      yield* merge(q2, q1)
      const log = yield* list(asha)
      expect(log.entries.map((entry) => [String(entry.questionId), entry.misses])).toEqual([[q1, 2]])
      const detail = yield* asha.errorLog.get({ params: { questionId: QuestionId.make(q2) } })
      expect(detail.history.map((item) => [item.correct, item.reasons])).toEqual([[true, []], [false, ["wrong"]], [false, ["wrong"]]])
      // A key change on the Question it became makes the copy's B right and
      // its C wrong: the latest miss is now A's.
      const db = yield* Db
      yield* db.update(parts).set({ key: "B" }).where(eq(parts.questionId, q1)).pipe(Effect.orDie)
      expect((yield* list(asha)).entries.map((entry) => [entry.misses, entry.parts[0]!.picked])).toEqual([[2, "A"]])
    })))

  test("option notes written for an old key give no Mistake Type or Trap Pattern until written again", () =>
    runWithWorkers(Effect.gen(function*() {
      const book = yield* seedBook("Quant Review", numbered(1))
      const questionId = book.ids.get(1)!
      const asha = yield* learner("Asha")
      yield* answer(asha, yield* asha.practice.start({ payload: { choice: bookItem(book.bookId, 1) } }), "A")
      const db = yield* Db
      yield* db.update(parts).set({ key: "B" }).where(eq(parts.questionId, questionId)).pipe(Effect.orDie)
      yield* db.update(questions).set({ enrichment: "key-content" }).where(eq(questions.id, questionId)).pipe(Effect.orDie)
      const [entry] = (yield* list(asha)).entries
      expect(entry!.parts[0]).toMatchObject({ mistakeType: null, trapPattern: null, basis: "none" })
      expect((yield* list(asha)).facets.mistakeTypes.map((each) => each.id)).toEqual(["unlabelled"])
      yield* db.update(questions).set({ enrichment: "done" }).where(eq(questions.id, questionId)).pipe(Effect.orDie)
      expect((yield* list(asha)).entries[0]!.parts[0]).toMatchObject({ mistakeType: { id: "trap" }, basis: "option" })
    })))

  test("Difficulty Bands come easy to hard, and a long list comes a page at a time", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Hard Book", numbered(1, { seed: 1 }))
      yield* seedBook("Easy Book", numbered(1, { seed: -1 }))
      yield* seedBook("Medium Book", numbered(1, { seed: 0 }))
      const asha = yield* learner("Asha")
      let view = yield* asha.practice.start({ payload: { choice: untimed(3) } })
      for (let i = 0; i < 3; i++) view = yield* answer(asha, view, "A")
      const log = yield* list(asha)
      expect(log.facets.bands.map((band) => band.id)).toEqual(["easy", "medium", "hard"])
      const page = yield* list(asha, { after: cursorOf(log.entries[0]!), limit: 1 })
      expect([page.entries.length, page.matching, page.more, page.total, String(page.entries[0]!.questionId)])
        .toEqual([1, 3, 1, 3, String(log.entries[1]!.questionId)])
      expect(yield* list(asha, { after: cursorOf(log.entries[0]!), limit: 0 })).toMatchObject({ entries: [], more: 2 })
      expect(log.timeZone).toBe("UTC")
    })))

  test("an entry waits while a running Sectional holds its Question, and opens once that ends", () =>
    runWithWorkers(Effect.gen(function*() {
      const book = yield* seedBook("Quant Review", numbered(1))
      const questionId = book.ids.get(1)!
      const asha = yield* learner("Asha")
      yield* answer(asha, yield* asha.practice.start({ payload: { choice: bookItem(book.bookId, 1) } }), "A")
      // As a Sectional that chose it from the Seen tier stands.
      const db = yield* Db
      const sectional = crypto.randomUUID()
      yield* db.insert(sessions).values({
        id: sectional,
        profileId: asha.profileId,
        kind: "sectional",
        timed: true,
        config: encodeConfig({
          section: "quant",
          blueprint: DefaultBlueprint,
          units: [{ unitId: questionId, group: "ps", questionIds: [questionId], seen: [questionId], skipped: [], tier: "seen", slot: "own" }],
          passed: {},
          stage: "question",
          unfilled: 0,
          report: null
        }),
        status: "active",
        timeLimitMs: 2_700_000,
        elapsedMs: 0,
        clockSavedAt: null,
        holder: "tab-1",
        createdAt: 0
      }).pipe(Effect.orDie)
      expect(yield* list(asha)).toMatchObject({ total: 0, held: 1, entries: [] })
      expect(yield* asha.errorLog.get({ params: { questionId: QuestionId.make(questionId) } })
        .pipe(Effect.flip, Effect.map((error) => error._tag))).toBe("ErrorLogEntryHeld")
      yield* db.update(sessions).set({ status: "finished" }).where(eq(sessions.id, sectional)).pipe(Effect.orDie)
      expect(yield* list(asha)).toMatchObject({ total: 1, held: 0 })
      expect(String((yield* asha.errorLog.get({ params: { questionId: QuestionId.make(questionId) } })).entry.questionId)).toBe(questionId)
    })))

  test("a wrong answer given in under a quarter of the Target Time says the timing chose Time pressure", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(1))
      const asha = yield* learner("Asha")
      yield* answer(asha, yield* asha.practice.start({ payload: { choice: untimed(1) } }), "A", { seconds: 20 })
      expect((yield* list(asha)).entries[0]!.parts[0]).toMatchObject({ mistakeType: { id: "time-pressure" }, basis: "timing" })
    })))
})

describe("Re-review fixes in the Error Log", () => {
  test("a page follows the entry the last one ended on, so labelling under a Mistake Type filter skips none", () =>
    runWithWorkers(Effect.gen(function*() {
      const book = yield* seedBook("Quant Review", numbered(4))
      const asha = yield* learner("Asha")
      let view = yield* asha.practice.start({ payload: { choice: untimed(4) } })
      for (let i = 0; i < 4; i++) view = yield* answer(asha, view, "A")
      // Notes waiting to be written again: every wrong Part is unlabelled.
      const db = yield* Db
      yield* db.update(questions).set({ enrichment: "key-content" }).pipe(Effect.orDie)
      const filters = { mistakeType: "unlabelled" }
      const wanted = (yield* list(asha, filters)).entries.map((entry) => entry.questionId)
      const first = yield* list(asha, { ...filters, limit: 2 })
      expect([first.matching, first.more]).toEqual([4, 2])
      const labelled = first.entries[0]!
      yield* asha.errorLog.setMistakeType({
        params: { questionId: labelled.questionId },
        payload: { responseId: labelled.responseId, part: 0, mistakeType: "misread" }
      })
      // The counts after the label: three match, two still to show.
      const counts = yield* list(asha, { ...filters, after: cursorOf(first.entries.at(-1)!), limit: 0 })
      expect([counts.matching, counts.more]).toEqual([3, 2])
      const more = yield* list(asha, { ...filters, after: cursorOf(first.entries.at(-1)!), limit: 2 })
      expect([...first.entries, ...more.entries].map((entry) => entry.questionId)).toEqual(wanted)
      expect(more.more).toBe(0)
      expect(book.ids.size).toBe(4)
    })))

  test("a Book keeps one name everywhere, and copies added the same day are told apart in the Profile's time zone", () =>
    runWithWorkers(Effect.gen(function*() {
      // 23:30 UTC on 1 January is 18:30 in New York; the next copy, an hour
      // later, is still that day in New York but the next in UTC.
      yield* TestClock.adjust("23.5 hours")
      const one = yield* seedBook("Quant Review", numbered(1))
      yield* TestClock.adjust("1 hour")
      const two = yield* seedBook("Quant Review", numbered(1))
      yield* TestClock.adjust("1 day")
      yield* seedBook("Quant Review", numbered(1))
      const jar = yield* Ref.make(Cookies.empty)
      const tab = yield* HttpApiClient.make(Api, {
        transformClient: (client) =>
          client.pipe(HttpClient.withCookiesRef(jar), HttpClient.mapRequest(HttpClientRequest.setHeader("x-gp-device", "tab-1")))
      })
      yield* tab.profiles.create({ payload: { name: "Asha", timeZone: "America/New_York" } })
      const asha = tab as unknown as Tab
      for (const bookId of [one.bookId, two.bookId]) {
        yield* answer(asha, yield* asha.practice.start({ payload: { choice: bookItem(bookId, 1) } }), "A")
      }
      const log = yield* list(asha)
      expect(log.facets.books.map((book) => book.name)).toEqual([
        "Quant Review, added 1970-01-01 18:30",
        "Quant Review, added 1970-01-01 19:30"
      ])
      const entry = log.entries[0]!
      const changed = yield* asha.errorLog.setMistakeType({
        params: { questionId: entry.questionId },
        payload: { responseId: entry.responseId, part: 0, mistakeType: "misread" }
      })
      const opened = yield* asha.errorLog.get({ params: { questionId: entry.questionId } })
      expect([changed.books[0]!.name, opened.entry.books[0]!.name]).toEqual([entry.books[0]!.name, entry.books[0]!.name])
    })))

  test("a Response deleted and replaced in its row is read afresh", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(1))
      const asha = yield* learner("Asha")
      const view = yield* asha.practice.start({ payload: { choice: untimed(1) } })
      yield* answer(asha, view, "A")
      expect((yield* list(asha)).total).toBe(1)
      const db = yield* Db
      const [wrong] = yield* db.select().from(responses).pipe(Effect.orDie)
      yield* db.delete(responses).where(eq(responses.id, wrong!.id)).pipe(Effect.orDie)
      // The new row takes the deleted one's rowid.
      yield* db.insert(responses).values({ ...wrong!, id: crypto.randomUUID(), selection: JSON.stringify([{ part: 0, choice: "C" }]) })
        .pipe(Effect.orDie)
      const [row] = yield* db.select({ rowid: sql<number>`${responses}.rowid` }).from(responses).pipe(Effect.orDie)
      expect(row!.rowid).toBe(1)
      expect((yield* list(asha)).total).toBe(0)
    })))

  test("Responses written between reads join those kept, with their Sessions' served rows", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(4))
      const asha = yield* learner("Asha")
      let view = yield* asha.practice.start({ payload: { choice: timed(2) } })
      view = yield* answer(asha, view, "A")
      // Kept: the first Response, and the one served row so far.
      expect((yield* list(asha)).total).toBe(0)
      view = yield* asha.practice.next({ params: { id: view.id }, payload: { position: 1 } })
      // The second answer comes in the set's last tenth of 258 seconds:
      // served at 60, answered at 240, so Time pressure.
      yield* TestClock.adjust("3 minutes")
      yield* asha.practice.answer({
        params: { id: view.id },
        payload: { seq: view.nextSeq, questionId: view.current!.question.id, selection: [{ part: 0, choice: "B" }], guessed: false }
      })
      yield* asha.practice.finish({ params: { id: view.id } })
      const log = yield* list(asha)
      expect(log.entries.map((entry) => entry.parts[0]!.mistakeType?.id)).toEqual(["time-pressure", "trap"])
    })))

  test("a merged copy's own set judges it by the Question it became, as its entry does", () =>
    runWithWorkers(Effect.gen(function*() {
      const a = yield* seedBook("Book A", numbered(1))
      const b = yield* seedBook("Book B", numbered(1))
      const asha = yield* learner("Asha")
      const view = yield* asha.practice.start({ payload: { choice: bookItem(b.bookId, 1) } })
      yield* answer(asha, view, "C")
      // Book B's copy merged into Book A's, whose key is then B.
      yield* merge(b.ids.get(1)!, a.ids.get(1)!)
      const db = yield* Db
      yield* db.update(parts).set({ key: "B" }).where(eq(parts.questionId, a.ids.get(1)!)).pipe(Effect.orDie)
      expect((yield* list(asha)).total).toBe(1)
      const served = (yield* asha.practice.get({ params: { id: view.id } })).current!
      expect([served.debrief?.correct, served.response?.correct, served.mistakes !== null]).toEqual([false, false, true])
      const summary = (yield* asha.practice.list()).find((each) => each.id === view.id)!
      expect(summary.correct).toBe(0)
    })))
})
