import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { Api } from "../src/api/Api.ts"
import { type Blueprint, DefaultBlueprint } from "../src/api/blueprint.ts"
import { QuestionId } from "../src/api/Review.ts"
import type { SectionalView } from "../src/api/Sectionals.ts"
import { Db } from "../src/server/db/Database.ts"
import { difficulty, responses, scoreEstimates, servedQuestions } from "../src/server/db/schema.ts"
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
