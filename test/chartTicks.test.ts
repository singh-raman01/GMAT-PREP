import { describe, expect, test } from "bun:test"
import { DaySteps, labelledColumns, QuestionSteps, ticksAcross, ticksUpTo } from "../web/src/charts/ticks.ts"

describe("Chart ticks", () => {
  test("question numbers step evenly from the first", () => {
    expect(ticksAcross([1, 7], 6, QuestionSteps)).toEqual([1, 3, 5, 7])
    expect(ticksAcross([1, 21], 6, QuestionSteps)).toEqual([1, 6, 11, 16, 21])
    expect(ticksAcross([1, 23], 6, QuestionSteps)).toEqual([1, 6, 11, 16, 21])
    expect(ticksAcross([1, 2], 6, QuestionSteps)).toEqual([1, 2])
    expect(ticksAcross([1, 21], 3, QuestionSteps)).toEqual([1, 11, 21])
  })

  test("days step by weeks, with the last day when it sits half a step past the last", () => {
    expect(ticksAcross([0, 27], 6, DaySteps)).toEqual([0, 7, 14, 21, 27])
    expect(ticksAcross([0, 27], 3, DaySteps)).toEqual([0, 14, 27])
    expect(ticksAcross([0, 22], 6, DaySteps)).toEqual([0, 7, 14, 21])
    expect(ticksAcross([0, 3], 6, DaySteps)).toEqual([0, 1, 2, 3])
    expect(ticksAcross([5, 5], 6, DaySteps)).toEqual([5])
  })

  test("a span past every step still keeps near the count", () => {
    expect(ticksAcross([0, 1000], 6, DaySteps)).toEqual([0, 364, 728, 1000])
    expect(ticksAcross([0, 5000], 3, DaySteps)).toEqual([0, 2500, 5000])
  })

  test("columns are labelled evenly back from the last", () => {
    expect([...labelledColumns(28, 8)].toSorted((a, b) => a - b)).toEqual([3, 7, 11, 15, 19, 23, 27])
    expect([...labelledColumns(28, 4)].toSorted((a, b) => a - b)).toEqual([6, 13, 20, 27])
    expect([...labelledColumns(3, 8)].toSorted((a, b) => a - b)).toEqual([0, 1, 2])
  })

  test("a count's axis ends on a whole step at or past the largest value", () => {
    expect(ticksUpTo(38, [15, 30, 60], 5)).toEqual([0, 15, 30, 45])
    expect(ticksUpTo(30, [15, 30, 60], 5)).toEqual([0, 15, 30])
    expect(ticksUpTo(200, [15, 30, 60, 120], 5)).toEqual([0, 60, 120, 180, 240])
    expect(ticksUpTo(0, [15, 30], 5)).toEqual([0, 15])
  })
})
