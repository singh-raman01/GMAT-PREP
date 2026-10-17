import { type AbilityFit, fitAbility, SectionPrior } from "../ratings/model.ts"
import { type ScoreLine, sectionEstimateOn, type SectionScoreEstimate, UncalibratedLine } from "../ratings/scale.ts"

// A Mock or Sectional Section's score (docs/design.md, "Ratings and scores"):
// fitted from the Section's final Responses alone, with prior mean 0 and
// spread 1, each at its Question's Difficulty when the Section closed. A
// time-out is wrong at its own Difficulty, and each slot the Section never
// reached is wrong at the Difficulty of the last Question served.

export interface FinalAnswer {
  readonly difficulty: number
  // Right against the key; a time-out never is.
  readonly correct: boolean
}

export const sectionFitOf = (answers: ReadonlyArray<FinalAnswer>, unreached: number): AbilityFit => {
  const last = answers.at(-1)?.difficulty ?? 0
  const missed = Array.from({ length: Math.max(0, unreached) }, () => ({ difficulty: last, correct: false }))
  return fitAbility([...answers, ...missed].map((answer) => ({ ...answer, weight: 1 })), SectionPrior)
}

export interface SectionScore {
  readonly fit: AbilityFit
  readonly estimate: SectionScoreEstimate
}

// On the Profile's score line for the Section, uncalibrated until an
// Official Score calibrates it.
export const sectionScoreOf = (
  answers: ReadonlyArray<FinalAnswer>,
  unreached: number,
  line: ScoreLine = UncalibratedLine
): SectionScore => {
  const fit = sectionFitOf(answers, unreached)
  return { fit, estimate: sectionEstimateOn(line, fit) }
}

// What Review & Edit changed in points: the score from the final answers
// less the score had each Question kept its first answer.
export const editPoints = (
  first: ReadonlyArray<FinalAnswer>,
  final: ReadonlyArray<FinalAnswer>,
  unreached: number,
  line: ScoreLine = UncalibratedLine
): number => sectionScoreOf(final, unreached, line).estimate.score - sectionScoreOf(first, unreached, line).estimate.score
