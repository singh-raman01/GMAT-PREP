import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { Api } from "../src/api/Api.ts"
import { DefaultBlueprint } from "../src/api/blueprint.ts"
import type { ErrorLogFilters } from "../src/api/ErrorLog.ts"
import type { PracticeChoice, PracticeView } from "../src/api/Practice.ts"
import { QuestionId } from "../src/api/Review.ts"
import { Db } from "../src/server/db/Database.ts"
import { parts, questions } from "../src/server/db/schema.ts"
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
      expect(changed.parts[0]).toMatchObject({ mistakeType: { id: "misread", name: "Misread" }, byLearner: true })
      // The Curator changes the key to B: A is still wrong, and the label stays.
      const db = yield* Db
      yield* db.update(parts).set({ key: "B" }).where(eq(parts.questionId, questionId)).pipe(Effect.orDie)
      expect((yield* list(asha, { mistakeType: "misread" })).entries.map((each) => each.parts[0]!.byLearner)).toEqual([true])
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
      expect(detail.debrief.trapNotes.map((note) => note.label)).toEqual(["E"])
      expect(detail.question.id).toBe(questionId)
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
