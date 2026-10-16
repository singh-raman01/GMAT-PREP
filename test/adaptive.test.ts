import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { type Blueprint, DefaultBlueprint, type GroupId, groupCount } from "../src/api/blueprint.ts"
import {
  nextUnit,
  openSlots,
  PickAmong,
  sectionEstimate,
  sectionStock,
  seededRandom,
  type ServedUnit,
  type Tier,
  type Unit
} from "../src/server/sections/adaptive.ts"
import { editPoints, sectionFitOf, sectionScoreOf } from "../src/server/sections/score.ts"

let made = 0
const unit = (group: GroupId, settings: Partial<Omit<Unit, "group">> & { readonly size?: number } = {}): Unit => {
  made += 1
  const id = settings.id ?? `${group}-${made}`
  return {
    id,
    group,
    questionIds: settings.questionIds ?? Array.from({ length: settings.size ?? 1 }, (_, i) => `${id}.${i + 1}`),
    difficulty: settings.difficulty ?? 0,
    reserve: settings.reserve ?? true,
    lastSeenAt: settings.lastSeenAt ?? null
  }
}

const first = () => 0

// Serves a whole Section: picks a unit, records it, and goes on until
// nothing more can be served.
const runSection = (
  section: string,
  pool: ReadonlyArray<Unit>,
  options: { readonly blueprint?: Blueprint; readonly estimate?: number; readonly random?: () => number } = {}
) => {
  const served: Array<ServedUnit & { readonly tier: Tier }> = []
  let passed = {}
  for (let i = 0; i < 100; i++) {
    const step = nextUnit({
      blueprint: options.blueprint ?? DefaultBlueprint,
      section,
      pool,
      served,
      passed,
      estimate: options.estimate ?? 0,
      random: options.random ?? first
    })
    passed = step.passed
    if (step.pick === undefined) break
    served.push({
      unitId: step.pick.unit.id,
      group: step.pick.unit.group,
      size: step.pick.unit.questionIds.length,
      slot: step.pick.slot,
      tier: step.pick.tier
    })
  }
  return { served, passed }
}

const questionsBy = (served: ReadonlyArray<ServedUnit>) => {
  const counts: Partial<Record<GroupId, number>> = {}
  for (const each of served) counts[each.group] = (counts[each.group] ?? 0) + each.size
  return counts
}

