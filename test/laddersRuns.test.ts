import { describe, expect, test } from "bun:test"
import { laddersOf, type RetrySession } from "../src/server/learning/ladders.ts"
import type { Miss, QuestionFact, Reason, ResponseFact } from "../src/server/learning/misses.ts"

// How a run starts and how many steps a retry set takes (docs/design.md,
// decisions 66 and 68), with plain facts: a miss in an entry's own step 1
// starts a run only when none is open then, and a set takes at most one
// step of an entry, the first whose step is the one due.

const Day = 1000
const question = (id: string, key = "C"): QuestionFact => ({ id, unit: null, targetMs: 120_000, parts: [{ position: 0, key, notes: new Map() }] })
const miss = (questionId: string, at: number, sessionId: string, reasons: ReadonlyArray<Reason> = ["wrong"]): Miss => ({
  sessionId,
  questionId,
  responseId: `${sessionId}-${questionId}`,
  at,
  reasons,
  parts: []
})
let seq = 0
const response = (sessionId: string, questionId: string, at: number, choice: string): ResponseFact => ({
  id: `r${++seq}`,
  sessionId,
  questionId,
  kind: "first",
  seq,
  selection: [{ part: 0, choice }],
  timeSpentMs: 60_000,
  guessed: false,
  at
})
const set = (id: string, items: RetrySession["retry"], createdAt: number): RetrySession => ({ id, shown: true, retry: items, createdAt })
const ladder = (input: {
  misses: ReadonlyArray<Miss>
  sessions: ReadonlyArray<RetrySession>
  responses: ReadonlyArray<ResponseFact>
  questions: ReadonlyMap<string, QuestionFact>
  resolve?: (id: string) => string
}) =>
  laddersOf({ ...input, skips: [], resolve: input.resolve ?? ((id) => id), dayOf: (at) => Math.floor(at / Day) })
interface Seen {
  readonly status: string
  readonly startDay: number
  readonly step: number | null
  readonly dueDay: number | null
  readonly history: ReadonlyArray<string>
}
const view = (ladders: ReturnType<typeof ladder>, entry: string): Seen => {
  const found = ladders.get(entry)!.ladder
  return {
    status: found.status,
    startDay: found.startDay,
    step: found.step,
    dueDay: found.dueDay,
    history: found.history.map((each) => `${each.step}:${each.day}:${each.outcome}`)
  }
}

// A seeded shuffle, so a failure can be repeated.
const shuffled = <A>(items: ReadonlyArray<A>, seed: number) => {
  const out = [...items]
  let state = seed
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648
    const j = state % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

describe("several step-1 misses after a Key Override", () => {
  // Key now A. The first answer (A) is right; r1, r2, r3 answer step 1 with
  // B; r4 answers A. Decision 68: r1 starts the run (its set takes no step),
  // r2 and r3 are step 1 missed, r4 passes it: step 2 is due day 2 + 7.
  const q = new Map([["q", question("q", "A")]])
  const own = [{ entry: "q", step: 1 as const, questionId: "q" }]
  const misses = [miss("q", 2 * Day + 5, "r1"), miss("q", 4 * Day + 5, "r2"), miss("q", 6 * Day + 5, "r3")]
  const sessions = [set("r1", own, 2 * Day), set("r2", own, 4 * Day), set("r3", own, 6 * Day), set("r4", own, 8 * Day)]
  const responses = [
    response("r1", "q", 2 * Day + 5, "B"),
    response("r2", "q", 4 * Day + 5, "B"),
    response("r3", "q", 6 * Day + 5, "B"),
    response("r4", "q", 8 * Day + 5, "A")
  ]
  const expected = { status: "open", startDay: 2, step: 2, dueDay: 9, history: ["1:4:missed", "1:6:missed", "1:8:passed"] }

  test("the first starts the run, the later ones are step 1 missed", () => {
    expect(view(ladder({ misses, sessions, responses, questions: q }), "q")).toEqual(expected)
  })

  test("the same whatever order the misses, sets and Responses come in", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const got = view(
        ladder({ misses: shuffled(misses, seed), sessions: shuffled(sessions, seed + 1), responses: shuffled(responses, seed + 2), questions: q }),
        "q"
      )
      expect({ seed, ...got }).toEqual({ seed, ...expected })
    }
  })
})

