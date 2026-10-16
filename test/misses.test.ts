import { describe, expect, test } from "bun:test"
import {
  type Miss,
  missesOf,
  type QuestionFact,
  type ResponseFact,
  type ServedFact,
  type SessionFact
} from "../src/server/learning/misses.ts"

// What enters the Error Log from each Session (docs/design.md, "Learning
// loop"), as rules over the facts.

const Target = 120_000

const question = (id: string, changes: Partial<QuestionFact> = {}): QuestionFact => ({
  id,
  unit: null,
  targetMs: Target,
  parts: [{
    position: 0,
    key: "C",
    notes: new Map([
      ["A", { mistakeType: "trap", trapPattern: "quant.trap.partial-answer" }],
      ["B", { mistakeType: "calculation-slip", trapPattern: null }],
      ["D", { mistakeType: "misread", trapPattern: null }]
    ])
  }],
  ...changes
})

const untimed: SessionFact = { id: "s1", kind: "practice", limitMs: null, shown: true }

let seq = 0
const response = (questionId: string, choice: string | null, changes: Partial<ResponseFact> = {}): ResponseFact => ({
  id: `r${++seq}`,
  sessionId: "s1",
  questionId,
  kind: choice === null ? "time-out" : "first",
  seq,
  selection: choice === null ? [] : [{ part: 0, choice }],
  timeSpentMs: 90_000,
  guessed: false,
  at: 1000 + seq,
  ...changes
})

const run = (
  responses: ReadonlyArray<ResponseFact>,
  options: {
    readonly sessions?: ReadonlyArray<SessionFact>
    readonly questions?: ReadonlyArray<QuestionFact>
    readonly served?: ReadonlyArray<ServedFact>
  } = {}
): ReadonlyArray<Miss> =>
  missesOf({
    sessions: options.sessions ?? [untimed],
    responses,
    served: options.served ?? [],
    questions: options.questions ?? [question("q1"), question("q2"), question("q3")]
  })

const brief = (misses: ReadonlyArray<Miss>) =>
  misses.map((miss) => ({ question: miss.questionId, reasons: miss.reasons, parts: miss.parts }))

describe("A Session's final Response enters the Error Log", () => {
  test("when wrong, with the picked option's Mistake Type and Trap Pattern", () => {
    expect(brief(run([response("q1", "A"), response("q2", "C"), response("q3", "B")]))).toEqual([
      {
        question: "q1",
        reasons: ["wrong"],
        parts: [{ part: 0, picked: "A", mistakeType: "trap", trapPattern: "quant.trap.partial-answer", basis: "option" }]
      },
      {
        question: "q3",
        reasons: ["wrong"],
        parts: [{ part: 0, picked: "B", mistakeType: "calculation-slip", trapPattern: null, basis: "option" }]
      }
    ])
  })

  test("an option with no note leaves the Mistake Type for the Learner", () => {
    expect(brief(run([response("q1", "E")]))[0]!.parts).toEqual([
      { part: 0, picked: "E", mistakeType: null, trapPattern: null, basis: "none" }
    ])
  })

  test("when slow: right but over 1.5 times the Target Time, in a timed Session only", () => {
    const timed: SessionFact = { id: "s1", kind: "practice", limitMs: 600_000, shown: true }
    const answers = [response("q1", "C", { timeSpentMs: 180_000 }), response("q2", "C", { timeSpentMs: 180_001 })]
    expect(brief(run(answers, { sessions: [timed] }))).toEqual([{ question: "q2", reasons: ["slow"], parts: [] }])
    // An untimed set's time runs while the Question sits open, so it says nothing.
    expect(run(answers)).toEqual([])
  })

  test("when guessed: right but marked guessed, in Practice Sets only", () => {
    const timed: SessionFact = { id: "s1", kind: "practice", limitMs: 600_000, shown: true }
    const sectional: SessionFact = { id: "s2", kind: "sectional", limitMs: 2_700_000, shown: true }
    expect(brief(run(
      [
        response("q1", "C", { guessed: true }),
        response("q2", "C", { guessed: true, timeSpentMs: 200_000 }),
        response("q3", "C", { guessed: true, sessionId: "s2" })
      ],
      { sessions: [timed, sectional] }
    ))).toEqual([
      { question: "q1", reasons: ["guessed"], parts: [] },
      { question: "q2", reasons: ["slow", "guessed"], parts: [] }
    ])
  })

  test("only once the Session shows how it went", () => {
    const running: SessionFact = { id: "s2", kind: "practice", limitMs: 600_000, shown: false }
    expect(run([response("q1", "A", { sessionId: "s2" })], { sessions: [untimed, running] })).toEqual([])
  })
})

