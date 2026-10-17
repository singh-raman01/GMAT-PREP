import { describe, expect, test } from "bun:test"
import { checkQuestionsNow, type LessonCandidate, pickLessonQuestions } from "../src/server/lessons/pick.ts"

// Picking a Lesson's worked examples and check (docs/design.md, decision 96).

const candidate = (id: string, difficulty: number, extra: Partial<LessonCandidate> = {}): LessonCandidate => ({
  id,
  difficulty,
  hasApproach: false,
  hasExplanation: false,
  stimulusId: null,
  ...extra
})

const band = (prefix: string, difficulty: number, count: number, extra: Partial<LessonCandidate> = {}) =>
  Array.from({ length: count }, (_, index) => candidate(`${prefix}${index}`, difficulty, extra))

describe("A Lesson's Questions", () => {
  test("need the 5-Question check and a worked example", () => {
    expect(pickLessonQuestions(band("q", 0, 5))).toBeUndefined()
    expect(pickLessonQuestions(band("q", 0, 6))).toEqual({ examples: ["q0"], checks: ["q1", "q2", "q3", "q4", "q5"] })
  })

  test("take 3 worked examples, those with an Approach and an explanation first, over the bands", () => {
    const pool = [
      ...band("e", -1, 4),
      ...band("m", 0, 4),
      ...band("h", 1, 4),
      candidate("m-best", 0, { hasApproach: true, hasExplanation: true }),
      candidate("h-approach", 1, { hasApproach: true })
    ]
    const pick = pickLessonQuestions(pool)!
    expect(pick.examples).toEqual(["m-best", "h-approach", "e0"])
    expect(pick.checks.length).toBe(5)
    // The check spreads over the bands too, Medium first.
    expect(pick.checks).toEqual(["m0", "e1", "h0", "m1", "e2"])
    expect(pick.checks.some((id) => pick.examples.includes(id))).toBe(false)
  })

  test("keep Questions about one passage apart while others are left", () => {
    const pool = [
      ...band("p", 0, 4, { stimulusId: "passage-1" }),
      ...band("s", 0, 4, { stimulusId: "passage-2" }),
      ...band("x", 0, 2)
    ]
    const pick = pickLessonQuestions(pool)!
    const stimulusOf = new Map(pool.map((each) => [each.id, each.stimulusId] as const))
    const exampleStimuli = pick.examples.map((id) => stimulusOf.get(id)).filter((each) => each !== null)
    expect(new Set(exampleStimuli).size).toBe(exampleStimuli.length)
  })

  test("are the same whatever order the Questions come in", () => {
    const pool = [...band("e", -1, 5), ...band("m", 0, 5), ...band("h", 1, 5), candidate("a", 0.2, { hasApproach: true })]
    const first = pickLessonQuestions(pool)
    for (let turn = 0; turn < 20; turn++) {
      const shuffled = pool.map((each, index) => ({ each, key: (index * 7919 + turn * 104729) % 97 }))
        .toSorted((a, b) => a.key - b.key).map(({ each }) => each)
      expect(pickLessonQuestions(shuffled)).toEqual(first)
    }
  })
})

describe("The check now", () => {
  test("keeps the Questions picked, and replaces one gone, never with a worked example", () => {
    const pool = [...band("m", 0, 8)]
    const now = checkQuestionsNow(["m1", "m2", "m3", "m4", "gone"], ["m0"], pool)
    expect(now).toEqual(["m1", "m2", "m3", "m4", "m5"])
  })

  test("is shorter when the subject has run short", () => {
    expect(checkQuestionsNow(["m1", "gone"], ["m0"], band("m", 0, 2))).toEqual(["m1"])
  })
})
