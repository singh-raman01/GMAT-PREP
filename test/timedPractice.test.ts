import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Option, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { Api } from "../src/api/Api.ts"
import type { PracticeChoice, PracticeView } from "../src/api/Practice.ts"
import { Db } from "../src/server/db/Database.ts"
import { difficulty, questions, responses, scoreEstimates, sessions } from "../src/server/db/schema.ts"
import { fitAbility, nextDifficulty, scoreEstimate, type WeightedAnswer } from "../src/server/ratings/model.ts"
import { numbered, seedBook } from "./fixtures/bank.ts"
import { openInspectableBrowser, runWithWorkers, tempDataDir } from "./harness.ts"

// Two tabs of one browser: they share the unlock cookie, and each names
// itself as a device.
const browserWithTabs = Effect.gen(function*() {
  const jar = yield* Ref.make(Cookies.empty)
  const tab = (device: string) =>
    HttpApiClient.make(Api, {
      transformClient: (client) =>
        client.pipe(
          HttpClient.withCookiesRef(jar),
          HttpClient.mapRequest(HttpClientRequest.setHeader("x-gp-device", device))
        )
    })
  return { first: yield* tab("tab-1"), second: yield* tab("tab-2") }
})
type Tab = Effect.Success<typeof browserWithTabs>["first"]

const learner = (name: string) =>
  Effect.gen(function*() {
    const tabs = yield* browserWithTabs
    const profile = yield* tabs.first.profiles.create({ payload: { name } })
    return { ...tabs, profileId: profile.id }
  })

const timed = (size = 10): PracticeChoice => ({ kind: "filters", status: "any", size, timed: true })
const untimed = (size = 10): PracticeChoice => ({ kind: "filters", status: "any", size })

const answer = (tab: Tab, view: PracticeView, choice: string, guessed = false) =>
  tab.practice.answer({
    params: { id: view.id },
    payload: { seq: view.nextSeq, questionId: view.current!.question.id, selection: [{ part: 0, choice }], guessed }
  })

const get = (tab: Tab, view: PracticeView) => tab.practice.get({ params: { id: view.id } })