describe("Choosing the next unit", () => {
  test("tiers go unseen Reserve near the estimate, unseen near, unseen far with the Reserve first, then Seen longest ago", () => {
    const pool = [
      unit("ps", { id: "seen-old", lastSeenAt: 100, difficulty: 0 }),
      unit("ps", { id: "seen-new", lastSeenAt: 500, difficulty: 0 }),
      unit("ps", { id: "far", reserve: false, difficulty: 2 }),
      unit("ps", { id: "reserve-far", difficulty: -2 }),
      unit("ps", { id: "near", reserve: false, difficulty: 0.4 }),
      unit("ps", { id: "reserve-near", difficulty: -0.5 })
    ]
    const { served } = runSection("quant", pool)
    expect(served.map((each) => [each.unitId, each.tier])).toEqual([
      ["reserve-near", "reserve-near"],
      ["near", "near"],
      ["reserve-far", "reserve-far"],
      ["far", "far"],
      ["seen-old", "seen"],
      ["seen-new", "seen"]
    ])
  })

  test("the pick is one of the five closest to the estimate in its tier", () => {
    fc.assert(fc.property(
      fc.array(fc.double({ min: -0.5, max: 0.5, noNaN: true }), { minLength: 1, maxLength: 20 }),
      fc.double({ min: -0.5, max: 0.5, noNaN: true }),
      fc.double({ min: 0, max: 0.999999, noNaN: true }),
      (difficulties, estimate, roll) => {
        const pool = difficulties.map((difficulty, i) => unit("ps", { id: `q${String(i).padStart(2, "0")}`, difficulty: difficulty * 0.999 }))
          .filter((each) => Math.abs(each.difficulty - estimate) <= 0.5)
        const step = nextUnit({ blueprint: DefaultBlueprint, section: "quant", pool, served: [], passed: {}, estimate, random: () => roll })
        if (pool.length === 0) return
        const closest = pool.toSorted((a, b) =>
          Math.abs(a.difficulty - estimate) - Math.abs(b.difficulty - estimate) || a.id.localeCompare(b.id)
        ).slice(0, PickAmong)
        expect(closest.map((each) => each.id)).toContain(step.pick!.unit.id)
        expect(step.pick!.tier).toBe("reserve-near")
      }
    ))
  })

  test("a passage serves only a slot of its size, and one too big for every slot is never served", () => {
    const pool = [
      unit("rc", { id: "five", size: 5 }),
      ...["a", "b", "c", "d", "e"].map((id) => unit("rc", { id: `three-${id}`, size: 3 })),
      unit("rc", { id: "four", size: 4 }),
      unit("rc", { id: "four-again", size: 4 }),
      ...Array.from({ length: 12 }, () => unit("cr"))
    ]
    const { served } = runSection("verbal", pool)
    const passages = served.filter((each) => each.group === "rc")
    expect(passages.map((each) => each.size).toSorted()).toEqual([3, 3, 3, 4])
    expect(passages.some((each) => each.unitId === "five")).toBe(false)
    expect(questionsBy(served)).toEqual({ rc: 13, cr: 10 })
  })

  test("slots no unit can fill pass to the Section's other groups", () => {
    // No passage of four: its slot goes to Critical Reasoning.
    const verbal = runSection("verbal", [
      ...Array.from({ length: 4 }, () => unit("rc", { size: 3 })),
      ...Array.from({ length: 20 }, () => unit("cr"))
    ])
    expect(questionsBy(verbal.served)).toEqual({ rc: 9, cr: 14 })
    expect(verbal.passed).toEqual({ rc: 4 })
    // No MSR set: its three slots go to the other Data Insights groups.
    const di = runSection("di", [
      ...Array.from({ length: 10 }, () => unit("ds")),
      ...Array.from({ length: 5 }, () => unit("ta")),
      ...Array.from({ length: 5 }, () => unit("gi")),
      ...Array.from({ length: 5 }, () => unit("tpa"))
    ])
    expect(Object.values(questionsBy(di.served)).reduce((sum, count) => sum + (count ?? 0), 0)).toBe(20)
    expect(questionsBy(di.served).msr).toBeUndefined()
    expect(di.passed).toEqual({ msr: 3 })
  })

  test("with enough units, each group gets its Blueprint count and the Section its total", () => {
    fc.assert(fc.property(
      fc.array(fc.double({ min: -2, max: 2, noNaN: true }), { minLength: 60, maxLength: 60 }),
      fc.integer({ min: 0, max: 1_000_000 }),
      fc.double({ min: -1.5, max: 1.5, noNaN: true }),
      (difficulties, seed, estimate) => {
        let i = 0
        const next = () => difficulties[i++ % difficulties.length]!
        const pool = [
          ...Array.from({ length: 12 }, () => unit("ds", { difficulty: next(), reserve: i % 2 === 0 })),
          ...Array.from({ length: 3 }, () => unit("msr", { size: 3, difficulty: next() })),
          ...Array.from({ length: 6 }, () => unit("ta", { difficulty: next(), lastSeenAt: i % 3 === 0 ? i : null })),
          ...Array.from({ length: 6 }, () => unit("gi", { difficulty: next() })),
          ...Array.from({ length: 6 }, () => unit("tpa", { difficulty: next(), reserve: false }))
        ]
        const { served } = runSection("di", pool, { estimate, random: seededRandom(String(seed)) })
        expect(questionsBy(served)).toEqual({ ds: 7, msr: 3, ta: 3, gi: 4, tpa: 3 })
        expect(new Set(served.map((each) => each.unitId)).size).toBe(served.length)
      }
    ), { numRuns: 50 })
  })

  test("a Curator's Blueprint sets the counts", () => {
    const blueprint = { ...DefaultBlueprint, cr: 4, rc: [3, 3] }
    const { served } = runSection("verbal", [
      ...Array.from({ length: 5 }, () => unit("rc", { size: 3 })),
      ...Array.from({ length: 10 }, () => unit("cr"))
    ], { blueprint })
    expect(questionsBy(served)).toEqual({ rc: 6, cr: 4 })
  })

  test("the open slots leave out what was served and what was passed on", () => {
    const served: ReadonlyArray<ServedUnit> = [
      { unitId: "p1", group: "rc", size: 4, slot: "own" },
      { unitId: "c1", group: "cr", size: 1, slot: "passed" }
    ]
    const open = openSlots(DefaultBlueprint, "verbal", served, { rc: 0 })
    expect(open.own.get("rc")).toEqual([3, 3, 3])
    expect(open.own.get("cr")).toHaveLength(10)
    expect(open.passed).toBe(0)
    const passing = openSlots(DefaultBlueprint, "verbal", served, { rc: 9 })
    expect(passing.own.get("rc")).toEqual([])
    expect(passing.passed).toBe(8)
  })
})

