import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { Db } from "../src/server/db/Database.ts"
import { llmCalls, reviewItems } from "../src/server/db/schema.ts"
import { monthStart } from "../src/server/review/Overview.ts"
import { numbered, OtherPsSkill, PsSkill, seedBook } from "./fixtures/bank.ts"
import { openBrowser, runWithWorkers, tempDataDir, type WorkerTestServices } from "./harness.ts"

// The Curator's Overview (docs/design.md, "Analytics").

// Noon UTC on 15 October 2026.
const Start = Date.UTC(2026, 9, 15, 12)
const run = <A, E>(effect: Effect.Effect<A, E, WorkerTestServices>) => runWithWorkers(effect, undefined, tempDataDir(), Start)

const call = (at: number, cost: number) => ({
  id: crypto.randomUUID(),
  jobId: null,
  task: "enrich",
  model: "test",
  promptVersion: "1",
  tokensIn: 10,
  tokensOut: 10,
  tokensEstimated: false,
  cost,
  outcome: "ok",
  detail: null,
  createdAt: at
})

describe("The Curator's Overview", () => {
  test("covers each Skill by Difficulty Band, counts the Reserve per group and the Mocks it covers, and this month's spend", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Quant Review", [
        ...numbered(2, { seed: -1 }),
        ...numbered(1, { seed: 0 }, 3),
        ...numbered(1, { seed: 1, secondarySkills: [OtherPsSkill] }, 4),
        ...numbered(3, { reserve: true }, 5)
      ])
      const db = yield* Db
      yield* db.insert(reviewItems).values({
        id: crypto.randomUUID(),
        questionId: null,
        bookId: null,
        page: null,
        reasons: "[]",
        relatedQuestionId: null,
        status: "open",
        decision: null,
        createdAt: 0
      }).pipe(Effect.orDie)
      yield* db.insert(llmCalls).values([call(Start, 0.25), call(Start - 1000, 0.5), call(monthStart(Start) - 1, 9)]).pipe(Effect.orDie)
      yield* TestClock.adjust("1 hour")
      const curator = yield* openBrowser
      yield* curator.curatorAccess.setPassphrase({ payload: { passphrase: "correct horse battery" } })
      const overview = yield* curator.overview.get()
      const row = (skill: string) => overview.coverage.find((each) => each.skill.id === skill)!
      // The Reserve's three are published too, at medium.
      expect(row(PsSkill)).toMatchObject({ section: { id: "quant" }, easy: 2, medium: 4, hard: 1 })
      expect(row(OtherPsSkill)).toMatchObject({ easy: 0, medium: 0, hard: 1 })
      expect(overview.coverage.length).toBeGreaterThan(40)
      expect(overview.reserve.find((each) => each.group.id === "ps")).toMatchObject({ held: 3, perMock: 21 })
      expect(overview.mocks).toBe(0)
      expect(overview.reviewQueue).toBe(1)
      // The 1st in the time zone the app runs in.
      expect(overview.monthFrom).toBe(new Date(2026, 9, 1).getTime())
      expect(overview.spend).toBeCloseTo(0.75, 10)
    })))
})