describe("A timed Practice Set", () => {
  test("runs for its Target Times, moves on with each answer, and keeps results for the end", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(3))
      const asha = yield* learner("Asha")
      const started = yield* asha.first.practice.start({ payload: { choice: timed(3) } })
      // Three Problem Solving Questions at 2:09 each.
      expect(started).toMatchObject({ timed: true, title: "Every Section, timed", total: 3, heldHere: true })
      expect(started.clock).toEqual({ limitMs: 387_000, elapsedMs: 0, remainingMs: 387_000, interrupted: false })

      yield* TestClock.adjust("10 seconds")
      expect((yield* get(asha.first, started)).clock).toMatchObject({ elapsedMs: 10_000, remainingMs: 377_000 })
      // A wrong answer, marked as a guess: the next Question comes at once,
      // with no word on the last one.
      const second = yield* answer(asha.first, started, "A", true)
      expect(second.current).toMatchObject({ position: 1, response: null, debrief: null })
      expect(second.results[0]).toMatchObject({ correct: null, guessed: true, timeSpentMs: 10_000 })
      expect((yield* asha.first.practice.review({ params: { id: started.id, position: 0 } })).response).toBeNull()
      expect((yield* asha.first.practice.list())[0]).toMatchObject({ status: "active", answered: 1, correct: 0 })

      yield* TestClock.adjust("20 seconds")
      const third = yield* answer(asha.first, second, "C")
      yield* TestClock.adjust("5 seconds")
      const done = yield* answer(asha.first, third, "C")
      expect(done).toMatchObject({ status: "finished", endedBy: "finished", current: null })
      expect(done.results.map((result) => [result.correct, result.guessed, result.timeSpentMs])).toEqual([
        [false, true, 10_000],
        [true, false, 20_000],
        [true, false, 5_000]
      ])
      const first = yield* asha.first.practice.review({ params: { id: started.id, position: 0 } })
      expect(first.response).toMatchObject({ correct: false, guessed: true, rated: true, timedOut: false })
      expect(first.debrief?.correct).toBe(false)
      expect((yield* asha.first.practice.list())[0]).toMatchObject({ endedBy: "finished", answered: 3, correct: 2 })
    })))

  test("takes its time limit from the Target Times the Curator sets", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(3))
      const curator = yield* openInspectableBrowser
      yield* curator.api.curatorAccess.setPassphrase({ payload: { passphrase: "correct horse battery" } })
      Option.getOrThrow(yield* curator.cookie("gp_curator"))
      yield* curator.api.settings.saveTargetTimes({ payload: { times: [{ questionType: "quant.ps", seconds: 100 }] } })
      const asha = yield* learner("Asha")
      const started = yield* asha.first.practice.start({ payload: { choice: timed(3) } })
      expect(started.clock?.limitMs).toBe(300_000)
    })))

  test("ends when its time runs out with no browser open, giving the Question on screen a time-out Response", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(2))
      const asha = yield* learner("Asha")
      const started = yield* asha.first.practice.start({ payload: { choice: timed(2) } })
      yield* TestClock.adjust("30 seconds")
      yield* answer(asha.first, started, "C")
      // The tab is closed; the server's clock goes on.
      yield* TestClock.adjust("5 minutes")
      const ended = yield* get(asha.first, started)
      expect(ended).toMatchObject({ status: "finished", endedBy: "time" })
      expect(ended.clock).toMatchObject({ elapsedMs: 258_000, remainingMs: 0 })
      expect(ended.results.map((result) => [result.correct, result.timedOut])).toEqual([[true, false], [false, true]])
      const timedOut = yield* asha.first.practice.review({ params: { id: started.id, position: 1 } })
      expect(timedOut.response).toMatchObject({ selection: [], timedOut: true, rated: false, timeSpentMs: 228_000 })
      expect((yield* asha.first.practice.review({ params: { id: started.id, position: 0 } })).response?.rated).toBe(true)
      const db = yield* Db
      const kinds = yield* db.select({ kind: responses.kind }).from(responses).pipe(Effect.orDie)
      expect(kinds.map((row) => row.kind).toSorted()).toEqual(["first", "time-out"])
    })))

  test("saves its clock every 5 seconds, and after a restart goes on from the last save, not counting the stop", async () => {
    const dataDir = tempDataDir()
    const { setId, profileId } = await runWithWorkers(
      Effect.gen(function*() {
        yield* seedBook("Quant Review", numbered(3))
        const asha = yield* learner("Asha")
        const started = yield* asha.first.practice.start({ payload: { choice: timed(3) } })
        yield* TestClock.adjust("12 seconds")
        const db = yield* Db
        const [saved] = yield* db.select().from(sessions).where(eq(sessions.id, started.id)).pipe(Effect.orDie)
        expect(saved).toMatchObject({ elapsedMs: 10_000, interrupted: false })
        expect((yield* get(asha.first, started)).clock?.elapsedMs).toBe(12_000)
        return { setId: started.id, profileId: asha.profileId }
      }),
      undefined,
      dataDir
    )
    // The app starts again a minute later.
    await runWithWorkers(
      Effect.gen(function*() {
        const tabs = yield* browserWithTabs
        yield* tabs.first.profiles.unlock({ params: { id: profileId }, payload: {} })
        yield* TestClock.adjust("1 second")
        const back = yield* tabs.first.practice.get({ params: { id: setId } })
        expect(back.clock).toMatchObject({ elapsedMs: 10_000, interrupted: true })
        yield* TestClock.adjust("3 seconds")
        expect((yield* tabs.first.practice.get({ params: { id: setId } })).clock?.elapsedMs).toBe(13_000)
      }),
      undefined,
      dataDir,
      70_000
    )
  })

  test("pauses with its Question hidden and its clock stopped; an untimed set has no clock to pause", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(4))
      const asha = yield* learner("Asha")
      const started = yield* asha.first.practice.start({ payload: { choice: timed(2) } })
      yield* TestClock.adjust("10 seconds")
      const paused = yield* asha.first.practice.pause({ params: { id: started.id } })
      expect(paused).toMatchObject({ status: "paused", current: null })
      expect((yield* asha.first.practice.list())[0]?.status).toBe("paused")
      yield* TestClock.adjust("1 minute")
      expect((yield* get(asha.first, started)).clock?.elapsedMs).toBe(10_000)
      const refused = yield* answer(asha.first, started, "C").pipe(Effect.flip)
      expect(refused).toMatchObject({ _tag: "PracticeOutOfStep", reason: "paused" })

      const resumed = yield* asha.first.practice.resume({ params: { id: started.id } })
      expect(resumed.status).toBe("active")
      expect(resumed.current?.position).toBe(0)
      yield* TestClock.adjust("3 seconds")
      expect((yield* get(asha.first, started)).clock).toMatchObject({ elapsedMs: 13_000, interrupted: false })

      const plain = yield* asha.first.practice.start({ payload: { choice: untimed(1) } })
      expect(plain.clock).toBeNull()
      const notTimed = yield* asha.first.practice.pause({ params: { id: plain.id } }).pipe(Effect.flip)
      expect(notTimed).toMatchObject({ _tag: "PracticeOutOfStep", reason: "untimed" })
    })))

  test("held by one tab, it is read-only in another until that tab takes it over", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(3))
      const asha = yield* learner("Asha")
      const started = yield* asha.first.practice.start({ payload: { choice: timed(3) } })
      const seen = yield* get(asha.second, started)
      expect(seen).toMatchObject({ heldHere: false, current: { position: 0 } })
      const refused = yield* answer(asha.second, seen, "C").pipe(Effect.flip)
      expect(refused).toMatchObject({ _tag: "HeldElsewhere", view: { heldHere: false } })
      expect((yield* get(asha.first, started)).heldHere).toBe(true)

      const taken = yield* asha.second.practice.claim({ params: { id: started.id } })
      expect(taken.heldHere).toBe(true)
      expect((yield* get(asha.first, started)).heldHere).toBe(false)
      const stale = yield* asha.first.practice.pause({ params: { id: started.id } }).pipe(Effect.flip)
      expect(stale._tag).toBe("HeldElsewhere")
      expect((yield* answer(asha.second, taken, "C")).current?.position).toBe(1)
    })))
})

