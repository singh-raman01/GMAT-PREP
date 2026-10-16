import { describe, expect, test } from "bun:test"
import { EnoughEvidence, type RatedFact, scopeAbilities, SlowPace } from "../src/server/analytics/abilities.ts"
import { frequenciesOf } from "../src/server/analytics/frequency.ts"
import { mixesOf, remedyOf, weakAreasOf } from "../src/server/analytics/weakAreas.ts"
import { fitAbility } from "../src/server/ratings/model.ts"

// Skill and Question Type Abilities, Weak Areas and their remedies
// (docs/design.md, "Ratings and scores" and "Learning loop"), as rules over
// Rated Responses.

const fact = (changes: Partial<RatedFact> = {}): RatedFact => ({
  section: "quant",
  questionType: "quant.ps",
  primarySkill: "quant.algebra.linear-equations",
  secondarySkills: [],
  difficulty: 0,
  correct: true,
  recency: 1,
  pace: 1,
  ...changes
})

const many = (count: number, changes: Partial<RatedFact>) => Array.from({ length: count }, () => fact(changes))

const find = (abilities: ReturnType<typeof scopeAbilities>, kind: "skill" | "questionType", id: string) =>
  abilities.find((each) => each.kind === kind && each.id === id)!

describe("A Skill's Ability", () => {
  test("is fitted from its Rated Responses, a secondary Skill's at half weight, with the prior on the reference Ability", () => {
    const facts = [
      ...many(6, { correct: false }),
      ...many(6, { primarySkill: "quant.word-problems.percents", secondarySkills: ["quant.algebra.linear-equations"], correct: true })
    ]
    const abilities = scopeAbilities(facts, new Map([["quant", 0.4]]))
    const linear = find(abilities, "skill", "quant.algebra.linear-equations")
    const expected = fitAbility(
      [...many(6, { correct: false }).map((each) => ({ ...each, weight: 1 })), ...many(6, { correct: true }).map((each) => ({ ...each, weight: 0.5 }))],
      { mean: 0.4, spread: 1 }
    )
    expect(linear.fit.ability).toBeCloseTo(expected.ability, 10)
    expect(linear.fit.standardError).toBeCloseTo(expected.standardError, 10)
    expect(linear).toMatchObject({ evidence: 12, enough: true, reference: 0.4 })
    expect(linear.gap).toBeCloseTo(0.4 - expected.ability, 10)
  })

  test("of a Skill answered in two Sections has the Section Abilities averaged by where its weight came from as reference", () => {
    const facts = [
      ...many(3, { section: "quant" }),
      ...many(1, { section: "di", questionType: "di.ds" }),
      ...many(2, { section: "di", questionType: "di.ds", primarySkill: "di.sufficiency.value", secondarySkills: ["quant.algebra.linear-equations"] })
    ]
    const abilities = scopeAbilities(facts, new Map([["quant", 1], ["di", -1]]))
    // Weights: quant 3, di 1 + 2 × 0.5 = 2.
    expect(find(abilities, "skill", "quant.algebra.linear-equations").reference).toBeCloseTo((3 * 1 + 2 * -1) / 5, 10)
    expect(find(abilities, "questionType", "di.ds").reference).toBe(-1)
  })

  test("needs 8 Rated Responses, and is slow when its correct ones' median pace is over 1.3", () => {
    const seven = scopeAbilities(many(EnoughEvidence - 1, {}), new Map([["quant", 0]]))
    expect(find(seven, "skill", "quant.algebra.linear-equations").enough).toBe(false)
    const paced = scopeAbilities(
      [...many(5, { pace: SlowPace + 0.1 }), ...many(4, { pace: 1 }), ...many(3, { pace: 9, correct: false })],
      new Map([["quant", 0]])
    )
    // Correct paces: four of 1, five of 1.4; the median is 1.4.
    expect(find(paced, "skill", "quant.algebra.linear-equations")).toMatchObject({ enough: true, slow: true })
    expect(find(paced, "skill", "quant.algebra.linear-equations").pace).toBeCloseTo(1.4, 10)
    const exact = scopeAbilities(many(8, { pace: SlowPace }), new Map([["quant", 0]]))
    expect(find(exact, "questionType", "quant.ps").slow).toBe(false)
  })
})