describe("Time pressure", () => {
  test("is the Mistake Type of a time-out, whatever was on screen", () => {
    expect(brief(run([response("q1", null)]))).toEqual([
      {
        question: "q1",
        reasons: ["wrong"],
        parts: [{ part: 0, picked: null, mistakeType: "time-pressure", trapPattern: null, basis: "timing" }]
      }
    ])
  })

  test("is the Mistake Type of an answer given in under a quarter of the Target Time", () => {
    expect(brief(run([response("q1", "A", { timeSpentMs: 29_999 }), response("q2", "B", { timeSpentMs: 30_000 })])).map(
      (miss) => miss.parts[0]!.mistakeType
    )).toEqual(["time-pressure", "calculation-slip"])
  })

  test("is the Mistake Type of an answer given in the Section's last 10% of time", () => {
    const timed: SessionFact = { id: "s1", kind: "sectional", limitMs: 1_000_000, shown: true }
    const misses = run(
      [response("q1", "A", { timeSpentMs: 60_000 }), response("q2", "A", { timeSpentMs: 60_000 })],
      {
        sessions: [timed],
        served: [{ sessionId: "s1", questionId: "q1", servedElapsedMs: 839_999 }, {
          sessionId: "s1",
          questionId: "q2",
          servedElapsedMs: 840_000
        }]
      }
    )
    expect(misses.map((miss) => miss.parts[0]!.mistakeType)).toEqual(["trap", "time-pressure"])
  })
})

describe("Review & Edit", () => {
  test("an answer fixed there stays out, and one changed to a wrong answer is judged on it, timed by the first", () => {
    const sectional: SessionFact = { id: "s1", kind: "sectional", limitMs: 2_700_000, shown: true }
    const misses = run(
      [
        response("q1", "A", { timeSpentMs: 200_000 }),
        response("q2", "C", { timeSpentMs: 10_000 }),
        response("q1", "C", { kind: "edit", timeSpentMs: 0 }),
        response("q2", "D", { kind: "edit", timeSpentMs: 0 })
      ],
      { sessions: [sectional] }
    )
    expect(brief(misses)).toEqual([
      {
        question: "q2",
        reasons: ["wrong"],
        parts: [{ part: 0, picked: "D", mistakeType: "time-pressure", trapPattern: null, basis: "timing" }]
      }
    ])
  })
})

describe("A passage or set", () => {
  test("is timed as a whole: each right Question of a slow passage is slow", () => {
    const passage = ["q1", "q2", "q3"].map((id) => question(id, { unit: "passage-1" }))
    const sectional: SessionFact = { id: "s1", kind: "sectional", limitMs: 2_700_000, shown: true }
    const slow = run([
      response("q1", "C", { timeSpentMs: 200_000 }),
      response("q2", "A", { timeSpentMs: 200_000 }),
      response("q3", "C", { timeSpentMs: 141_000 })
    ], { questions: passage, sessions: [sectional] })
    expect(brief(slow).map((miss) => [miss.question, miss.reasons])).toEqual([["q1", ["slow"]], ["q2", ["wrong"]], ["q3", ["slow"]]])
    // 3 x 120 s x 1.5 is 540 s: a passage done in 540 s is not slow.
    const inTime = run([
      response("q1", "C", { timeSpentMs: 300_000 }),
      response("q2", "C", { timeSpentMs: 120_000 }),
      response("q3", "C", { timeSpentMs: 120_000 })
    ], { questions: passage, sessions: [sectional] })
    expect(inTime).toEqual([])
  })

  test("is rushed as a whole: a quick later Question of a passage read at pace is not Time pressure", () => {
    const passage = ["q1", "q2", "q3"].map((id) => question(id, { unit: "passage-1" }))
    const sectional: SessionFact = { id: "s1", kind: "sectional", limitMs: 2_700_000, shown: true }
    const read = run([
      response("q1", "C", { timeSpentMs: 300_000 }),
      response("q2", "A", { timeSpentMs: 25_000 }),
      response("q3", "C", { timeSpentMs: 40_000 })
    ], { questions: passage, sessions: [sectional] })
    expect(brief(read).map((miss) => miss.parts[0]!.mistakeType)).toEqual(["trap"])
    // 3 x 120 s / 4 is 90 s: a passage done in 85 s is rushed.
    const rushed = run([
      response("q1", "C", { timeSpentMs: 45_000 }),
      response("q2", "A", { timeSpentMs: 20_000 }),
      response("q3", "C", { timeSpentMs: 20_000 })
    ], { questions: passage, sessions: [sectional] })
    expect(brief(rushed).map((miss) => miss.parts[0]!.mistakeType)).toEqual(["time-pressure"])
  })
})

describe("A Question of several Parts", () => {
  test("lists only its wrong Parts", () => {
    const tpa = question("q1", {
      parts: [0, 1].map((position) => ({
        position,
        key: position === 0 ? "B" : "C",
        notes: new Map([["A", { mistakeType: "misread", trapPattern: null }]])
      }))
    })
    expect(brief(run([response("q1", "B", { selection: [{ part: 0, choice: "B" }, { part: 1, choice: "A" }] })], {
      questions: [tpa]
    }))).toEqual([
      { question: "q1", reasons: ["wrong"], parts: [{ part: 1, picked: "A", mistakeType: "misread", trapPattern: null, basis: "option" }] }
    ])
  })
})

describe("A merged Question", () => {
  test("counts as the one it became, judged by that one's key", () => {
    // m1 was merged into q1, whose key is now A.
    const merged = missesOf({
      sessions: [untimed],
      responses: [response("m1", "C")],
      served: [],
      questions: [question("q1", { parts: [{ position: 0, key: "A", notes: new Map() }] }), question("m1")],
      resolve: (id) => (id === "m1" ? "q1" : id)
    })
    expect(brief(merged)).toEqual([
      { question: "q1", reasons: ["wrong"], parts: [{ part: 0, picked: "C", mistakeType: null, trapPattern: null, basis: "none" }] }
    ])
  })
})
