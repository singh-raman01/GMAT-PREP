import { describe, expect, test } from "bun:test"
import type { PoolQuestion } from "../src/server/practice/selection.ts"
import { pickSibling, type SiblingTarget } from "../src/server/learning/siblings.ts"

const question = (id: string, changes: Partial<PoolQuestion> = {}): PoolQuestion => ({
  id,
  section: "quant",
  questionType: "quant.ps",
  primarySkill: "quant.algebra.linear-equations",
  secondarySkills: [],
  difficulty: 0,
  reserve: false,
  released: false,
  stimulusId: null,
  ...changes
})

const missed: SiblingTarget = {
  id: "missed",
  questionType: "quant.ps",
  primarySkill: "quant.algebra.linear-equations",
  secondarySkills: ["quant.word-problems.percents", "di.sufficiency.value"],
  difficulty: 0.2,
  stimulusId: null
}

describe("A Sibling", () => {
  test("is unseen, outside the Mock Reserve, within 0.5 of the Difficulty, of the Question Type and primary Skill, nearest first", () => {
    const pool = [
      question("missed", { difficulty: 0.2 }),
      question("seen", { difficulty: 0.2 }),
      question("reserve", { difficulty: 0.2, reserve: true }),
      question("undecided", { difficulty: 0.2, reserve: null }),
      question("far", { difficulty: 0.8 }),
      question("other-type", { difficulty: 0.2, questionType: "di.ds" }),
      question("edge", { difficulty: 0.7 }),
      question("near", { difficulty: 0.1 }),
      question("released", { difficulty: 0.2, reserve: true, released: true })
    ]
    expect(pickSibling(pool, new Set(["seen"]), missed, "salt")).toEqual({ id: "released", match: "primary" })
    expect(pickSibling(pool, new Set(["seen", "released"]), missed, "salt")).toEqual({ id: "near", match: "primary" })
    expect(pickSibling(pool, new Set(["seen", "released", "near"]), missed, "salt")).toEqual({ id: "edge", match: "primary" })
    expect(pickSibling(pool, new Set(["seen", "released", "near", "edge"]), missed, "salt")).toBeUndefined()
  })

  test("falls back to a shared secondary Skill other than the sufficiency ones", () => {
    const other = { primarySkill: "quant.number-properties.divisibility" }
    const pool = [
      question("sufficiency", { ...other, secondarySkills: ["di.sufficiency.value"] }),
      question("percents", { ...other, secondarySkills: ["quant.word-problems.percents"] })
    ]
    expect(pickSibling(pool, new Set(), missed, "salt")).toEqual({ id: "percents", match: "secondary" })
    expect(pickSibling(pool.slice(0, 1), new Set(), missed, "salt")).toBeUndefined()
  })

  test("is never about the passage the missed Question asks about", () => {
    const passage = { ...missed, stimulusId: "passage-1" }
    const pool = [question("mate", { difficulty: 0.2, stimulusId: "passage-1" }), question("other", { difficulty: 0.2, stimulusId: "passage-2" })]
    expect(pickSibling(pool, new Set(), passage, "salt")).toEqual({ id: "other", match: "primary" })
    expect(pickSibling(pool.slice(0, 1), new Set(), passage, "salt")).toBeUndefined()
  })
})
