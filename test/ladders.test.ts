import { describe, expect, test } from "bun:test"
import { laddersOf, type RetrySession, type SkipFact } from "../src/server/learning/ladders.ts"
import type { Miss, QuestionFact, Reason, ResponseFact } from "../src/server/learning/misses.ts"

// Each entry's Retry Ladder from the facts: misses start it, retry
// Responses take its steps, skips pass them over.

const Day = 1000
const question = (id: string): QuestionFact => ({
  id,
  unit: null,
  targetMs: 120_000,
  parts: [{ position: 0, key: "C", notes: new Map() }]
})
const questions = new Map(["q1", "q2", "s1", "s2"].map((id) => [id, question(id)] as const))

const miss = (questionId: string, day: number, sessionId = "p1", reasons: ReadonlyArray<Reason> = ["wrong"]): Miss => ({
  sessionId,
  questionId,
  responseId: `${sessionId}-${questionId}`,
  at: day * Day,
  reasons,
  parts: []
})

let seq = 0
const response = (sessionId: string, questionId: string, day: number, choice: string, changes: Partial<ResponseFact> = {}): ResponseFact => ({
  id: `r${++seq}`,
  sessionId,
  questionId,
  kind: "first",
  seq,
  selection: [{ part: 0, choice }],
  timeSpentMs: 60_000,
  guessed: false,
  at: day * Day + 1,
  ...changes
})

const retrySet = (id: string, items: RetrySession["retry"], shown = true, createdAt = 0): RetrySession => ({
  id,
  shown,
  retry: items,
  createdAt
})

const run = (
  misses: ReadonlyArray<Miss>,
  sessions: ReadonlyArray<RetrySession> = [],
  responses: ReadonlyArray<ResponseFact> = [],
  skips: ReadonlyArray<SkipFact> = [],
  resolve: (id: string) => string = (id) => id
) =>
  laddersOf({
    misses,
    sessions,
    responses,
    questions,
    skips,
    resolve,
    dayOf: (at) => Math.floor(at / Day)
  })

const where = (ladders: ReturnType<typeof run>, entry: string) => {
  const found = ladders.get(entry)
  return found === undefined ? undefined : { status: found.ladder.status, step: found.ladder.step, due: found.ladder.dueDay }
}

