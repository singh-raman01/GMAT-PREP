import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { Api } from "../src/api/Api.ts"
import { BookId } from "../src/api/Books.ts"
import { type Blueprint, DefaultBlueprint } from "../src/api/blueprint.ts"
import { QuestionId } from "../src/api/Review.ts"
import type { SectionalView } from "../src/api/Sectionals.ts"
import { Db } from "../src/server/db/Database.ts"
import { difficulty, parts, questions, responses, scoreEstimates, servedQuestions } from "../src/server/db/schema.ts"
import { numbered, seedBook, type SeedQuestion } from "./fixtures/bank.ts"
import { openBrowser, runWithWorkers } from "./harness.ts"

// Two tabs of one browser: they share the unlock cookie, and each names
// itself as a device.
const learner = (name: string) =>
  Effect.gen(function*() {
    const jar = yield* Ref.make(Cookies.empty)
    const tab = (device: string) =>
      HttpApiClient.make(Api, {
        transformClient: (client) =>
          client.pipe(
            HttpClient.withCookiesRef(jar),
            HttpClient.mapRequest(HttpClientRequest.setHeader("x-gp-device", device))
          )
      })
    const first = yield* tab("tab-1")
    const second = yield* tab("tab-2")
    const profile = yield* first.profiles.create({ payload: { name } })
    return { first, second, profileId: profile.id }
  })
type Tab = Effect.Success<ReturnType<typeof learner>>["first"]

// The Curator sets a small Blueprint, so a test needs few Questions.
const blueprint = (changes: Partial<Blueprint>) =>
  Effect.gen(function*() {
    const curator = yield* openBrowser
    yield* curator.curatorAccess.setPassphrase({ payload: { passphrase: "correct horse battery" } })
    yield* curator.settings.saveBlueprint({ payload: { blueprint: { ...DefaultBlueprint, ...changes } } })
  })

const answer = (tab: Tab, view: SectionalView, choice: string) =>
  tab.sectionals.answer({
    params: { id: view.id },
    payload: { seq: view.nextSeq, questionId: view.current!.question.id, selection: [{ part: 0, choice }] }
  })

const change = (tab: Tab, view: SectionalView, position: number, choice: string) =>
  tab.sectionals.change({
    params: { id: view.id },
    payload: {
      seq: view.nextSeq,
      questionId: view.review!.entries.find((entry) => entry.position === position)!.questionId,
      selection: [{ part: 0, choice }]
    }
  })

const reserved = (n: number, settings: Omit<SeedQuestion, "number"> = {}, from = 1) =>
  numbered(n, { reserve: true, ...settings }, from)

describe("Starting a Sectional", () => {
  test("needs twice the Blueprint count unseen in the Reserve, and the screen says what is missing", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* blueprint({ ps: 4 })
      yield* seedBook("Quant Review", [...reserved(5), ...numbered(6, { reserve: false }, 6)])
      const asha = yield* learner("Asha")
      const options = yield* asha.first.sectionals.options()
      const quant = options.sections.find((section) => section.section.id === "quant")!
      expect(quant).toMatchObject({ questions: 4, minutes: 45, ready: false })
      expect(quant.groups.map((group) => [group.group.name, group.needed, group.unseen])).toEqual([["Problem Solving", 8, 5]])
      expect(quant.groups[0]!.byBand).toEqual({ easy: 0, medium: 5, hard: 0 })
      const refused = yield* asha.first.sectionals.start({ payload: { section: "quant" } }).pipe(Effect.flip)
      expect(refused).toMatchObject({ _tag: "ReserveTooSmall", readiness: { ready: false } })
      yield* seedBook("More Quant", reserved(3, { seed: 1 }))
      const ready = yield* asha.first.sectionals.options()
      expect(ready.sections.find((section) => section.section.id === "quant")!.ready).toBe(true)
      const started = yield* asha.first.sectionals.start({ payload: { section: "quant" } })
      expect(started).toMatchObject({ stage: "question", total: 4, answered: 0, heldHere: true, report: null })
      expect(started.clock).toEqual({ limitMs: 2_700_000, elapsedMs: 0, remainingMs: 2_700_000, interrupted: false })
      // One Sectional at a time.
      const again = yield* asha.first.sectionals.start({ payload: { section: "quant" } }).pipe(Effect.flip)
      expect(again).toMatchObject({ _tag: "SectionalRunning", id: started.id })
      expect((yield* asha.first.sectionals.options()).running).toBe(started.id)
      expect(yield* asha.first.sectionals.start({ payload: { section: "geometry" } }).pipe(Effect.flip))
        .toMatchObject({ _tag: "UnknownSection" })
    })))
})

