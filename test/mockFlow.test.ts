import { describe, expect, test } from "bun:test"
import {
  afterSection,
  BreakMs,
  breakLeftMs,
  KeepBreakMs,
  keepsBreak,
  NewMock,
  nextSection
} from "../src/server/sections/mockFlow.ts"

describe("A Mock's break", () => {
  test("begins as Section 1 closes and, when it runs its course, leaves Section 3 to follow Section 2 at once", () => {
    const resting = afterSection(NewMock, 1000)
    expect(resting).toMatchObject({ stage: "break", breakStartedAt: 1000, started: 1 })
    expect(breakLeftMs(resting, 1000 + 4 * 60_000)).toBe(6 * 60_000)
    const second = nextSection(resting, 1000 + BreakMs)
    expect(second).toEqual({ started: 2, breakAfter: 1, breakStartedAt: null, stage: "section" })
    const third = afterSection(second, 2_000_000)
    expect(third).toEqual({ started: 3, breakAfter: 1, breakStartedAt: null, stage: "section" })
    expect(afterSection(third, 3_000_000).stage).toBe("finished")
  })

  test("going on in its first minute keeps it for after Section 2; later, going on ends it early", () => {
    const resting = afterSection(NewMock, 0)
    expect(keepsBreak(resting, KeepBreakMs - 1)).toBe(true)
    const kept = nextSection(resting, KeepBreakMs - 1)
    expect(kept).toMatchObject({ started: 2, breakAfter: null })
    const offered = afterSection(kept, 900_000)
    expect(offered).toMatchObject({ stage: "break", breakStartedAt: 900_000, started: 2 })
    // After Section 2 there is no later, so going on at once uses it.
    expect(keepsBreak(offered, 900_000)).toBe(false)
    expect(nextSection(offered, 900_000)).toMatchObject({ started: 3, breakAfter: 2 })

    expect(keepsBreak(resting, KeepBreakMs)).toBe(false)
    expect(nextSection(resting, KeepBreakMs)).toMatchObject({ started: 2, breakAfter: 1 })
  })
})