describe("Rated Responses", () => {
  test("move Difficulty by K and give the Section a Score Estimate with its range", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(3))
      const asha = yield* learner("Asha")
      let view = yield* asha.first.practice.start({ payload: { choice: timed(3) } })
      const order: Array<string> = []
      const db = yield* Db
      for (const choice of ["C", "A", "C"]) {
        order.push(view.current!.question.id)
        view = yield* answer(asha.first, view, choice)
        // Nothing moves while the set runs, so no Score Estimate gives away
        // how an answer went.
        if (view.status !== "finished") {
          expect(yield* asha.first.practice.scores()).toEqual([])
          expect(yield* db.select().from(difficulty).pipe(Effect.orDie)).toEqual([])
        }
      }
      // Each moves its Question's Difficulty, seeded at 0, by the Ability the
      // Section had before it.
      const answers: Array<WeightedAnswer> = []
      const expected = [true, false, true].map((correct) => {
        const before = fitAbility(answers).ability
        const moved = nextDifficulty(0, 0, before, correct)
        answers.push({ difficulty: moved, correct, weight: 1 })
        return moved
      })
      expect(expected[0]).toBeCloseTo(-0.15, 12)
      for (const [index, questionId] of order.entries()) {
        const [row] = yield* db.select().from(difficulty).where(eq(difficulty.questionId, questionId)).pipe(Effect.orDie)
        expect(row?.ratedResponses).toBe(1)
        expect(row?.value).toBeCloseTo(expected[index]!, 9)
      }
      const fit = fitAbility(answers)
      const estimate = scoreEstimate(fit)
      const [quant, ...others] = yield* asha.first.practice.scores()
      expect(others).toEqual([])
      expect(quant).toMatchObject({
        section: { id: "quant" },
        ratedResponses: 3,
        score: estimate.score,
        low: estimate.low,
        high: estimate.high,
        calibrated: false
      })
      expect(quant?.ability).toBeCloseTo(fit.ability, 9)
      expect(quant?.standardError).toBeCloseTo(fit.standardError, 9)
      // One Score Estimate is kept for each Rated Response.
      expect(yield* db.select().from(scoreEstimates).pipe(Effect.orDie)).toHaveLength(3)
    })))

  test("a set's answers count once it ends, after the sets that ended before it", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(4))
      const asha = yield* learner("Asha")
      // One set waits half done while another runs to its end.
      const waiting = yield* asha.first.practice.start({ payload: { choice: timed(2) } })
      const left = yield* answer(asha.first, waiting, "A")
      let other = yield* asha.first.practice.start({ payload: { choice: timed(2) } })
      while (other.current !== null) other = yield* answer(asha.first, other, "C")
      expect((yield* asha.first.practice.scores())[0]).toMatchObject({ ratedResponses: 2 })
      const db = yield* Db
      const firstAnswer = left.results[0]!.questionId
      expect(yield* db.select().from(difficulty).where(eq(difficulty.questionId, firstAnswer)).pipe(Effect.orDie))
        .toEqual([])
      // Ending the first set moves its Question by the Ability the other set
      // left: two right answers on Questions seeded at 0.
      yield* asha.first.practice.finish({ params: { id: waiting.id } })
      const before: Array<WeightedAnswer> = []
      for (const correct of [true, true]) {
        before.push({ difficulty: nextDifficulty(0, 0, fitAbility(before).ability, correct), correct, weight: 1 })
      }
      const [moved] = yield* db.select().from(difficulty).where(eq(difficulty.questionId, firstAnswer)).pipe(Effect.orDie)
      expect(moved?.value).toBeCloseTo(nextDifficulty(0, 0, fitAbility(before).ability, false), 9)
      expect((yield* asha.first.practice.scores())[0]).toMatchObject({ ratedResponses: 3 })
    })))

  test("a Withdrawn Question's Responses stay in history but leave Ability", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(2))
      const asha = yield* learner("Asha")
      let view = yield* asha.first.practice.start({ payload: { choice: timed(2) } })
      while (view.current !== null) view = yield* answer(asha.first, view, "C")
      expect((yield* asha.first.practice.scores())[0]?.ratedResponses).toBe(2)
      const db = yield* Db
      yield* db.update(questions).set({ status: "withdrawn" }).where(eq(questions.id, view.results[0]!.questionId))
        .pipe(Effect.orDie)
      expect((yield* asha.first.practice.scores())[0]?.ratedResponses).toBe(1)
      expect(yield* db.select().from(responses).pipe(Effect.orDie)).toHaveLength(2)
    })))

  test("a Question first Seen untimed is never Rated, so it keeps its Difficulty", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(2))
      const asha = yield* learner("Asha")
      const plain = yield* asha.first.practice.start({ payload: { choice: untimed(1) } })
      const seenFirst = plain.current!.question.id
      yield* answer(asha.first, plain, "C")
      expect(yield* asha.first.practice.scores()).toEqual([])

      let view = yield* asha.first.practice.start({ payload: { choice: timed(2) } })
      while (view.current !== null) view = yield* answer(asha.first, view, "C")
      const db = yield* Db
      const moved = yield* db.select().from(difficulty).pipe(Effect.orDie)
      expect(moved.map((row) => row.questionId).includes(seenFirst)).toBe(false)
      expect(moved).toHaveLength(1)
      expect((yield* asha.first.practice.scores())[0]?.ratedResponses).toBe(1)
    })))
})

