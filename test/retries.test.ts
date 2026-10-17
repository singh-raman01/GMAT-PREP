import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { Api } from "../src/api/Api.ts"
import type { PracticeChoice, PracticeView } from "../src/api/Practice.ts"
import { RetrySetMax } from "../src/api/Retries.ts"
import type { QuestionId } from "../src/api/Review.ts"
import { Db } from "../src/server/db/Database.ts"
import { questions } from "../src/server/db/schema.ts"
import { numbered, OtherPsSkill, seedBook } from "./fixtures/bank.ts"
import { openBrowser, runWithWorkers, tempDataDir, type WorkerTestServices } from "./harness.ts"

// Noon UTC on 1 October 2026, so Study Days are whole days.
const Start = Date.UTC(2026, 9, 1, 12)
const run = <A, E>(effect: Effect.Effect<A, E, WorkerTestServices>) => runWithWorkers(effect, undefined, tempDataDir(), Start)

const learner = (name: string) =>
  Effect.gen(function*() {
    const jar = yield* Ref.make(Cookies.empty)
    const tab = yield* HttpApiClient.make(Api, {
      transformClient: (client) =>
        client.pipe(HttpClient.withCookiesRef(jar), HttpClient.mapRequest(HttpClientRequest.setHeader("x-gp-device", "tab-1")))
    })
    const profile = yield* tab.profiles.create({ payload: { name, timeZone: "UTC" } })
    // Days pass: the unlock lapses, and the Learner unlocks again.
    const later = (days: number) =>
      Effect.gen(function*() {
        yield* TestClock.adjust(`${days} days`)
        yield* tab.profiles.unlock({ params: { id: profile.id }, payload: {} })
      })
    return Object.assign(tab, { later })
  })
type Tab = Effect.Success<ReturnType<typeof learner>>

// Answers every Question of a set with the choice after the time given; an
// untimed set is finished after its last answer.
const takeSet = (tab: Tab, started: PracticeView, choice: string, seconds = 60, guessed = false) =>
  Effect.gen(function*() {
    let view = started
    const served: Array<QuestionId> = []
    while (view.current !== null && view.status === "active") {
      const current = view.current
      if (served.includes(current.question.id)) break
      served.push(current.question.id)
      yield* TestClock.adjust(`${seconds} seconds`)
      view = yield* tab.practice.answer({
        params: { id: view.id },
        payload: { seq: view.nextSeq, questionId: current.question.id, selection: [{ part: 0, choice }], guessed }
      })
      if (!view.timed && view.status === "active") {
        view = current.position + 1 >= view.total
          ? yield* tab.practice.finish({ params: { id: view.id } })
          : yield* tab.practice.next({ params: { id: view.id }, payload: { position: current.position + 1 } })
      }
    }
    return { view, served }
  })

const untimedSet = (size: number): PracticeChoice => ({ kind: "filters", status: "unseen", size })

