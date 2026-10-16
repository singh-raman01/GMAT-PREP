import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { studyDayOf } from "../src/api/studyDay.ts"
import {
  fitAbility,
  nextDifficulty,
  probability,
  recencyWeight,
  scoreEstimate,
  sectionScore,
  type WeightedAnswer
} from "../src/server/ratings/model.ts"

const scale = fc.double({ min: -4, max: 4, noNaN: true })
const answer = fc.record({
  difficulty: scale,
  correct: fc.boolean(),
  weight: fc.double({ min: 0.01, max: 1, noNaN: true })
})
const answers = fc.array(answer, { maxLength: 60 })

// The slope of the log posterior at an Ability, under the N(0, 1) prior.
const slopeAt = (ability: number, given: ReadonlyArray<WeightedAnswer>) =>
  given.reduce((sum, each) => sum + each.weight * ((each.correct ? 1 : 0) - probability(ability, each.difficulty)), -ability)

describe("The rating model", () => {
  test("the chance of a right answer rises with Ability, falls with Difficulty, and is even when they match", () => {
    fc.assert(fc.property(scale, scale, fc.double({ min: 0.01, max: 2, noNaN: true }), (ability, difficulty, more) => {
      const p = probability(ability, difficulty)
      expect(p).toBeGreaterThan(0)
      expect(p).toBeLessThan(1)
      expect(probability(ability + more, difficulty)).toBeGreaterThan(p)
      expect(probability(ability, difficulty + more)).toBeLessThan(p)
      expect(probability(difficulty, difficulty)).toBeCloseTo(0.5, 12)
    }))
  })

  test("a right answer never makes a Question harder, a wrong one never easier, and each step shrinks with evidence", () => {
    fc.assert(fc.property(scale, scale, fc.integer({ min: 0, max: 500 }), (difficulty, ability, earlier) => {
      const right = nextDifficulty(difficulty, earlier, ability, true)
      const wrong = nextDifficulty(difficulty, earlier, ability, false)
      expect(right).toBeLessThanOrEqual(difficulty)
      expect(wrong).toBeGreaterThanOrEqual(difficulty)
      const k = 0.3 / Math.sqrt(1 + earlier)
      expect(Math.abs(right - difficulty)).toBeLessThanOrEqual(k)
      expect(Math.abs(wrong - difficulty)).toBeLessThanOrEqual(k)
      expect(Math.abs(nextDifficulty(difficulty, earlier + 1, ability, false) - difficulty))
        .toBeLessThanOrEqual(Math.abs(wrong - difficulty))
    }))
    // The worked case: K = 0.3 for a first Rated Response, expected 0.5.
    expect(nextDifficulty(0, 0, 0, false)).toBeCloseTo(0.15, 12)
    expect(nextDifficulty(0, 3, 0, true)).toBeCloseTo(-0.075, 12)
  })

  test("the fitted Ability is the peak of the posterior, and with no answers it is the prior", () => {
    fc.assert(fc.property(answers, (given) => {
      const fit = fitAbility(given)
      expect(Math.abs(slopeAt(fit.ability, given))).toBeLessThan(1e-6)
      // Information never falls below the prior's, so the error never exceeds its spread.
      expect(fit.standardError).toBeLessThanOrEqual(1)
      expect(fit.standardError).toBeGreaterThan(0)
    }))
    expect(fitAbility([])).toEqual({ ability: 0, standardError: 1 })
  })

  test("turning a wrong answer right never lowers the fitted Ability", () => {
    fc.assert(fc.property(answers, answer, (given, extra) => {
      const wrong = fitAbility([...given, { ...extra, correct: false }])
      const right = fitAbility([...given, { ...extra, correct: true }])
      expect(right.ability).toBeGreaterThanOrEqual(wrong.ability - 1e-9)
    }))
  })

  test("mirroring every answer mirrors the Ability, and an answer with no weight changes nothing", () => {
    fc.assert(fc.property(answers, answer, (given, extra) => {
      const fit = fitAbility(given)
      const mirrored = fitAbility(given.map((each) => ({ ...each, difficulty: -each.difficulty, correct: !each.correct })))
      expect(mirrored.ability).toBeCloseTo(-fit.ability, 6)
      expect(mirrored.standardError).toBeCloseTo(fit.standardError, 6)
      expect(fitAbility([...given, { ...extra, weight: 0 }]).ability).toBeCloseTo(fit.ability, 9)
    }))
  })

  test("recency halves a Response's weight every 30 Study Days", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 3650 }), (age) => {
      expect(recencyWeight(age + 30)).toBeCloseTo(recencyWeight(age) / 2, 12)
      expect(recencyWeight(age)).toBeLessThanOrEqual(1)
    }))
    expect(recencyWeight(0)).toBe(1)
  })

  test("a Section score is 75 + 5θ within 60 to 90, and its range holds it", () => {
    fc.assert(fc.property(
      fc.double({ min: -10, max: 10, noNaN: true }),
      fc.double({ min: 0.01, max: 1, noNaN: true }),
      (ability, standardError) => {
        const estimate = scoreEstimate({ ability, standardError })
        expect(estimate.score).toBeGreaterThanOrEqual(60)
        expect(estimate.score).toBeLessThanOrEqual(90)
        expect(estimate.low).toBeLessThanOrEqual(estimate.score)
        expect(estimate.high).toBeGreaterThanOrEqual(estimate.score)
        expect(estimate.calibrated).toBe(false)
        expect(sectionScore(ability + 0.5)).toBeGreaterThanOrEqual(sectionScore(ability))
      }
    ))
    expect(scoreEstimate({ ability: 1, standardError: 0.5 })).toEqual({ score: 80, low: 75, high: 85, calibrated: false })
  })
})

describe("Study Days", () => {
  test("a Study Day starts at the rollover hour in the Profile's time zone", () => {
    // 03:30 in Taipei on 16 October is still the Study Day of 15 October.
    const early = Date.UTC(2026, 9, 15, 19, 30)
    const late = Date.UTC(2026, 9, 15, 20, 30)
    expect(studyDayOf(late, "Asia/Taipei", 4) - studyDayOf(early, "Asia/Taipei", 4)).toBe(1)
    expect(studyDayOf(early, "Asia/Taipei", 4)).toBe(Date.UTC(2026, 9, 15) / 86_400_000)
    expect(studyDayOf(early, "Asia/Taipei", 0)).toBe(Date.UTC(2026, 9, 16) / 86_400_000)
  })

  test("a day that loses an hour to daylight saving is still one Study Day", () => {
    // New York moves its clocks from 02:00 to 03:00 on 8 March 2026.
    const before = Date.UTC(2026, 2, 8, 6, 30) // 01:30 EST, still 7 March's Study Day
    const after = Date.UTC(2026, 2, 8, 8, 30) // 04:30 EDT, two hours later
    expect(studyDayOf(after, "America/New_York", 4) - studyDayOf(before, "America/New_York", 4)).toBe(1)
    expect(studyDayOf(after - 60 * 60 * 1000, "America/New_York", 4)).toBe(studyDayOf(before, "America/New_York", 4))
  })
})