// A timed set runs 12 seconds, saved at 10, and the app stops; it starts
// again almost a minute later, and the request comes before its first tick.
const afterRestart = async <A>(request: (tab: Tab, setId: PracticeView["id"]) => Effect.Effect<A, unknown>) => {
  const dataDir = tempDataDir()
  const { setId, profileId } = await runWithWorkers(
    Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(1))
      const asha = yield* learner("Asha")
      const started = yield* asha.first.practice.start({ payload: { choice: timed(1) } })
      yield* TestClock.adjust("12 seconds")
      return { setId: started.id, profileId: asha.profileId }
    }),
    undefined,
    dataDir
  )
  return runWithWorkers(
    Effect.gen(function*() {
      const tabs = yield* browserWithTabs
      yield* tabs.first.profiles.unlock({ params: { id: profileId }, payload: {} })
      return yield* request(tabs.first, setId)
    }),
    undefined,
    dataDir,
    70_000
  )
}

describe("The clock between ticks", () => {
  test("a request before the first tick after a stop still marks the Session interrupted", async () => {
    const paused = await afterRestart((tab, id) => tab.practice.pause({ params: { id } }))
    expect(paused.clock).toMatchObject({ elapsedMs: 10_000, interrupted: true })
    const ended = await afterRestart((tab, id) => tab.practice.finish({ params: { id } }))
    expect(ended).toMatchObject({ endedBy: "finished", clock: { elapsedMs: 10_000, interrupted: true } })
    const answered = await afterRestart((tab, id) =>
      Effect.gen(function*() {
        const view = yield* tab.practice.get({ params: { id } })
        expect(view.clock?.interrupted).toBe(true)
        return yield* answer(tab, view, "C")
      })
    )
    expect(answered).toMatchObject({ endedBy: "finished", clock: { elapsedMs: 10_000, interrupted: true } })
  })

  test("the clock is saved when a Question is served, so its time spent counts from there after a restart", async () => {
    const dataDir = tempDataDir()
    const { setId, profileId } = await runWithWorkers(
      Effect.gen(function*() {
        yield* seedBook("Quant Review", numbered(3))
        const asha = yield* learner("Asha")
        const started = yield* asha.first.practice.start({ payload: { choice: timed(3) } })
        // The clock was saved at 10 seconds; the second Question is served at 14.
        yield* TestClock.adjust("14 seconds")
        expect((yield* answer(asha.first, started, "C")).current?.position).toBe(1)
        return { setId: started.id, profileId: asha.profileId }
      }),
      undefined,
      dataDir
    )
    await runWithWorkers(
      Effect.gen(function*() {
        const tabs = yield* browserWithTabs
        yield* tabs.first.profiles.unlock({ params: { id: profileId }, payload: {} })
        // The first tick after the stop finds the gap, and the next counts a
        // second.
        yield* TestClock.adjust("2 seconds")
        const view = yield* tabs.first.practice.get({ params: { id: setId } })
        const third = yield* answer(tabs.first, view, "C")
        expect(third.results.map((result) => result.timeSpentMs)).toEqual([14_000, 1_000, null])
        expect(third.clock?.elapsedMs).toBe(15_000)
      }),
      undefined,
      dataDir,
      70_000
    )
  })

  // Ticks keep the schedule they had when the latch last opened, so a
  // resume half a second after a pause leaves the set's limit between two
  // ticks.
  const offTheTicks = Effect.gen(function*() {
    yield* seedBook("Quant Review", numbered(1))
    const asha = yield* learner("Asha")
    const started = yield* asha.first.practice.start({ payload: { choice: timed(1) } })
    yield* TestClock.adjust("10 seconds")
    yield* asha.first.practice.pause({ params: { id: started.id } })
    yield* TestClock.adjust("500 millis")
    yield* asha.first.practice.resume({ params: { id: started.id } })
    yield* TestClock.adjust("119 seconds")
    expect(yield* get(asha.first, started)).toMatchObject({ status: "active", clock: { remainingMs: 0 } })
    return { asha, started }
  })

  test("a pause or End set that comes after the limit, before the next tick, ends the set by time", () =>
    runWithWorkers(Effect.gen(function*() {
      const { asha, started } = yield* offTheTicks
      const refused = yield* asha.first.practice.pause({ params: { id: started.id } }).pipe(Effect.flip)
      expect(refused).toMatchObject({ _tag: "PracticeOutOfStep", reason: "finished", view: { endedBy: "time" } })
      const db = yield* Db
      expect((yield* db.select().from(responses).pipe(Effect.orDie)).map((row) => row.kind)).toEqual(["time-out"])
    })))

  test("End set after the limit, before the next tick, gives the Question on screen its time-out Response", () =>
    runWithWorkers(Effect.gen(function*() {
      const { asha, started } = yield* offTheTicks
      const ended = yield* asha.first.practice.finish({ params: { id: started.id } })
      expect(ended).toMatchObject({ status: "finished", endedBy: "time" })
      expect(ended.results.map((result) => [result.correct, result.timedOut])).toEqual([[false, true]])
    })))
})

