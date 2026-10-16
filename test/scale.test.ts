import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import {
  calibratedLine,
  lineScore,
  sectionEstimateOn,
  totalEstimate,
  totalScore,
  UncalibratedLine
} from "../src/server/ratings/scale.ts"

describe("The Total", () => {
  test("is 205 + (Q + V + DI - 180) × 20/3, rounded to the nearest value ending in 5", () => {
    expect(totalScore([81, 84, 82])).toBe(655)
    expect(totalScore([84, 87, 81])).toBe(685)
    expect(totalScore([60, 60, 60])).toBe(205)
    expect(totalScore([90, 90, 90])).toBe(805)
  })

  test("always ends in 5, stays on the scale, and never falls as a Section score rises", () => {
    const score = fc.integer({ min: 60, max: 90 })
    fc.assert(fc.property(score, score, score, (q, v, di) => {
      const total = totalScore([q, v, di])
      expect(total % 10).toBe(5)
      expect(total).toBeGreaterThanOrEqual(205)
      expect(total).toBeLessThanOrEqual(805)
      if (q < 90) expect(totalScore([q + 1, v, di])).toBeGreaterThanOrEqual(total)
    }))
  })

  test("its range is ± 1.96 × 20/3 × √Σ(slope × standard error)², rounded outward to values ending in 5", () => {
    const part = (score: number, standardError: number) => ({ score, standardError, line: UncalibratedLine })
    // 1.96 × 20/3 × √(3 × (5 × 0.3)²) = 33.9..., around a raw Total of 651.7.
    const estimate = totalEstimate([part(81, 0.3), part(84, 0.3), part(82, 0.3)])
    expect(estimate).toEqual({ score: 655, low: 615, high: 695, calibrated: false })
    // Kept within the scale.
    expect(totalEstimate([part(90, 1), part(90, 1), part(90, 1)])).toMatchObject({ high: 805 })
    expect(totalEstimate([part(60, 1), part(60, 1), part(60, 1)])).toMatchObject({ low: 205 })
    // A range holds its Total.
    fc.assert(fc.property(
      fc.integer({ min: 60, max: 90 }),
      fc.integer({ min: 60, max: 90 }),
      fc.integer({ min: 60, max: 90 }),
      fc.double({ min: 0, max: 2, noNaN: true }),
      (q, v, di, error) => {
        const range = totalEstimate([part(q, error), part(v, error), part(di, error)])
        expect(range.low).toBeLessThanOrEqual(range.score)
        expect(range.high).toBeGreaterThanOrEqual(range.score)
        expect(range.low % 10).toBe(5)
        expect(range.high % 10).toBe(5)
      }
    ))
  })
})

describe("Calibration by Official Scores", () => {
  test("none leaves the line uncalibrated: Easy (-1) is 70, Medium 75 and Hard (+1) 80", () => {
    const line = calibratedLine([])
    expect(line).toEqual(UncalibratedLine)
    expect([-1, 0, 1].map((ability) => lineScore(line, ability))).toEqual([70, 75, 80])
    expect(sectionEstimateOn(line, { ability: 0, standardError: 0.5 })).toEqual({
      score: 75,
      low: 70,
      high: 80,
      calibrated: false
    })
  })

  test("one shifts the line to match it, and two or more fit slope and offset by least squares", () => {
    const one = calibratedLine([{ ability: 0.4, score: 80 }])
    expect(one).toMatchObject({ slope: 5, calibrated: true })
    expect(lineScore(one, 0.4)).toBe(80)
    // Points on a line of slope 6 through (0, 74).
    const two = calibratedLine([{ ability: -1, score: 68 }, { ability: 1, score: 80 }, { ability: 0, score: 74 }])
    expect(two.slope).toBeCloseTo(6, 10)
    expect(two.offset).toBeCloseTo(74, 10)
    expect(two.calibrated).toBe(true)
  })

  test("points that fit no rising line, or the same Ability twice, keep the uncalibrated slope and shift it", () => {
    const falling = calibratedLine([{ ability: -1, score: 80 }, { ability: 1, score: 70 }])
    expect(falling).toMatchObject({ slope: 5, offset: 75, calibrated: true })
    const same = calibratedLine([{ ability: 0.2, score: 76 }, { ability: 0.2, score: 80 }])
    expect(same).toMatchObject({ slope: 5, offset: 77, calibrated: true })
  })
})
