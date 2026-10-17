import { SectionalReport, SectionalResult } from "../../api/Sectionals.ts"
import { isCorrect, type PartKey, readSelection } from "../practice/history.ts"
import type { ScoreLine } from "../ratings/scale.ts"
import { editPoints, sectionScoreOf } from "./score.ts"

// A Section's report (docs/design.md, "Ratings and scores"). Its Questions'
// Difficulty is kept as it stood when the Section closed, but whether each
// answer is right is read against the current keys, so a Key Override
// re-scores it and marks it rescored.

export interface AnswerFact {
  readonly questionId: string
  readonly kind: string
  // Orders a Session's Responses.
  readonly seq: number
  readonly selection: string
}

export type Keys = ReadonlyMap<string, ReadonlyArray<PartKey>>

const right = (answer: AnswerFact | undefined, keys: ReadonlyArray<PartKey>) =>
  answer !== undefined && answer.kind !== "time-out" && isCorrect(readSelection(answer.selection), keys)

// Whether a served Question's final answer is right, and for one changed in
// Review & Edit, whether its first answer was. answers are the Session's, in
// order.
export const judge = (questionId: string, answers: ReadonlyArray<AnswerFact>, keys: Keys) => {
  const mine = answers.filter((answer) => answer.questionId === questionId)
  const key = keys.get(questionId) ?? []
  const final = right(mine.at(-1), key)
  const edited = mine.some((answer) => answer.kind === "edit")
  return { correct: final, change: edited ? { wasCorrect: right(mine[0], key), isCorrect: final } : null }
}

// The score, its range and the points Review & Edit made, from the results
// at their kept Difficulty, on the score line kept with them.
export const scored = (results: ReadonlyArray<SectionalResult>, unreached: number, line: ScoreLine) => {
  const finalAnswers = results.map((result) => ({ difficulty: result.difficulty, correct: result.correct }))
  const firstAnswers = results.map((result) => ({
    difficulty: result.difficulty,
    correct: result.change === null ? result.correct : result.change.wasCorrect
  }))
  const section = sectionScoreOf(finalAnswers, unreached, line)
  return {
    score: section.estimate.score,
    low: section.estimate.low,
    high: section.estimate.high,
    calibrated: section.estimate.calibrated,
    ability: section.fit.ability,
    standardError: section.fit.standardError,
    editPoints: editPoints(firstAnswers, finalAnswers, unreached, line)
  }
}

// The kept report as it reads now. When a key has changed since, every
// number that follows from it is worked out again and the report says so.
export const rescore = (
  report: SectionalReport,
  answers: ReadonlyArray<AnswerFact>,
  keys: Keys,
  line: ScoreLine
): SectionalReport => {
  const results = report.results.map((result) => {
    const now = judge(result.questionId, answers, keys)
    const same = now.correct === result.correct && now.change?.wasCorrect === result.change?.wasCorrect
    return same ? result : new SectionalResult({ ...result, ...now })
  })
  if (results.every((result, index) => result === report.results[index])) return report
  return new SectionalReport({ ...report, ...scored(results, report.unreached, line), results, rescored: true })
}