describe("a step-1 miss once the run it would belong to has ended", () => {
  // Old key C. Day 0: A, wrong, run 1. Step 1: B (r1, day 2), A (r2, day 4),
  // C (r3, day 6, passed). Sibling steps pass on days 7 (s2) and 21 (s3):
  // Resolved. Day 30: A again in a Practice Set, wrong, run 2. Its step 1 on
  // day 32 (r4): B, wrong. Then a Key Override makes A the key.
  // Under key A, days 0 and 30 are right and r1 (B), r3 (C) and r4 (B) are
  // wrong. r1 starts a run; r2 passes step 1, s2 and s3 pass steps 2 and 3,
  // so it is Resolved on day 21. No run is open on day 32, so r4 starts one.
  test("a wrong answer in step 1 after the run resolved starts a new run", () => {
    const qs = new Map([["q", question("q", "A")], ["sib1", question("sib1")], ["sib2", question("sib2")]])
    const own = [{ entry: "q", step: 1 as const, questionId: "q" }]
    const ladders = ladder({
      misses: [miss("q", 2 * Day + 5, "r1"), miss("q", 6 * Day + 5, "r3"), miss("q", 32 * Day + 5, "r4")],
      sessions: [
        set("r1", own, 2 * Day),
        set("r2", own, 4 * Day),
        set("r3", own, 6 * Day),
        set("s2", [{ entry: "q", step: 2, questionId: "sib1" }], 7 * Day),
        set("s3", [{ entry: "q", step: 3, questionId: "sib2" }], 21 * Day),
        set("r4", own, 32 * Day)
      ],
      responses: [
        response("r1", "q", 2 * Day + 5, "B"),
        response("r2", "q", 4 * Day + 5, "A"),
        response("r3", "q", 6 * Day + 5, "C"),
        response("s2", "sib1", 7 * Day + 5, "C"),
        response("s3", "sib2", 21 * Day + 5, "C"),
        response("r4", "q", 32 * Day + 5, "B")
      ],
      questions: qs
    })
    const got = view(ladders, "q")
    expect({ status: got.status, startDay: got.startDay }).toEqual({ status: "open", startDay: 32 })
  })
})

describe("two items of one set that count for one entry after a merge", () => {
  // Y: missed day 0, step 1 passed day 2 (r1), step 2 passed day 7 (r2).
  // X: missed day 3, step 1 passed day 5 (r3). On day 21 one timed set (r4)
  // takes X's step 2 (Sibling s2, due day 10, so listed first) and Y's step
  // 3 (Sibling s3); both are answered right. Then the Curator merges X into
  // Y. Y's ladder now runs from X's miss on day 3: step 1 day 5, step 2 day
  // 7, so step 3 is next, and r4's item for it was answered right.
  const qs = new Map(["x", "y", "s1", "s2", "s3"].map((id) => [id, question(id)] as const))
  const input = (resolve: (id: string) => string) => ({
    misses: [miss("y", 0, "p0"), miss(resolve("x"), 3 * Day, "p1")],
    sessions: [
      set("r1", [{ entry: "y", step: 1, questionId: "y" }], 2 * Day),
      set("r3", [{ entry: "x", step: 1, questionId: "x" }], 5 * Day),
      set("r2", [{ entry: "y", step: 2, questionId: "s1" }], 7 * Day),
      set("r4", [{ entry: "x", step: 2, questionId: "s2" }, { entry: "y", step: 3, questionId: "s3" }], 21 * Day)
    ],
    responses: [
      response("r1", "y", 2 * Day + 5, "C"),
      response("r3", "x", 5 * Day + 5, "C"),
      response("r2", "s1", 7 * Day + 5, "C"),
      response("r4", "s2", 21 * Day + 5, "C"),
      response("r4", "s3", 21 * Day + 9, "C")
    ],
    questions: qs,
    resolve
  })

  test("before the merge: X at step 3, Y Resolved", () => {
    const ladders = ladder(input((id) => id))
    expect([view(ladders, "x").step, view(ladders, "y").status]).toEqual([3, "resolved"])
  })

  test("after the merge, the set gives Y the item whose step is due: step 3, so Y is Resolved", () => {
    const got = view(ladder(input((id) => (id === "x" ? "y" : id))), "y")
    expect(got.status).toBe("resolved")
  })
})
