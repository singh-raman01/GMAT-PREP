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
import { questions } from "../src/server/db/schema.ts"
import { numbered, seedBook } from "./fixtures/bank.ts"
import { runWithWorkers, tempDataDir, type WorkerTestServices } from "./harness.ts"

// Through the API: two entries' steps in one timed retry set, the entries
// then merged into one Question. The set takes one step of the entry they
// became, the first whose step is due (docs/design.md, decision 68).

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
const ladderOf = (tab: Tab, questionId: string) =>
  tab.errorLog.list({ query: {} }).pipe(Effect.map((log) => log.entries.find((entry) => entry.questionId === questionId)))

describe("one set with two entries' Sibling steps, merged after", () => {
  test("Y's step 3, answered right in the set, still counts once X is merged into Y", () =>
    run(Effect.gen(function*() {
      const book = yield* seedBook("Quant Review", numbered(10))
      const x = book.ids.get(1)!
      const y = book.ids.get(2)!
      const asha = yield* learner("Asha")
      // Oct 1: Y missed. Oct 3: Y's step 1 passed.
      yield* takeSet(asha, yield* asha.practice.start({ payload: { choice: item(book.bookId, 2) } }), "A")
      yield* asha.later(2)
      yield* takeSet(asha, yield* asha.retries.start({ payload: { timed: false } }), "C")
      // Oct 4: X missed. Oct 6: X's step 1 passed.
      yield* asha.later(1)
      yield* takeSet(asha, yield* asha.practice.start({ payload: { choice: item(book.bookId, 1) } }), "A")
      yield* asha.later(2)
      yield* takeSet(asha, yield* asha.retries.start({ payload: { timed: false } }), "C")
      // Oct 8: Y's step 2 passed (a Sibling).
      yield* asha.later(2)
      yield* takeSet(asha, yield* asha.retries.start({ payload: { timed: true } }), "C")
      // Oct 22: one timed set, X's step 2 (due Oct 11) and Y's step 3 (due
      // Oct 22), both answered right.
      yield* asha.later(14)
      const due = yield* asha.retries.due()
      expect(due.due.map((each): [string, number] => [each.questionId, each.step])).toEqual([[x, 2], [y, 3]])
      const both = yield* takeSet(asha, yield* asha.retries.start({ payload: { timed: true } }), "C")
      expect(both.served.length).toBe(2)
      expect((yield* ladderOf(asha, x))!.ladder).toMatchObject({ step: 3 })
      expect((yield* ladderOf(asha, y))!.status).toBe("resolved")
      // The Curator merges X into Y, as duplicates.
      const db = yield* Db
      yield* db.update(questions).set({ mergedInto: y, status: "withdrawn" }).where(eq(questions.id, x)).pipe(Effect.orDie)
      const merged = yield* ladderOf(asha, y)
      // Y's run now starts at X's miss on Oct 4: step 1 Oct 6, step 2 Oct 8,
      // and the step 3 Sibling answered right on Oct 22.
      expect(merged!.status).toBe("resolved")
    })))
})