describe("Taking a Sectional", () => {
  test("serves one Question at a time from the Reserve near the estimate, with no going back", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* blueprint({ ps: 4 })
      const seeded = yield* seedBook("Quant Review", [
        ...reserved(6, { seed: 0 }),
        ...reserved(4, { seed: 2 }, 7),
        ...numbered(4, { seed: 0, reserve: false }, 11)
      ])
      const asha = yield* learner("Asha")
      const started = yield* asha.first.sectionals.start({ payload: { section: "quant" } })
      const near = new Set([1, 2, 3, 4, 5, 6].map((n) => seeded.ids.get(n)!))
      expect(near.has(started.current!.question.id)).toBe(true)
      // A running Section does not say where a Question comes from, or how
      // an answer went.
      expect(started.current).toMatchObject({ position: 0, response: null, debrief: null, question: { source: null } })
      // No looking back while Questions are coming.
      expect(yield* asha.first.sectionals.question({ params: { id: started.id, position: 0 } }).pipe(Effect.flip))
        .toMatchObject({ _tag: "SectionalOutOfStep", reason: "not-in-review" })
      // An answer is only for the Question on screen.
      const wrongOne = yield* asha.first.sectionals.answer({
        params: { id: started.id },
        payload: { seq: started.nextSeq, questionId: QuestionId.make(seeded.ids.get(7)!), selection: [{ part: 0, choice: "C" }] }
      }).pipe(Effect.flip)
      expect(wrongOne).toMatchObject({ _tag: "SectionalOutOfStep", reason: "not-current" })
      yield* TestClock.adjust("40 seconds")
      const second = yield* answer(asha.first, started, "C")
      expect(second).toMatchObject({ stage: "question", answered: 1, current: { position: 1 } })
      expect(second.current!.question.id).not.toBe(started.current!.question.id)
      // The same submit sent again is recorded once; the first Question
      // cannot be answered again.
      const resent = yield* answer(asha.first, started, "C")
      expect(resent.answered).toBe(1)
      const late = yield* asha.first.sectionals.answer({
        params: { id: started.id },
        payload: { seq: second.nextSeq, questionId: started.current!.question.id, selection: [{ part: 0, choice: "A" }] }
      }).pipe(Effect.flip)
      expect(late).toMatchObject({ _tag: "SectionalOutOfStep", reason: "not-current" })
      const db = yield* Db
      const [first] = yield* db.select().from(responses).where(eq(responses.sessionId, started.id)).pipe(Effect.orDie)
      expect(first).toMatchObject({ kind: "first", timeSpentMs: 40_000, guessed: false })
    })))

  test("Review & Edit allows three changes, each a new Response, and the report says what they did", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* blueprint({ ps: 4 })
      yield* seedBook("Quant Review", reserved(10, { seed: 0 }))
      const asha = yield* learner("Asha")
      let view = yield* asha.first.sectionals.start({ payload: { section: "quant" } })
      while (view.stage === "question") {
        yield* TestClock.adjust("30 seconds")
        view = yield* answer(asha.first, view, "C")
      }
      expect(view).toMatchObject({ stage: "review", answered: 4, current: null })
      expect(view.review!.changesLeft).toBe(3)
      expect(view.review!.entries.map((entry) => [entry.position, entry.changed])).toEqual([[0, false], [1, false], [2, false], [3, false]])
      const db = yield* Db
      // Nothing moves before the Section closes.
      expect(yield* db.select().from(difficulty).pipe(Effect.orDie)).toEqual([])
      const shown = yield* asha.first.sectionals.question({ params: { id: view.id, position: 0 } })
      expect(shown.selection).toEqual([{ part: 0, choice: "C" }])
      expect(shown.served.debrief).toBeNull()
      // Bookmark one for the list.
      view = yield* asha.first.sectionals.bookmark({
        params: { id: view.id },
        payload: { questionId: view.review!.entries[3]!.questionId, bookmarked: true }
      })
      expect(view.review!.entries.map((entry) => entry.bookmarked)).toEqual([false, false, false, true])
      view = yield* change(asha.first, view, 0, "A")
      expect(view.review!.changesLeft).toBe(2)
      expect(view.review!.entries[0]!.changed).toBe(true)
      // Giving the answer that stands is no change.
      expect(yield* change(asha.first, view, 0, "A").pipe(Effect.flip)).toMatchObject({ reason: "same-answer" })
      view = yield* change(asha.first, view, 0, "C")
      view = yield* change(asha.first, view, 1, "B")
      expect(view.review!.changesLeft).toBe(0)
      expect(yield* change(asha.first, view, 2, "B").pipe(Effect.flip)).toMatchObject({ reason: "no-changes-left" })
      const finished = yield* asha.first.sectionals.finish({ params: { id: view.id } })
      expect(finished).toMatchObject({ stage: "finished", endedBy: "finished" })
      const report = finished.report!
      expect(report.results.map((result) => [result.correct, result.change])).toEqual([
        [true, { wasCorrect: true, isCorrect: true }],
        [false, { wasCorrect: true, isCorrect: false }],
        [true, null],
        [true, null]
      ])
      expect(report).toMatchObject({ changes: 3, unreached: 0, unfilled: 0, repeats: 0 })
      expect(report.editPoints).toBeLessThan(0)
      expect(report.results.map((result) => [result.timeSpentMs, result.bookmarked])).toEqual([
        [30_000, false],
        [30_000, false],
        [30_000, false],
        [30_000, true]
      ])
      expect(report.score).toBeGreaterThan(75)
      expect(report.low).toBeLessThanOrEqual(report.score)
      expect(report.high).toBeGreaterThanOrEqual(report.score)
      const kinds = yield* db.select({ kind: responses.kind, supersedes: responses.supersedes }).from(responses)
        .where(eq(responses.sessionId, view.id)).pipe(Effect.orDie)
      expect(kinds.filter((row) => row.kind === "edit")).toHaveLength(3)
      expect(kinds.filter((row) => row.kind === "edit").every((row) => row.supersedes !== null)).toBe(true)
      // Once over, each Question opens with its Debrief, and Difficulty and
      // Ability have moved.
      const after = yield* asha.first.sectionals.question({ params: { id: view.id, position: 1 } })
      expect(after.served.debrief).toMatchObject({ correct: false })
      expect(after.served.response).toMatchObject({ selection: [{ part: 0, choice: "B" }], correct: false, rated: true })
      expect(after.served.question.source).not.toBeNull()
      expect(yield* db.select().from(difficulty).pipe(Effect.orDie)).toHaveLength(4)
      expect((yield* db.select().from(scoreEstimates).pipe(Effect.orDie)).length).toBeGreaterThan(0)
      // The report stands as kept.
      expect((yield* asha.first.sectionals.get({ params: { id: view.id } })).report).toEqual(report)
      const listed = yield* asha.first.sectionals.list()
      expect(listed.map((each) => [each.section.id, each.finished, each.score])).toEqual([["quant", true, report.score]])
    })))

  test("time running out gives the Question on screen a time-out Response, counts unreached slots as wrong, and allows no review", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* blueprint({ ps: 4 })
      yield* seedBook("Quant Review", reserved(10, { seed: 0 }))
      const asha = yield* learner("Asha")
      const started = yield* asha.first.sectionals.start({ payload: { section: "quant" } })
      yield* TestClock.adjust("1 minute")
      yield* answer(asha.first, started, "C")
      // The tab is closed; the server's clock goes on.
      yield* TestClock.adjust("45 minutes")
      const ended = yield* asha.first.sectionals.get({ params: { id: started.id } })
      expect(ended).toMatchObject({ stage: "finished", endedBy: "time", review: null })
      expect(ended.clock).toMatchObject({ elapsedMs: 2_700_000, remainingMs: 0 })
      const report = ended.report!
      expect(report.results.map((result) => [result.correct, result.timedOut])).toEqual([[true, false], [false, true]])
      expect(report.results[1]!.timeSpentMs).toBe(2_640_000)
      expect(report.unreached).toBe(2)
      const db = yield* Db
      const kinds = yield* db.select({ kind: responses.kind }).from(responses).pipe(Effect.orDie)
      expect(kinds.map((row) => row.kind).toSorted()).toEqual(["first", "time-out"])
      // Only the answered Question is Rated.
      expect(yield* db.select().from(difficulty).pipe(Effect.orDie)).toHaveLength(1)
    })))

  test("ending early counts the Question on screen and the slots not reached as wrong", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* blueprint({ ps: 4 })
      yield* seedBook("Quant Review", reserved(10, { seed: 0 }))
      const asha = yield* learner("Asha")
      const started = yield* asha.first.sectionals.start({ payload: { section: "quant" } })
      const second = yield* answer(asha.first, started, "C")
      const ended = yield* asha.first.sectionals.finish({ params: { id: second.id } })
      expect(ended.report!.results.map((result) => [result.correct, result.unanswered])).toEqual([[true, false], [false, true]])
      expect(ended.report!.unreached).toBe(2)
      // Everything right but cut short scores below everything right.
      expect(ended.report!.score).toBeLessThan(80)
    })))

  test("an RC passage's Questions come one after another, and a passage no slot fits is never served", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* blueprint({ rc: [3], cr: 2 })
      const rc = { questionType: "verbal.rc-detail", primarySkill: "verbal.reading.detail", reserve: true }
      const cr = { questionType: "verbal.cr-weaken", primarySkill: "verbal.arguments.causal", reserve: true }
      const seeded = yield* seedBook("Verbal Review", [
        ...numbered(3, { ...rc, passage: "The first passage." }),
        ...numbered(3, { ...rc, passage: "The second passage." }, 4),
        ...numbered(4, { ...rc, passage: "A passage of four." }, 7),
        ...numbered(4, cr, 11)
      ])
      const asha = yield* learner("Asha")
      let view = yield* asha.first.sectionals.start({ payload: { section: "verbal" } })
      expect(view.total).toBe(5)
      while (view.stage === "question") view = yield* answer(asha.first, view, "C")
      const db = yield* Db
      const served = yield* db.select({ questionId: servedQuestions.questionId, position: servedQuestions.position })
        .from(servedQuestions).where(eq(servedQuestions.sessionId, view.id)).orderBy(servedQuestions.position)
        .pipe(Effect.orDie)
      const number = new Map([...seeded.ids].map(([n, id]) => [id, n] as const))
      const numbers = served.map((row) => number.get(row.questionId)!)
      expect(numbers).toHaveLength(5)
      const passage = numbers.filter((n) => n <= 10)
      expect(passage).toHaveLength(3)
      expect(passage.every((n) => n <= 6)).toBe(true)
      // The passage's three are served together and in order.
      const start = numbers.indexOf(passage[0]!)
      expect(numbers.slice(start, start + 3)).toEqual(passage)
      expect(passage).toEqual(passage.toSorted((a, b) => a - b))
    })))

  test("another tab sees the Sectional read-only until it takes it over", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* blueprint({ ps: 4 })
      yield* seedBook("Quant Review", reserved(10, { seed: 0 }))
      const asha = yield* learner("Asha")
      const started = yield* asha.first.sectionals.start({ payload: { section: "quant" } })
      const elsewhere = yield* asha.second.sectionals.get({ params: { id: started.id } })
      expect(elsewhere.heldHere).toBe(false)
      expect(yield* answer(asha.second, elsewhere, "C").pipe(Effect.flip)).toMatchObject({ _tag: "SectionalHeldElsewhere" })
      const taken = yield* asha.second.sectionals.claim({ params: { id: started.id } })
      expect(taken.heldHere).toBe(true)
      expect((yield* answer(asha.second, taken, "C")).answered).toBe(1)
    })))
})

