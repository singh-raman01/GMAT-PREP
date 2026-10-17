import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { Api } from "../src/api/Api.ts"
import { BookId } from "../src/api/Books.ts"
import type { PracticeChoice, PracticeView } from "../src/api/Practice.ts"
import type { QuestionId } from "../src/api/Review.ts"
import { Db } from "../src/server/db/Database.ts"
import { parts } from "../src/server/db/schema.ts"
import { numbered, seedBook } from "./fixtures/bank.ts"
import { runWithWorkers, tempDataDir, type WorkerTestServices } from "./harness.ts"

// Through the API: a Key Override after a run resolved and a second run
// began. A miss in the entry's own step 1 starts a run when none is open
// then (docs/design.md, decision 68).

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
    const later = (days: number) =>
      Effect.gen(function*() {
        yield* TestClock.adjust(`${days} days`)
        yield* tab.profiles.unlock({ params: { id: profile.id }, payload: {} })
      })
    return Object.assign(tab, { later })
  })
type Tab = Effect.Success<ReturnType<typeof learner>>

const takeSet = (tab: Tab, started: PracticeView, choice: string, seconds = 60) =>
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
        payload: { seq: view.nextSeq, questionId: current.question.id, selection: [{ part: 0, choice }], guessed: false }
      })
      if (!view.timed && view.status === "active") {
        view = current.position + 1 >= view.total
          ? yield* tab.practice.finish({ params: { id: view.id } })
          : yield* tab.practice.next({ params: { id: view.id }, payload: { position: current.position + 1 } })
      }
    }
    return { view, served }
  })
const item = (bookId: string, number: number): PracticeChoice => ({ kind: "book", bookId: BookId.make(bookId), set: "Problem Solving", from: number, to: number })
const entryOf = (tab: Tab, questionId: string) =>
  tab.errorLog.list({ query: {} }).pipe(Effect.map((log) => log.entries.find((entry) => entry.questionId === questionId)))

describe("a Key Override after a run resolved and a second one began", () => {
  test("the wrong answer in the second run's step 1 starts a run of its own", () =>
    run(Effect.gen(function*() {
      const book = yield* seedBook("Quant Review", numbered(8))
      const q = book.ids.get(1)!
      const asha = yield* learner("Asha")
      // Key C. Oct 1: A, wrong. Step 1: B (Oct 3), A (Oct 5), C (Oct 7).
      yield* takeSet(asha, yield* asha.practice.start({ payload: { choice: item(book.bookId, 1) } }), "A")
      for (const choice of ["B", "A", "C"]) {
        yield* asha.later(2)
        yield* takeSet(asha, yield* asha.retries.start({ payload: { timed: false } }), choice)
      }
      // Steps 2 (Oct 8) and 3 (Oct 22), Siblings, right: Resolved.
      yield* asha.later(1)
      yield* takeSet(asha, yield* asha.retries.start({ payload: { timed: true } }), "C")
      yield* asha.later(14)
      yield* takeSet(asha, yield* asha.retries.start({ payload: { timed: true } }), "C")
      expect((yield* entryOf(asha, q))!.status).toBe("resolved")
      // Oct 30: A again, wrong: run 2. Nov 1: its step 1, B, wrong.
      yield* asha.later(8)
      yield* takeSet(asha, yield* asha.practice.start({ payload: { choice: item(book.bookId, 1) } }), "A")
      yield* asha.later(2)
      yield* takeSet(asha, yield* asha.retries.start({ payload: { timed: false } }), "B")
      expect((yield* entryOf(asha, q))!.ladder).toMatchObject({ step: 1, dueOn: "2026-11-03" })
      // The Curator finds the key was A.
      const db = yield* Db
      yield* db.update(parts).set({ key: "A" }).where(eq(parts.questionId, q)).pipe(Effect.orDie)
      const entry = (yield* entryOf(asha, q))!
      // Under key A, Oct 1 and Oct 30 are right and the run from Oct 3
      // ended Resolved, so Nov 1's B starts a run.
      expect(entry.status).toBe("open")
    })))
})