describe("The Section's estimate", () => {
  test("starts at Medium and moves up with right answers and down with wrong ones", () => {
    expect(sectionEstimate([])).toBe(0)
    const right = sectionEstimate([{ difficulty: 0, correct: true }])
    const wrong = sectionEstimate([{ difficulty: 0, correct: false }])
    expect(right).toBeGreaterThan(0)
    expect(wrong).toBeLessThan(0)
    expect(sectionEstimate([{ difficulty: 0, correct: true }, { difficulty: 1, correct: true }])).toBeGreaterThan(right)
  })

  test("the same seed gives the same picks", () => {
    const a = seededRandom("session-1:3")
    const b = seededRandom("session-1:3")
    const rolls = Array.from({ length: 5 }, () => a())
    expect(Array.from({ length: 5 }, () => b())).toEqual(rolls)
    expect(rolls.every((roll) => roll >= 0 && roll < 1)).toBe(true)
    expect(seededRandom("session-1:4")()).not.toBe(rolls[0])
  })
})

describe("The start check's counts", () => {
  test("count unseen Reserve Questions in units that fit a slot, by band, against twice the Blueprint count", () => {
    const stock = sectionStock(DefaultBlueprint, "verbal", [
      unit("rc", { size: 3, difficulty: -1 }),
      unit("rc", { size: 4, difficulty: 1 }),
      unit("rc", { size: 5 }),
      unit("rc", { size: 3, lastSeenAt: 10 }),
      unit("rc", { size: 3, reserve: false }),
      ...Array.from({ length: 21 }, (_, i) => unit("cr", { difficulty: i < 7 ? -1 : i < 14 ? 0 : 1 }))
    ])
    expect(stock).toEqual([
      { group: "rc", needed: 26, unseen: 7, byBand: { easy: 3, medium: 0, hard: 4 } },
      { group: "cr", needed: 20, unseen: 21, byBand: { easy: 7, medium: 7, hard: 7 } }
    ])
    expect(groupCount(DefaultBlueprint, "rc") * 2).toBe(26)
  })
})

describe("A Section's score", () => {
  test("a time-out and each unreached slot count as wrong", () => {
    const answered = [{ difficulty: 0, correct: true }, { difficulty: 0.5, correct: true }]
    const all = sectionFitOf(answered, 0).ability
    const timedOut = sectionFitOf([...answered, { difficulty: 1, correct: false }], 0).ability
    const unreached = sectionFitOf(answered, 3).ability
    expect(timedOut).toBeLessThan(all)
    expect(unreached).toBeLessThan(all)
    // Unreached slots are wrong at the last Question's Difficulty.
    expect(unreached).toBeCloseTo(
      sectionFitOf([...answered, ...Array.from({ length: 3 }, () => ({ difficulty: 0.5, correct: false }))], 0).ability,
      10
    )
    expect(sectionScoreOf(answered, 0).estimate.score).toBeGreaterThanOrEqual(75)
  })

  test("Review & Edit's points are the final score less the score from the first answers", () => {
    const firstAnswers = Array.from({ length: 10 }, (_, i) => ({ difficulty: 0, correct: i < 5 }))
    const fixed = firstAnswers.map((answer, i) => (i === 5 || i === 6 ? { ...answer, correct: true } : answer))
    const broken = firstAnswers.map((answer, i) => (i === 0 ? { ...answer, correct: false } : answer))
    expect(editPoints(firstAnswers, fixed, 0)).toBeGreaterThan(0)
    expect(editPoints(firstAnswers, broken, 0)).toBeLessThanOrEqual(0)
    expect(editPoints(firstAnswers, firstAnswers, 0)).toBe(0)
  })
})
