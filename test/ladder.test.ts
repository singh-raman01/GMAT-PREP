import { describe, expect, test } from "bun:test"
import { type LadderEvent, ladderOf } from "../src/server/learning/ladder.ts"

// The Retry Ladder's schedule as rules over an entry's events
// (docs/design.md, "Learning loop").

let at = 0
const miss = (day: number): LadderEvent => ({ kind: "miss", day, at: ++at })
const attempt = (step: 1 | 2 | 3, day: number, passed: boolean, plannedAt = at): LadderEvent => ({
  kind: "attempt",
  step,
  day,
  at: ++at,
  passed,
  plannedAt
})
const skip = (step: 1 | 2 | 3, day: number): LadderEvent => ({ kind: "skip", step, day, at: ++at, note: "No unseen Sibling." })

const where = (events: ReadonlyArray<LadderEvent>) => {
  const ladder = ladderOf(events)
  return ladder === null ? null : { status: ladder.status, step: ladder.step, due: ladder.dueDay }
}

describe("The Retry Ladder", () => {
  test("has nothing to do before a miss", () => {
    expect(ladderOf([])).toBeNull()
    expect(ladderOf([attempt(1, 3, true)])).toBeNull()
  })

  test("falls due 2, 7 and 21 Study Days after the miss, and passing step 3 resolves the entry", () => {
    expect(where([miss(10)])).toEqual({ status: "open", step: 1, due: 12 })
    expect(where([miss(10), attempt(1, 12, true)])).toEqual({ status: "open", step: 2, due: 17 })
    expect(where([miss(10), attempt(1, 12, true), attempt(2, 17, true)])).toEqual({ status: "open", step: 3, due: 31 })
    const done = ladderOf([miss(10), attempt(1, 12, true), attempt(2, 17, true), attempt(3, 31, true)])!
    expect(done).toMatchObject({ status: "resolved", step: null, dueDay: null })
    expect(done.history.map((each) => [each.step, each.day, each.outcome])).toEqual([
      [1, 12, "passed"],
      [2, 17, "passed"],
      [3, 31, "passed"]
    ])
  })

  test("repeats a missed step 2 Study Days later", () => {
    expect(where([miss(10), attempt(1, 12, false)])).toEqual({ status: "open", step: 1, due: 14 })
    expect(where([miss(10), attempt(1, 12, false), attempt(1, 14, true)])).toEqual({ status: "open", step: 2, due: 17 })
    expect(where([miss(10), attempt(1, 12, true), attempt(2, 17, false)])).toEqual({ status: "open", step: 2, due: 19 })
  })

  test("a step passed late puts the next one no sooner than the next Study Day", () => {
    expect(where([miss(10), attempt(1, 20, true)])).toEqual({ status: "open", step: 2, due: 21 })
  })

  test("a skipped step counts as done, with its note", () => {
    const ladder = ladderOf([miss(10), attempt(1, 12, true), skip(2, 17)])!
    expect(where([miss(10), attempt(1, 12, true), skip(2, 17)])).toEqual({ status: "open", step: 3, due: 31 })
    expect(ladder.history.at(-1)).toEqual({ step: 2, day: 17, outcome: "skipped", note: "No unseen Sibling." })
  })

  test("a new miss outside the ladder starts it again, even once resolved", () => {
    expect(where([miss(10), attempt(1, 12, true), attempt(2, 17, true), miss(25)])).toEqual({ status: "open", step: 1, due: 27 })
    const resolved = [miss(10), attempt(1, 12, true), attempt(2, 17, true), attempt(3, 31, true)]
    expect(where([...resolved, miss(40)])).toEqual({ status: "open", step: 1, due: 42 })
  })

  test("an attempt at a step the ladder is not on changes nothing", () => {
    expect(where([miss(10), attempt(1, 12, true), attempt(1, 13, false)])).toEqual({ status: "open", step: 2, due: 17 })
    expect(where([miss(10), attempt(3, 12, true)])).toEqual({ status: "open", step: 1, due: 12 })
  })
})