describe("While a Sectional runs", () => {
  test("Practice leaves out every Question it chose, so nothing says how an answer went until it closes", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* blueprint({ ps: 4 })
      const seeded = yield* seedBook("Quant Review", reserved(10, { seed: 0, key: "C" }))
      const asha = yield* learner("Asha")
      const tab = asha.first
      const missed = { kind: "filters" as const, section: "quant", status: "missed" as const, size: 10, timed: false }
      const bookOrder = { kind: "book" as const, bookId: BookId.make(seeded.bookId) }
      expect((yield* tab.practice.preview({ payload: { choice: missed } })).questions).toBe(0)

      const started = yield* tab.sectionals.start({ payload: { section: "quant" } })
      const firstId = started.current!.question.id
      yield* tab.sectionals.bookmark({ params: { id: started.id }, payload: { questionId: firstId, bookmarked: true } })
      const second = yield* answer(tab, started, "A")

      // The wrong answer, the Bookmark and the Question on screen stay out,
      // counted whatever their status.
      expect(yield* tab.practice.preview({ payload: { choice: missed } })).toMatchObject({ questions: 0, inSection: 2 })
      const bookmarked = yield* tab.practice.start({ payload: { choice: { ...missed, status: "bookmarked" } } }).pipe(Effect.flip)
      expect(bookmarked).toMatchObject({ _tag: "NoQuestionsMatch", inSection: 2 })
      expect(yield* tab.practice.preview({ payload: { choice: bookOrder } })).toMatchObject({
        questions: 0,
        inSection: 2,
        heldForMocks: 8
      })
      const similar = yield* tab.practice.similar({ payload: { questionId: firstId } }).pipe(Effect.flip)
      expect(similar._tag).toBe("QuestionNotFound")

      // Once it closes, Practice has them.
      let view = second
      while (view.stage === "question") view = yield* answer(tab, view, "C")
      yield* tab.sectionals.finish({ params: { id: view.id } })
      expect(yield* tab.practice.preview({ payload: { choice: missed } })).toMatchObject({ questions: 1, inSection: 0 })
      expect(yield* tab.practice.preview({ payload: { choice: bookOrder } })).toMatchObject({ questions: 4, inSection: 0 })
    })))

  test("a Practice Set's planned Question that the Sectional chose leaves the set", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* blueprint({ ps: 4 })
      // Held for Mocks but far from Medium; and three near it, not held.
      yield* seedBook("Quant Review", [...reserved(8, { seed: 2 }), ...numbered(3, { reserve: false, seed: 0 }, 9)])
      const asha = yield* learner("Asha")
      const tab = asha.first
      const set = yield* tab.practice.start({
        payload: { choice: { kind: "filters", section: "quant", status: "any", size: 3, timed: false } }
      })
      const planned = (yield* tab.practice.get({ params: { id: set.id } })).total
      expect(planned).toBe(3)
      const served = [set.current!.question.id]
      let view = yield* tab.practice.answer({
        params: { id: set.id },
        payload: { seq: set.nextSeq, questionId: served[0]!, selection: [{ part: 0, choice: "C" }], guessed: false }
      })
      // The Sectional takes one of the two the set has not served yet.
      const sectional = yield* tab.sectionals.start({ payload: { section: "quant" } })
      const chosen = sectional.current!.question.id
      expect(served).not.toContain(chosen)
      // When its turn comes in the set, it is passed over.
      while (view.status === "active" && served.length < view.total) {
        view = yield* tab.practice.next({ params: { id: set.id }, payload: { position: served.length } })
        if (view.status !== "active" || view.current === null || view.current.position < served.length) break
        served.push(view.current.question.id)
        view = yield* tab.practice.answer({
          params: { id: set.id },
          payload: { seq: view.nextSeq, questionId: view.current.question.id, selection: [{ part: 0, choice: "C" }], guessed: false }
        })
      }
      expect(served).toHaveLength(2)
      expect(served).not.toContain(chosen)
      expect(view.total).toBe(2)
    })))
})

