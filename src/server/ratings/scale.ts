import { type AbilityFit, RangeWidth, ScoreLine as Uncalibrated } from "./model.ts"

// The score scale (docs/design.md, "Ratings and scores"): a Section score is
// a line in Section Ability, uncalibrated until the Learner enters an
// Official Score, and the Total combines the three Section scores.

export interface ScoreLine {
  readonly offset: number
  // Points per unit of Ability.
  readonly slope: number
  readonly calibrated: boolean
}

// Before any Official Score: 75 + 5θ, so Easy (-1) is 70, Medium (0) 75 and
// Hard (+1) 80.
export const UncalibratedLine: ScoreLine = { offset: Uncalibrated.base, slope: Uncalibrated.slope, calibrated: false }

export const SectionScoreRange = { lowest: Uncalibrated.lowest, highest: Uncalibrated.highest } as const
export const TotalScoreRange = { lowest: 205, highest: 805 } as const

const within = (value: number, range: { readonly lowest: number; readonly highest: number }) =>
  Math.min(range.highest, Math.max(range.lowest, value))

// Official Scores whose Abilities lie closer together than this say nothing
// about the slope, so the line keeps the uncalibrated slope and fits only its
// offset. The same holds for points that fit no rising line.
export const MinimumAbilitySpread = 0.5

// A fitted slope stays within half to twice the uncalibrated one, so a few
// noisy Official Scores cannot stretch the scale.
export const SlopeRange = { lowest: Uncalibrated.slope / 2, highest: Uncalibrated.slope * 2 } as const

// The line Official Scores give: none leaves it uncalibrated, one shifts it to
// match, and two or more fit slope and offset by least squares, within the
// limits above. Each point pairs the Section Ability as it stood on the
// Official Score's date with the Section score it gave.
export const calibratedLine = (points: ReadonlyArray<{ readonly ability: number; readonly score: number }>): ScoreLine => {
  if (points.length === 0) return UncalibratedLine
  const meanAbility = points.reduce((sum, point) => sum + point.ability, 0) / points.length
  const meanScore = points.reduce((sum, point) => sum + point.score, 0) / points.length
  const through = (slope: number): ScoreLine => ({ offset: meanScore - slope * meanAbility, slope, calibrated: true })
  const abilities = points.map((point) => point.ability)
  if (Math.max(...abilities) - Math.min(...abilities) < MinimumAbilitySpread) return through(UncalibratedLine.slope)
  const spread = points.reduce((sum, point) => sum + (point.ability - meanAbility) ** 2, 0)
  const fitted = points.reduce((sum, point) => sum + (point.ability - meanAbility) * (point.score - meanScore), 0) / spread
  if (!(fitted > 0)) return through(UncalibratedLine.slope)
  return through(Math.min(SlopeRange.highest, Math.max(SlopeRange.lowest, fitted)))
}

export const lineScore = (line: ScoreLine, ability: number) =>
  within(Math.round(line.offset + line.slope * ability), SectionScoreRange)

export interface SectionScoreEstimate {
  readonly score: number
  readonly low: number
  readonly high: number
  readonly calibrated: boolean
}

// A Section's score with its 95% range, from an Ability fit.
export const sectionEstimateOn = (line: ScoreLine, fit: AbilityFit): SectionScoreEstimate => ({
  score: lineScore(line, fit.ability),
  low: lineScore(line, fit.ability - RangeWidth * fit.standardError),
  high: lineScore(line, fit.ability + RangeWidth * fit.standardError),
  calibrated: line.calibrated
})

// 205 + (Q + V + DI - 180) × 20/3: not official, but it reproduces the
// published examples and both ends of the scale.
const rawTotal = (scores: readonly [number, number, number]) => 205 + (scores[0] + scores[1] + scores[2] - 180) * 20 / 3

// To values that end in 5: the nearest, or outward for a range.
const nearestFive = (value: number) => Math.round((value - 5) / 10) * 10 + 5
const fiveBelow = (value: number) => Math.floor((value - 5) / 10 + 1e-9) * 10 + 5
const fiveAbove = (value: number) => Math.ceil((value - 5) / 10 - 1e-9) * 10 + 5

// The Total from the three Section scores, rounded to the nearest value
// ending in 5. The rounding never ties, since a tie would need
// (Q + V + DI - 180) × 4 to be odd.
export const totalScore = (scores: readonly [number, number, number]) => within(nearestFive(rawTotal(scores)), TotalScoreRange)

// The Section target of a target Total (decision 82): the lowest Section
// score that, given to all three Sections, reaches it.
export const sectionTargetOf = (total: number): number => {
  for (let score: number = SectionScoreRange.lowest; score <= SectionScoreRange.highest; score += 1) {
    if (totalScore([score, score, score]) >= total) return score
  }
  return SectionScoreRange.highest
}

export interface TotalEstimate {
  readonly score: number
  readonly low: number
  readonly high: number
  readonly calibrated: boolean
}

// The Total with its range: plus or minus 1.96 × 20/3 × the square root of
// the sum over Sections of (slope × standard error) squared, rounded outward
// to values ending in 5 and kept within 205 to 805. It is calibrated only
// when every Section is.
export const totalEstimate = (
  sections: readonly [SectionPart, SectionPart, SectionPart]
): TotalEstimate => {
  const scores = sections.map((section) => section.score) as unknown as readonly [number, number, number]
  const raw = rawTotal(scores)
  const half = RangeWidth * 20 / 3 *
    Math.sqrt(sections.reduce((sum, section) => sum + (section.line.slope * section.standardError) ** 2, 0))
  return {
    score: totalScore(scores),
    low: within(fiveBelow(raw - half), TotalScoreRange),
    high: within(fiveAbove(raw + half), TotalScoreRange),
    calibrated: sections.every((section) => section.line.calibrated)
  }
}

export interface SectionPart {
  readonly score: number
  readonly standardError: number
  readonly line: ScoreLine
}
