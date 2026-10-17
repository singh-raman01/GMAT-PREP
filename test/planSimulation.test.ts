import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { dayNumber, dayOfNumber } from "../src/server/plans/build.ts"
import { problemsOf, simulate } from "./planSimulation.ts"

// The Study Plan over many builds, as a Learner lives it (decisions 83 to
// 89): the rules each single build keeps must hold across the sequence too.

const Monday = "2026-11-02"
const plus = (day: string, days: number) => dayOfNumber(dayNumber(day) + days)

describe("A Learner who follows the plan", () => {
  test("keeps Mock spacing, one event a day, one Mock a Mock week, no Section twice a week, and each day's minutes", () => {
    const problems: Array<string> = []
    for (const weeks of [3, 6, 9])
      for (const weeklyMinutes of [120, 300, 600, 1200])
        for (const daysOff of [[], [0], [0, 6], [1, 2, 3, 4, 5]])
          for (const allowed of [9, 2]) {
            const settings = { testDate: plus(Monday, weeks * 7 + 3), weeklyMinutes, daysOff }
            const result = simulate(settings, { start: Monday, allowed, rebuildEachItem: weeklyMinutes === 300 })
            for (const problem of problemsOf(settings, result, { allowed })) problems.push(`${JSON.stringify(settings)} ${problem}`)
          }
    expect(problems).toEqual([])
  }, 120_000)
})

describe("A Learner who strays from the plan", () => {
  test("never gets an event on a day one was taken, a Mock within 3 days of one taken, a second Mock in a Mock week, or more work than a day holds", () => {
    const found = new Map<string, string>()
    fc.assert(fc.property(
      fc.integer({ min: 22, max: 70 }),
      fc.constantFrom(120, 140, 150, 300, 600, 1200),
      fc.uniqueArray(fc.integer({ min: 0, max: 6 }), { maxLength: 4 }),
      fc.uniqueArray(fc.integer({ min: 0, max: 69 }), { maxLength: 8 }),
      fc.uniqueArray(fc.integer({ min: 0, max: 69 }), { maxLength: 3 }),
      fc.uniqueArray(fc.record({ day: fc.integer({ min: 0, max: 69 }), section: fc.constantFrom("quant", "verbal", "di") }), {
        maxLength: 4,
        selector: (each) => each.day
      }),
      fc.uniqueArray(fc.integer({ min: 0, max: 69 }), { maxLength: 10 }),
      fc.boolean(),
      fc.constantFrom("pending", "done", "skipped") as fc.Arbitrary<"pending" | "done" | "skipped">,
      (days, weeklyMinutes, daysOff, missed, mocks, sectionals, reversed, rebuildEachItem, diagnostic) => {
        const testDate = plus(Monday, days)
        const settings = { testDate, weeklyMinutes, daysOff }
        const result = simulate(settings, {
          start: Monday,
          allowed: 9,
          diagnostic,
          rebuildEachItem,
          missed: new Set(missed.map((each) => plus(Monday, each))),
          outsideMocks: new Set(mocks.map((each) => plus(Monday, each))),
          outside: new Map(sectionals.map((each) => [plus(Monday, each.day), each.section] as const)),
          reversed: new Set(reversed.map((each) => plus(Monday, each)))
        })
        const test = dayNumber(testDate)
        const weekOf = (day: number) => Math.floor((test - 1 - day) / 7)
        for (const { day, plan, takenCount } of result.plans) {
          const today = dayNumber(day)
          const takenBy = result.taken.slice(0, takenCount)
          const takenMocks = takenBy.filter((event) => event.kind === "mock").map((event) => dayNumber(event.day))
          for (const planDay of plan.days) {
            const n = dayNumber(planDay.day)
            for (const item of planDay.items) {
              if (item.kind === "mock") {
                if (takenMocks.some((other) => Math.abs(n - other) < 3)) found.set("a Mock within 3 days of one taken", `${JSON.stringify(settings)} built ${day}`)
                if (
                  !item.diagnostic && weeklyMinutes >= 145 &&
                  takenBy.some((event) => event.kind === "mock" && weekOf(dayNumber(event.day)) === weekOf(n) && weekOf(n) < 4)
                ) found.set("a second Mock in a Mock week", `${JSON.stringify(settings)} built ${day}`)
              }
              if ((item.kind === "mock" || item.kind === "sectional") && n === today && takenBy.some((event) => dayNumber(event.day) === today)) {
                found.set("an event today after one was taken", `${JSON.stringify(settings)} built ${day}`)
              }
            }
          }
        }
        // The work the plan gave a day fits it, with what was done outside
        // the plan; a day the plan gave nothing is the Learner's own.
        for (const record of result.days) {
          const isMockDay = record.done.some((each) => each.kind === "mock") || record.outsideMinutes >= 145
          const minutes = record.done.reduce((sum, each) => sum + each.minutes, 0) + record.outsideMinutes
          if (!isMockDay && record.done.length > 0 && minutes > record.allotted.at(-1)!) {
            found.set("a day over its minutes", `${JSON.stringify(settings)} ${record.day}: ${minutes} against ${record.allotted.join(" -> ")}`)
          }
        }
      }
    ), { numRuns: 150, seed: 16 })
    expect([...found.entries()]).toEqual([])
  }, 120_000)
})
