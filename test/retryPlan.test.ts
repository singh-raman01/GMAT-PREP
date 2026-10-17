import { describe, expect, test } from "bun:test"
import { type DueStep, planRetries } from "../src/server/learning/retryPlan.ts"
import type { PoolQuestion } from "../src/server/practice/selection.ts"

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

const due = (id: string, step: DueStep["step"], published = true): DueStep => ({
  step,
  target: {
    id,
    questionType: "quant.ps",
    primarySkill: "quant.algebra.linear-equations",
    secondarySkills: [],
    difficulty: 0,
    stimulusId: null
  },
  published
})

const context = (changes: Partial<Parameters<typeof planRetries>[1]> = {}) => ({
  held: new Set<string>(),
  seen: new Set(["e1", "e2", "e3"]),
  pool: ["e1", "e2", "e3", "s1", "s2"].map((id) => question(id)),
  resolve: (id: string) => id,
  salt: "salt",
  size: 20,
  ...changes
})

describe("A retry set's plan", () => {
  test("serves step 1 with the entry's own Question, and waits while a running Section holds it", () => {
    expect(planRetries([due("e1", 1), due("e2", 1)], context())).toEqual({
      items: [{ entry: "e1", step: 1, questionId: "e1" }, { entry: "e2", step: 1, questionId: "e2" }],
      skipped: [],
      waiting: []
    })
    const merged = planRetries([due("old", 1)], context({ held: new Set(["e1"]), resolve: (id) => (id === "old" ? "e1" : id) }))
    expect(merged).toEqual({ items: [], skipped: [], waiting: [due("old", 1)] })
  })

  test("gives each Sibling step an unseen Sibling no other step in the set has, and skips one with none left", () => {
    const plan = planRetries([due("e1", 2), due("e2", 3), due("e3", 2)], context())
    expect(plan.items.map((item) => item.entry)).toEqual(["e1", "e2"])
    expect(new Set(plan.items.map((item) => item.questionId))).toEqual(new Set(["s1", "s2"]))
    expect(plan.skipped).toEqual([due("e3", 2)])
  })

  test("never picks a Sibling a running Section holds", () => {
    const plan = planRetries([due("e1", 2)], context({ held: new Set(["s1"]) }))
    expect(plan.items).toEqual([{ entry: "e1", step: 2, questionId: "s2" }])
  })

  test("waits on a step 1 whose Question is out of the Question Bank, and stops at the set's size", () => {
    expect(planRetries([due("e1", 1, false), due("e2", 1)], context())).toEqual({
      items: [{ entry: "e2", step: 1, questionId: "e2" }],
      skipped: [],
      waiting: [due("e1", 1, false)]
    })
    const capped = planRetries([due("e1", 1), due("e2", 1), due("e3", 2)], context({ size: 2 }))
    expect([capped.items.map((item) => item.entry), capped.skipped]).toEqual([["e1", "e2"], []])
  })
})