describe("The Retry Ladder", () => {
  test("brings an entry back 2, 7 and 21 Study Days after the miss, and resolves it", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(6))
      const asha = yield* learner("Asha")
      const missed = yield* takeSet(asha, yield* asha.practice.start({ payload: { choice: untimedSet(1) } }), "A")
      const entry = missed.served[0]!
      expect((yield* asha.retries.due()).due).toEqual([])
      // Only the next step has a day: step 2's comes once step 1 is passed.
      expect((yield* asha.retries.due()).upcoming.map((day) => day.steps)).toEqual([0, 1, 0, 0, 0, 0, 0])

      yield* asha.later(2)
      const day2 = yield* asha.retries.due()
      expect(day2.due.map((each) => [each.questionId, each.step, each.timed, each.reasons])).toEqual([
        [entry, 1, false, ["wrong"]]
      ])
      expect([day2.untimed, day2.timed, day2.waiting]).toEqual([1, 0, 0])
      const first = yield* asha.retries.start({ payload: { timed: false } })
      expect(first).toMatchObject({ title: "Retries", timed: false })
      expect(first.current!.question.id).toBe(entry)
      yield* takeSet(asha, first, "C")
      const afterOne = (yield* asha.errorLog.list({ query: {} })).entries[0]!
      expect(afterOne.ladder).toMatchObject({ step: 2, dueOn: "2026-10-08", steps: [{ step: 1, on: "2026-10-03", outcome: "passed" }] })

      yield* asha.later(5)
      const day7 = yield* asha.retries.due()
      expect(day7.due.map((each) => [each.step, each.timed])).toEqual([[2, true]])
      const second = yield* asha.retries.start({ payload: { timed: true } })
      expect(second).toMatchObject({ title: "Retries, timed", timed: true })
      expect(second.current!.question.id).not.toBe(entry)
      const took = yield* takeSet(asha, second, "C")
      expect(took.view.status).toBe("finished")
      // A Sibling first Seen in a timed set is Rated.
      expect((yield* asha.practice.scores())[0]).toMatchObject({ ratedResponses: 1 })

      yield* asha.later(14)
      const third = yield* asha.retries.start({ payload: { timed: true } })
      yield* takeSet(asha, third, "C")
      const resolved = (yield* asha.errorLog.list({ query: { status: "resolved" } })).entries
      expect(resolved.map((each) => [each.questionId, each.status, each.ladder?.step ?? null])).toEqual([[entry, "resolved", null]])
      expect((yield* asha.retries.due()).due).toEqual([])
    })))

  test("repeats a missed step 2 Study Days later with a new Sibling, and the missed Sibling gets its own entry", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(6))
      const asha = yield* learner("Asha")
      const missed = yield* takeSet(asha, yield* asha.practice.start({ payload: { choice: untimedSet(1) } }), "A")
      const entry = missed.served[0]!
      yield* asha.later(2)
      yield* takeSet(asha, yield* asha.retries.start({ payload: { timed: false } }), "C")
      yield* asha.later(5)
      const sibling = (yield* takeSet(asha, yield* asha.retries.start({ payload: { timed: true } }), "B")).served[0]!
      yield* asha.later(2)
      const due = yield* asha.retries.due()
      expect(due.due.map((each) => [each.questionId, each.step, each.timed]).toSorted()).toEqual([
        [entry, 2, true],
        [sibling, 1, false]
      ].toSorted())
      const again = yield* asha.retries.start({ payload: { timed: true } })
      expect(again.current!.question.id).not.toBe(sibling)
      expect(again.current!.question.id).not.toBe(entry)
    })))

  test("skips a Sibling step with none left, with a note, and the Curator sees the Skill", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(1, { primarySkill: OtherPsSkill }))
      const asha = yield* learner("Asha")
      yield* takeSet(asha, yield* asha.practice.start({ payload: { choice: untimedSet(1) } }), "A")
      yield* asha.later(2)
      yield* takeSet(asha, yield* asha.retries.start({ payload: { timed: false } }), "C")
      yield* asha.later(5)
      const refused = yield* asha.retries.start({ payload: { timed: true } }).pipe(Effect.flip)
      expect(refused).toMatchObject({ _tag: "NoRetriesDue", skipped: 1 })
      const [entry] = (yield* asha.errorLog.list({ query: {} })).entries
      expect(entry!.ladder).toMatchObject({
        step: 3,
        dueOn: "2026-10-22",
        steps: [{ step: 1, outcome: "passed" }, { step: 2, outcome: "skipped", note: "No unseen Sibling of its Question Type and Skill was left." }]
      })
      const curator = yield* openBrowser
      yield* curator.curatorAccess.setPassphrase({ payload: { passphrase: "correct horse battery" } })
      const report = yield* curator.siblings.report()
      expect(report.map((each) => [each.skill.id, each.questionType.id, each.skipped, each.available])).toEqual([[OtherPsSkill, "quant.ps", 1, 1]])
    })))

  test("a slow entry's step 1 is timed and passes only within 1.5 times the Target Time", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(4))
      const asha = yield* learner("Asha")
      // Target Time is 129 seconds, so a set of 2 has 258: the first answer
      // at 200 is right but slow, the second at 50 right.
      const slow: Array<QuestionId> = []
      for (const _ of [1, 2]) {
        let view = yield* asha.practice.start({ payload: { choice: { ...untimedSet(2), timed: true } } })
        slow.push(view.current!.question.id)
        for (const seconds of [200, 50]) {
          yield* TestClock.adjust(`${seconds} seconds`)
          view = yield* asha.practice.answer({
            params: { id: view.id },
            payload: { seq: view.nextSeq, questionId: view.current!.question.id, selection: [{ part: 0, choice: "C" }], guessed: false }
          })
        }
        expect(view.status).toBe("finished")
      }
      yield* asha.later(2)
      const due = yield* asha.retries.due()
      expect(due.due.map((each) => [each.questionId, each.step, each.timed, each.reasons])).toEqual(
        slow.map((id) => [id, 1, true, ["slow"]])
      )
      expect(yield* asha.retries.start({ payload: { timed: false } }).pipe(Effect.flip, Effect.map((error) => error._tag)))
        .toBe("NoRetriesDue")
      let view = yield* asha.retries.start({ payload: { timed: true } })
      const order: Array<QuestionId> = []
      for (const seconds of [200, 50]) {
        order.push(view.current!.question.id)
        yield* TestClock.adjust(`${seconds} seconds`)
        view = yield* asha.practice.answer({
          params: { id: view.id },
          payload: { seq: view.nextSeq, questionId: view.current!.question.id, selection: [{ part: 0, choice: "C" }], guessed: false }
        })
      }
      const entries = new Map((yield* asha.errorLog.list({ query: {} })).entries.map((entry) => [entry.questionId, entry] as const))
      expect(entries.get(order[0]!)!.ladder).toMatchObject({ step: 1, dueOn: "2026-10-05", steps: [{ step: 1, outcome: "missed" }] })
      expect(entries.get(order[1]!)!.ladder).toMatchObject({ step: 2, dueOn: "2026-10-08", steps: [{ step: 1, outcome: "passed" }] })
    })))

  test("starting retries while a retry set runs goes back to it", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(3))
      const asha = yield* learner("Asha")
      yield* takeSet(asha, yield* asha.practice.start({ payload: { choice: untimedSet(2) } }), "A")
      yield* asha.later(2)
      const started = yield* asha.retries.start({ payload: { timed: false } })
      expect(started.total).toBe(2)
      expect((yield* asha.retries.due()).running).toBe(started.id)
      const again = yield* asha.retries.start({ payload: { timed: false } }).pipe(Effect.flip)
      expect(again).toMatchObject({ _tag: "RetriesRunning", id: started.id })
    })))
})