describe("Exam frequency", () => {
  test("is each Skill's share of official Questions, a secondary Skill counting half, else of the whole Question Bank", () => {
    const question = (official: boolean, primarySkill: string, secondarySkills: ReadonlyArray<string> = []) => ({
      official,
      questionType: "quant.ps",
      primarySkill,
      secondarySkills
    })
    const bank = [
      question(true, "a"),
      question(true, "b", ["a"]),
      question(true, "b"),
      question(true, "c"),
      question(false, "a"),
      question(false, "a")
    ]
    const official = frequenciesOf(bank)
    expect(official.basis).toBe("official")
    expect(official.skills.get("a")).toBeCloseTo(1.5 / 4, 10)
    expect(official.questionTypes.get("quant.ps")).toBe(1)
    const unofficial = frequenciesOf(bank.map((each) => ({ ...each, official: false })))
    expect(unofficial.basis).toBe("bank")
    expect(unofficial.skills.get("a")).toBeCloseTo(3.5 / 6, 10)
  })
})

describe("Weak Areas", () => {
  test("are those with enough data below their reference, ranked by gap times frequency", () => {
    const facts = [
      ...many(10, { correct: false }),
      ...many(10, { primarySkill: "quant.word-problems.percents", correct: false, difficulty: -1 }),
      ...many(10, { primarySkill: "quant.number-properties.divisibility", correct: true })
    ]
    const abilities = scopeAbilities(facts, new Map([["quant", 0]]))
    const frequency = {
      basis: "official" as const,
      skills: new Map([["quant.algebra.linear-equations", 0.1], ["quant.word-problems.percents", 0.4]]),
      questionTypes: new Map([["quant.ps", 1]])
    }
    const weak = weakAreasOf(abilities, frequency, new Map())
    expect(weak.map((each) => `${each.kind}:${each.id}`).toSorted()).toEqual([
      "questionType:quant.ps",
      "skill:quant.algebra.linear-equations",
      "skill:quant.word-problems.percents"
    ])
    for (const each of weak) expect(each.priority).toBeCloseTo(each.gap * each.frequency, 10)
    expect(weak.map((each) => each.priority)).toEqual(weak.map((each) => each.priority).toSorted((a, b) => b - a))
    // Missed at an easier Difficulty and more frequent, percents outranks linear equations.
    expect(weak.findIndex((each) => each.id === "quant.word-problems.percents"))
      .toBeLessThan(weak.findIndex((each) => each.id === "quant.algebra.linear-equations"))
    expect(weak.some((each) => each.id === "quant.number-properties.divisibility")).toBe(false)
  })

  test("count the Mistake Types of their misses, and their remedy is timed for slow, rushed, slip or approach mistakes", () => {
    const mixes = mixesOf([
      { questionType: "quant.ps", primarySkill: "a", secondarySkills: ["b"], kinds: ["trap", "trap"] },
      { questionType: "quant.ps", primarySkill: "a", secondarySkills: [], kinds: ["slow"] },
      { questionType: "quant.ds", primarySkill: "b", secondarySkills: [], kinds: ["time-pressure"] }
    ])
    expect(Object.fromEntries(mixes.get("skill:a")!)).toEqual({ trap: 2, slow: 1 })
    expect(Object.fromEntries(mixes.get("skill:b")!)).toEqual({ trap: 2, "time-pressure": 1 })
    expect(Object.fromEntries(mixes.get("questionType:quant.ps")!)).toEqual({ trap: 2, slow: 1 })
    expect(remedyOf(false, new Map([["trap", 3], ["slow", 5]]))).toEqual({ timed: false })
    expect(remedyOf(true, new Map())).toEqual({ timed: true })
    expect(remedyOf(false, new Map([["calculation-slip", 2], ["trap", 1]]))).toEqual({ timed: true })
    expect(remedyOf(false, new Map([["concept-gap", 2], ["wrong-approach", 2]]))).toEqual({ timed: false })
  })
})