describe("Previewing a timed set", () => {
  test("gives the time limit the set then gets", () =>
    runWithWorkers(Effect.gen(function*() {
      // Questions of two Question Types with different Target Times, so the
      // limit depends on which ten are taken.
      yield* seedBook("Mixed Review", [
        ...numbered(10),
        ...Array.from({ length: 10 }, (_, i) => ({ number: 11 + i, questionType: "verbal.cr-weaken" }))
      ])
      const asha = yield* learner("Asha")
      const choice = timed(10)
      const limits = new Set<number>()
      for (let set = 0; set < 6; set++) {
        const preview = yield* asha.first.practice.preview({ payload: { choice } })
        const started = yield* asha.first.practice.start({ payload: { choice } })
        expect(started.clock?.limitMs).toBe(preview.limitMs!)
        limits.add(preview.limitMs!)
      }
      // Each set takes its own Questions.
      expect(limits.size).toBeGreaterThan(1)
    })))
})

describe("A paused set", () => {
  test("keeps its Questions hidden from review until it resumes", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(2))
      const asha = yield* learner("Asha")
      const started = yield* asha.first.practice.start({ payload: { choice: timed(2) } })
      yield* asha.first.practice.pause({ params: { id: started.id } })
      const refused = yield* asha.first.practice.review({ params: { id: started.id, position: 0 } }).pipe(Effect.flip)
      expect(refused).toMatchObject({ _tag: "PracticeOutOfStep", reason: "paused" })
      yield* asha.first.practice.resume({ params: { id: started.id } })
      expect((yield* asha.first.practice.review({ params: { id: started.id, position: 0 } })).position).toBe(0)
    })))
})