// What the Curator's merge does to the merged Question (ReviewQueue.ts).
const merge = (from: string, into: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    yield* db.update(questions).set({ status: "withdrawn", mergedInto: into }).where(eq(questions.id, from))
  }).pipe(Effect.orDie)

const answerAt = (tab: Tab, view: PracticeView, seconds: number, choice: string) =>
  Effect.gen(function*() {
    yield* TestClock.adjust(`${seconds} seconds`)
    return yield* tab.practice.answer({
      params: { id: view.id },
      payload: { seq: view.nextSeq, questionId: view.current!.question.id, selection: [{ part: 0, choice }], guessed: false }
    })
  })

const ladderOf = (tab: Tab, questionId: string) =>
  tab.errorLog.list({ query: {} }).pipe(Effect.map((log) => log.entries.find((entry) => entry.questionId === questionId)?.ladder))

describe("Review fixes in Retries", () => {
  test("a slow entry's steps get 1.5 times the Target Time on the set's clock, so a lone one can pass", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(4))
      const asha = yield* learner("Asha")
      let view = yield* asha.practice.start({ payload: { choice: { ...untimedSet(2), timed: true } } })
      const slow = view.current!.question.id
      view = yield* answerAt(asha, view, 200, "C")
      yield* answerAt(asha, view, 50, "C")
      yield* asha.later(2)
      const retry = yield* asha.retries.start({ payload: { timed: true } })
      expect([retry.total, retry.clock!.limitMs]).toEqual([1, 193_500])
      expect((yield* answerAt(asha, retry, 150, "C")).status).toBe("finished")
      expect(yield* ladderOf(asha, slow)).toMatchObject({ step: 2, steps: [{ step: 1, outcome: "passed" }] })
    })))

  test("a step 1 whose Question is out of the Question Bank waits, counted but not listed", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(3))
      const asha = yield* learner("Asha")
      const missed = yield* takeSet(asha, yield* asha.practice.start({ payload: { choice: untimedSet(2) } }), "A")
      const [kept, checked] = missed.served
      const db = yield* Db
      yield* db.update(questions).set({ status: "draft" }).where(eq(questions.id, checked!)).pipe(Effect.orDie)
      yield* asha.later(2)
      const due = yield* asha.retries.due()
      expect([due.due.map((each) => each.questionId), due.untimed, due.waiting]).toEqual([[kept!], 1, 1])
      const first = yield* takeSet(asha, yield* asha.retries.start({ payload: { timed: false } }), "C")
      expect(first.served).toEqual([kept!])
      expect((yield* asha.retries.start({ payload: { timed: false } }).pipe(Effect.flip))._tag).toBe("NoRetriesDue")
      yield* db.update(questions).set({ status: "published" }).where(eq(questions.id, checked!)).pipe(Effect.orDie)
      expect((yield* asha.retries.due()).due.map((each) => each.questionId)).toEqual([checked!])
    })))

  test("a merge keeps the ladder, whether before or while its retry set runs", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(4))
      const asha = yield* learner("Asha")
      const missed = yield* takeSet(asha, yield* asha.practice.start({ payload: { choice: untimedSet(2) } }), "A")
      const [x, z] = missed.served
      // X: step 1 missed on day 2, passed on day 4, so step 2 is due Oct 8.
      yield* asha.later(2)
      const day2 = yield* asha.retries.start({ payload: { timed: false } })
      const order = (yield* takeSet(asha, day2, "A")).served
      expect(order.toSorted()).toEqual([x!, z!].toSorted())
      yield* asha.later(2)
      // Z is merged while the set that retries it runs: its target is served
      // in its place, and the step is credited to the entry it became.
      const db = yield* Db
      const others = (yield* db.select({ id: questions.id }).from(questions).pipe(Effect.orDie)).map((row) => row.id)
        .filter((id) => id !== x && id !== z)
      const day4 = yield* asha.retries.start({ payload: { timed: false } })
      const zTarget = others[0]!
      yield* merge(z!, zTarget)
      const took = yield* takeSet(asha, day4, "C")
      expect(took.served.length).toBe(2)
      // X merged afterwards into the other spare Question keeps its due day.
      const xTarget = others[1]!
      expect(yield* ladderOf(asha, x!)).toMatchObject({ step: 2, dueOn: "2026-10-08" })
      yield* merge(x!, xTarget)
      expect(yield* ladderOf(asha, xTarget)).toMatchObject({ step: 2, dueOn: "2026-10-08" })
      expect(yield* ladderOf(asha, zTarget)).toMatchObject({ step: 2, dueOn: "2026-10-08" })
    })))

  test("a retry set made before a new miss takes no step of the run that miss starts", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(3))
      const asha = yield* learner("Asha")
      const missed = yield* takeSet(asha, yield* asha.practice.start({ payload: { choice: untimedSet(1) } }), "A")
      const entry = missed.served[0]!
      yield* asha.later(2)
      const retry = yield* asha.retries.start({ payload: { timed: false } })
      expect(retry.current!.question.id).toBe(entry)
      // Missed again in another set, and its Debrief seen, before the old
      // retry set is answered right.
      const again = yield* asha.practice.start({ payload: { choice: { kind: "filters", status: "missed", size: 1 } } })
      yield* takeSet(asha, again, "A")
      yield* takeSet(asha, retry, "C")
      expect(yield* ladderOf(asha, entry)).toMatchObject({ step: 1, dueOn: "2026-10-05", steps: [] })
    })))

  test(`a retry set takes ${RetrySetMax} steps at most, the longest waiting first`, () =>
    run(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(RetrySetMax + 3))
      const asha = yield* learner("Asha")
      const first = (yield* takeSet(asha, yield* asha.practice.start({ payload: { choice: untimedSet(3) } }), "A")).served
      yield* asha.later(1)
      yield* takeSet(asha, yield* asha.practice.start({ payload: { choice: untimedSet(RetrySetMax) } }), "A")
      yield* asha.later(2)
      const due = yield* asha.retries.due()
      expect([due.untimed, due.due.length]).toEqual([RetrySetMax + 3, RetrySetMax])
      const set = yield* asha.retries.start({ payload: { timed: false } })
      expect(set.total).toBe(RetrySetMax)
      expect(set.current!.question.id).toBe(first[0]!)
    })))

  test("the Siblings report lists a Skill and type whose Questions are all in the Mock Reserve", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Quant Review", [
        ...numbered(8),
        ...numbered(3, { primarySkill: OtherPsSkill, reserve: true }, 9)
      ])
      const curator = yield* openBrowser
      yield* curator.curatorAccess.setPassphrase({ payload: { passphrase: "correct horse battery" } })
      const report = yield* curator.siblings.report()
      expect(report.map((each) => [each.skill.id, each.questionType.id, each.skipped, each.available])).toEqual([
        [OtherPsSkill, "quant.ps", 0, 0]
      ])
    })))
})