describe("A Sectional's report", () => {
  test("follows a key changed after it closed, and says it was rescored", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* blueprint({ ps: 4 })
      yield* seedBook("Quant Review", reserved(10, { seed: 0, key: "C" }))
      const asha = yield* learner("Asha")
      let view = yield* asha.first.sectionals.start({ payload: { section: "quant" } })
      const firstId = view.current!.question.id
      while (view.stage === "question") view = yield* answer(asha.first, view, "B")
      const done = yield* asha.first.sectionals.finish({ params: { id: view.id } })
      expect(done.report).toMatchObject({ rescored: false })
      expect(done.report!.results[0]!.correct).toBe(false)
      // The Book's key was wrong: it is B.
      const db = yield* Db
      yield* db.update(parts).set({ key: "B" }).where(eq(parts.questionId, firstId)).pipe(Effect.orDie)
      const again = yield* asha.first.sectionals.get({ params: { id: view.id } })
      expect(again.report!.results[0]!.correct).toBe(true)
      expect(again.report!.rescored).toBe(true)
      expect(again.report!.score).toBeGreaterThan(done.report!.score)
      // At the Difficulty kept when it closed.
      expect(again.report!.results[0]!.difficulty).toBe(done.report!.results[0]!.difficulty)
      const [summary] = yield* asha.first.sectionals.list()
      expect(summary!.score).toBe(again.report!.score)
    })))

  test("marks as seen before only the Questions of a passage the Profile had Seen", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* blueprint({ rc: [3, 4], cr: 1 })
      const rc = { questionType: "verbal.rc-detail", primarySkill: "verbal.reading.detail" }
      const cr = { questionType: "verbal.cr-weaken", primarySkill: "verbal.arguments.causal" }
      const seeded = yield* seedBook("Verbal Review", [
        ...[1, 2, 3, 4, 5].flatMap((p) => numbered(3, { ...rc, reserve: true, passage: `Passage ${p}.` }, p * 10)),
        ...numbered(2, { ...cr, reserve: true }, 100),
        // The one passage of four, not held for Mocks.
        ...numbered(4, { ...rc, reserve: false, passage: "A passage of four." }, 200)
      ])
      const four = [200, 201, 202, 203].map((n) => seeded.ids.get(n)!)
      const asha = yield* learner("Asha")
      const set = yield* asha.first.practice.start({
        payload: { choice: { kind: "filters", section: "verbal", questionType: "verbal.rc-detail", status: "any", size: 1, timed: false } }
      })
      const seenOne = set.current!.question.id
      expect(four).toContain(seenOne)
      yield* asha.first.practice.finish({ params: { id: set.id } })
      yield* TestClock.adjust("1 minute")
      let view = yield* asha.first.sectionals.start({ payload: { section: "verbal" } })
      while (view.stage === "question") view = yield* answer(asha.first, view, "C")
      const report = (yield* asha.first.sectionals.finish({ params: { id: view.id } })).report!
      const fromFour = report.results.filter((result) => four.includes(result.questionId))
      expect(fromFour).toHaveLength(4)
      expect(fromFour.filter((result) => result.repeat).map((result) => result.questionId)).toEqual([seenOne])
      expect(report.repeats).toBe(1)
    })))

  const withdrawnMidPassage = (finish: "answer" | "time") =>
    runWithWorkers(Effect.gen(function*() {
      yield* blueprint({ rc: [4], cr: 1 })
      const rc = { questionType: "verbal.rc-detail", primarySkill: "verbal.reading.detail", reserve: true }
      const cr = { questionType: "verbal.cr-weaken", primarySkill: "verbal.arguments.causal", reserve: true }
      yield* seedBook("Verbal Review", [
        ...numbered(4, { ...rc, passage: "First passage of four." }, 10),
        ...numbered(4, { ...rc, passage: "Second passage of four." }, 20),
        ...numbered(2, cr, 100)
      ])
      const asha = yield* learner("Asha")
      let view = yield* asha.first.sectionals.start({ payload: { section: "verbal" } })
      expect(view).toMatchObject({ total: 5, remaining: 4 })
      while (view.current!.question.questionType.id !== "verbal.rc-detail") view = yield* answer(asha.first, view, "C")
      const db = yield* Db
      const members = yield* db.select({ id: questions.id }).from(questions)
        .where(eq(questions.stimulusId, view.current!.question.stimulus!.id)).pipe(Effect.orDie)
      const other = members.map((row) => row.id).find((id) => id !== view.current!.question.id)!
      // The Curator withdraws another Question of the passage on screen.
      yield* db.update(questions).set({ status: "withdrawn" }).where(eq(questions.id, other)).pipe(Effect.orDie)
      const answeredBefore = view.answered
      if (finish === "time") {
        yield* TestClock.adjust("46 minutes")
        return { view: yield* asha.first.sectionals.get({ params: { id: view.id } }), answeredBefore }
      }
      view = yield* asha.first.sectionals.get({ params: { id: view.id } })
      expect(view.total).toBe(4)
      while (view.stage === "question") {
        if (view.remaining === 0) expect(view.answered).toBe(3)
        view = yield* answer(asha.first, view, "C")
      }
      return { view: yield* asha.first.sectionals.finish({ params: { id: view.id } }), answeredBefore }
    }))

  test("leaves a slot unfilled when a Question of the passage on screen is withdrawn", async () => {
    const { view } = await withdrawnMidPassage("answer")
    expect(view.report!.results).toHaveLength(4)
    expect(view.report).toMatchObject({ unreached: 0, unfilled: 1 })
    expect(view.total).toBe(4)
  })

  test("counts that slot unfilled, not wrong, when time runs out before the passage ends", async () => {
    const { view, answeredBefore } = await withdrawnMidPassage("time")
    expect(view.stage).toBe("finished")
    expect(view.report!.results).toHaveLength(answeredBefore + 1)
    // The CR slot if not reached yet, and the passage's two left in the Question Bank.
    expect(view.report).toMatchObject({ unreached: (1 - answeredBefore) + 2, unfilled: 1 })
  })
})

describe("Responses in a Sectional", () => {
  test("must come in order: a number before the last Response's is out of step", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* blueprint({ ps: 4 })
      yield* seedBook("Quant Review", reserved(10, { seed: 0 }))
      const asha = yield* learner("Asha")
      let view = yield* asha.first.sectionals.start({ payload: { section: "quant" } })
      const firstSeq = view.nextSeq
      while (view.stage === "question") {
        view = yield* asha.first.sectionals.answer({
          params: { id: view.id },
          payload: { seq: view.nextSeq + 10, questionId: view.current!.question.id, selection: [{ part: 0, choice: "C" }] }
        })
      }
      const early = yield* asha.first.sectionals.change({
        params: { id: view.id },
        payload: { seq: firstSeq, questionId: view.review!.entries[0]!.questionId, selection: [{ part: 0, choice: "B" }] }
      }).pipe(Effect.flip)
      expect(early).toMatchObject({ _tag: "SectionalOutOfStep", reason: "not-current" })
      expect(early._tag === "SectionalOutOfStep" && early.view.review!.changesLeft).toBe(3)
    })))
})