describe("An entry's Retry Ladder", () => {
  test("takes step 1 with the entry's own Question, and its miss there is the step, not a new miss", () => {
    const passed = run([miss("q1", 0)], [retrySet("r1", [{ entry: "q1", step: 1, questionId: "q1" }])], [
      response("r1", "q1", 2, "C")
    ])
    expect(where(passed, "q1")).toEqual({ status: "open", step: 2, due: 7 })
    const missed = run(
      [miss("q1", 0), miss("q1", 2, "r1")],
      [retrySet("r1", [{ entry: "q1", step: 1, questionId: "q1" }])],
      [response("r1", "q1", 2, "A")]
    )
    expect(where(missed, "q1")).toEqual({ status: "open", step: 1, due: 4 })
  })

  test("a missed Sibling fails the step and starts its own ladder", () => {
    const ladders = run(
      [miss("q1", 0), miss("s1", 7, "r2")],
      [
        retrySet("r1", [{ entry: "q1", step: 1, questionId: "q1" }]),
        retrySet("r2", [{ entry: "q1", step: 2, questionId: "s1" }])
      ],
      [response("r1", "q1", 2, "C"), response("r2", "s1", 7, "B")]
    )
    expect(where(ladders, "q1")).toEqual({ status: "open", step: 2, due: 9 })
    expect(where(ladders, "s1")).toEqual({ status: "open", step: 1, due: 9 })
  })

  test("a slow entry's step must come within 1.5 times the Target Time, a guessed one's not marked guessed", () => {
    const slow = run([miss("q1", 0, "p1", ["slow"])], [retrySet("r1", [{ entry: "q1", step: 1, questionId: "q1" }])], [
      response("r1", "q1", 2, "C", { timeSpentMs: 180_001 })
    ])
    expect(where(slow, "q1")).toMatchObject({ step: 1, due: 4 })
    expect(slow.get("q1")!.reasons).toEqual(["slow"])
    const guessed = run([miss("q1", 0, "p1", ["guessed"])], [retrySet("r1", [{ entry: "q1", step: 1, questionId: "q1" }])], [
      response("r1", "q1", 2, "C", { guessed: true })
    ])
    expect(where(guessed, "q1")).toMatchObject({ step: 1, due: 4 })
    const wrongEntry = run([miss("q1", 0)], [retrySet("r1", [{ entry: "q1", step: 1, questionId: "q1" }])], [
      response("r1", "q1", 2, "C", { guessed: true, timeSpentMs: 300_000 })
    ])
    expect(where(wrongEntry, "q1")).toMatchObject({ step: 2 })
  })

  test("a step counts once its set shows how it went, and a skip passes it over", () => {
    const hidden = run([miss("q1", 0)], [retrySet("r1", [{ entry: "q1", step: 1, questionId: "q1" }], false)], [
      response("r1", "q1", 2, "C")
    ])
    expect(where(hidden, "q1")).toMatchObject({ step: 1, due: 2 })
    const skipped = run(
      [miss("q1", 0)],
      [retrySet("r1", [{ entry: "q1", step: 1, questionId: "q1" }])],
      [response("r1", "q1", 2, "C")],
      [{ questionId: "q1", step: 2, at: 7 * Day, note: "No unseen Sibling." }]
    )
    expect(where(skipped, "q1")).toEqual({ status: "open", step: 3, due: 21 })
  })

  test("passing step 3 resolves the entry", () => {
    const ladders = run(
      [miss("q1", 0)],
      [
        retrySet("r1", [{ entry: "q1", step: 1, questionId: "q1" }]),
        retrySet("r2", [{ entry: "q1", step: 2, questionId: "s1" }]),
        retrySet("r3", [{ entry: "q1", step: 3, questionId: "s2" }])
      ],
      [response("r1", "q1", 2, "C"), response("r2", "s1", 7, "C"), response("r3", "s2", 21, "C")]
    )
    expect(where(ladders, "q1")).toEqual({ status: "resolved", step: null, due: null })
  })

  test("follows a merge: a step-1 miss of the merged Question stays the step, and its Responses count", () => {
    // q2 was merged into q1 after its step 1 was missed on day 2 and passed
    // on day 4; the misses come judged as q1, as missesOf gives them.
    const merged = (id: string) => (id === "q2" ? "q1" : id)
    const ladders = run(
      [miss("q1", 0), { ...miss("q1", 2, "r1"), responseId: "r1-q2" }],
      [
        retrySet("r1", [{ entry: "q2", step: 1, questionId: "q2" }], true, 2 * Day),
        retrySet("r2", [{ entry: "q2", step: 1, questionId: "q2" }], true, 4 * Day)
      ],
      [response("r1", "q2", 2, "A"), response("r2", "q1", 4, "C")],
      [],
      merged
    )
    expect(where(ladders, "q1")).toEqual({ status: "open", step: 2, due: 7 })
  })

  test("a set made before the miss that starts a run takes none of its steps", () => {
    const ladders = run(
      [miss("q1", 0), miss("q1", 3, "p2")],
      [retrySet("r1", [{ entry: "q1", step: 1, questionId: "q1" }], true, 2 * Day)],
      [response("r1", "q1", 3, "C", { at: 3 * Day + 5 })]
    )
    expect(where(ladders, "q1")).toEqual({ status: "open", step: 1, due: 5 })
  })

  test("a step-1 miss starts the run when no other miss came before it, as after a Key Override", () => {
    const ladders = run(
      [miss("q1", 2, "r1")],
      [retrySet("r1", [{ entry: "q1", step: 1, questionId: "q1" }], true, 2 * Day)],
      [response("r1", "q1", 2, "A")]
    )
    expect(where(ladders, "q1")).toMatchObject({ status: "open", step: 1 })
  })

  test("after a Key Override, only the first step-1 miss starts the run; the next is step 1 missed", () => {
    const own = [{ entry: "q1", step: 1 as const, questionId: "q1" }]
    const ladders = run(
      [miss("q1", 2, "r1"), miss("q1", 4, "r2")],
      [retrySet("r1", own, true, 2 * Day), retrySet("r2", own, true, 4 * Day), retrySet("r3", own, true, 6 * Day)],
      [response("r1", "q1", 2, "A"), response("r2", "q1", 4, "A"), response("r3", "q1", 6, "C")]
    )
    const ladder = ladders.get("q1")!.ladder
    expect([ladder.startDay, ladder.step, ladder.dueDay]).toEqual([2, 2, 9])
    expect(ladder.history.map((each) => [each.step, each.day, each.outcome])).toEqual([[1, 4, "missed"], [1, 6, "passed"]])
  })

  test("in one set, each Response goes to the item whose Question it answered, and an entry takes one step", () => {
    // X merged into q1: two items of one set now count for q1, answered once.
    const merged = (id: string) => (id === "q2" ? "q1" : id)
    const one = run(
      [miss("q1", 0), miss("q1", 2, "r1")],
      [retrySet("r1", [{ entry: "q2", step: 1, questionId: "q2" }, { entry: "q1", step: 1, questionId: "q1" }], true, 2 * Day)],
      [response("r1", "q1", 2, "A")],
      [],
      merged
    )
    expect(one.get("q1")!.ladder.history.map((each) => [each.step, each.outcome])).toEqual([[1, "missed"]])
    // A Sibling s1 answered right keeps its own answer when it is later
    // merged into another item's Question, answered wrong in the same set.
    const sibling = (id: string) => (id === "s1" ? "q2" : id)
    const ladders = run(
      [miss("q1", 0), miss("q2", 1), miss("q2", 7, "r2")],
      [
        retrySet("r1", [{ entry: "q1", step: 1, questionId: "q1" }], true, 2 * Day),
        retrySet("r2", [{ entry: "q1", step: 2, questionId: "s1" }, { entry: "q2", step: 1, questionId: "q2" }], true, 7 * Day)
      ],
      [response("r1", "q1", 2, "C"), response("r2", "s1", 7, "C"), response("r2", "q2", 7, "A")],
      [],
      sibling
    )
    expect(where(ladders, "q1")).toEqual({ status: "open", step: 3, due: 21 })
  })
})
