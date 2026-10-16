// The rating model (docs/design.md, "Ratings and scores"). A Profile with
// Ability θ gets a Question of Difficulty b right with probability
// 1 / (1 + e^-(θ - b)). Every number here is derived from Responses and can
// be rebuilt (ADR 0005); these are starting values, not stored truths.

export const probability = (ability: number, difficulty: number) => 1 / (1 + Math.exp(difficulty - ability))

// After a Rated Response, b moves by K × (expected - actual), with
// K = 0.3 / sqrt(1 + n) for a Question with n earlier Rated Responses: a
// right answer makes it easier, a wrong one harder, by less as evidence
// builds up.
export const DifficultyStep = 0.3

export const nextDifficulty = (
  difficulty: number,
  earlierRated: number,
  ability: number,
  correct: boolean
): number => {
  const k = DifficultyStep / Math.sqrt(1 + Math.max(0, earlierRated))
  return difficulty + k * (probability(ability, difficulty) - (correct ? 1 : 0))
}

// Each Rated Response counts for less as it ages: half after 30 Study Days.
export const HalfLifeStudyDays = 30

export const recencyWeight = (ageInStudyDays: number) => 0.5 ** (Math.max(0, ageInStudyDays) / HalfLifeStudyDays)

export interface WeightedAnswer {
  // The Question's current Difficulty.
  readonly difficulty: number
  readonly correct: boolean
  readonly weight: number
}

export interface Prior {
  readonly mean: number
  readonly spread: number
}

export const SectionPrior: Prior = { mean: 0, spread: 1 }

export interface AbilityFit {
  readonly ability: number
  readonly standardError: number
}

// Steps of Newton's method are kept to this size, so an extreme start
// cannot overshoot.
const MaxStep = 2

// The maximum a posteriori Ability over weighted answers under a normal
// prior, with its standard error from the curvature at the peak. The log
// posterior is strictly concave, so the peak is unique.
export const fitAbility = (answers: ReadonlyArray<WeightedAnswer>, prior: Prior = SectionPrior): AbilityFit => {
  const precision = 1 / prior.spread ** 2
  const slopeAndInformation = (ability: number) => {
    let slope = -(ability - prior.mean) * precision
    let information = precision
    for (const answer of answers) {
      const p = probability(ability, answer.difficulty)
      slope += answer.weight * ((answer.correct ? 1 : 0) - p)
      information += answer.weight * p * (1 - p)
    }
    return { slope, information }
  }
  let ability = prior.mean
  for (let i = 0; i < 100; i++) {
    const { slope, information } = slopeAndInformation(ability)
    const step = Math.max(-MaxStep, Math.min(MaxStep, slope / information))
    ability += step
    if (Math.abs(step) < 1e-10) break
  }
  return { ability, standardError: 1 / Math.sqrt(slopeAndInformation(ability).information) }
}

// The uncalibrated Section score line: 75 + 5θ, rounded, within 60 to 90.
// The range comes from θ plus and minus 1.96 standard errors.
export const ScoreLine = { base: 75, slope: 5, lowest: 60, highest: 90 } as const
export const RangeWidth = 1.96

export const sectionScore = (ability: number) =>
  Math.min(ScoreLine.highest, Math.max(ScoreLine.lowest, Math.round(ScoreLine.base + ScoreLine.slope * ability)))

export interface ScoreEstimate {
  readonly score: number
  readonly low: number
  readonly high: number
  readonly calibrated: boolean
}

export const scoreEstimate = (fit: AbilityFit): ScoreEstimate => ({
  score: sectionScore(fit.ability),
  low: sectionScore(fit.ability - RangeWidth * fit.standardError),
  high: sectionScore(fit.ability + RangeWidth * fit.standardError),
  calibrated: false
})
