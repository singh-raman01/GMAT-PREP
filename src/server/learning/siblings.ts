import { SimilarDifficulty } from "../../api/difficulty.ts"
import { SufficiencyTopic } from "../../api/taxonomyRules.ts"
import { hashOrder, type PoolQuestion } from "../practice/selection.ts"

// Siblings (docs/design.md, "Learning loop"): the Questions a Retry Ladder's
// steps 2 and 3 serve in place of the one missed. A Sibling is unseen,
// outside the Mock Reserve, within 0.5 of the missed Question's Difficulty,
// of its Question Type, not about the same passage, and shares its primary
// Skill; failing that, it shares one of its secondary Skills other than the
// Data Sufficiency ones.

export interface SiblingTarget {
  readonly id: string
  readonly questionType: string
  readonly primarySkill: string | null
  readonly secondarySkills: ReadonlyArray<string>
  readonly difficulty: number
  // Its passage: a Question about the same one is no Sibling, as the
  // passage was read already.
  readonly stimulusId: string | null
}

export type SiblingMatch = "primary" | "secondary"

// Float slack, so a gap of exactly 0.5 counts as within it.
const Slack = 1e-9

const isSufficiency = (skill: string) => skill.startsWith(`${SufficiencyTopic}.`)

// The Sibling to serve, nearest in Difficulty first; the same salt gives the
// same pick among equals. Undefined when none is left.
export const pickSibling = (
  pool: ReadonlyArray<PoolQuestion>,
  unavailable: ReadonlySet<string>,
  target: SiblingTarget,
  salt: string
): { readonly id: string; readonly match: SiblingMatch } | undefined => {
  const gap = (question: PoolQuestion) => Math.abs(question.difficulty - target.difficulty)
  const fits = pool.filter((question) =>
    question.id !== target.id &&
    (target.stimulusId === null || question.stimulusId !== target.stimulusId) &&
    !unavailable.has(question.id) &&
    (question.reserve === false || question.released) &&
    question.questionType === target.questionType &&
    gap(question) <= SimilarDifficulty + Slack
  )
  const nearest = (candidates: ReadonlyArray<PoolQuestion>) =>
    hashOrder(candidates, salt).toSorted((a, b) => gap(a) - gap(b))[0]
  const primary = target.primarySkill === null
    ? undefined
    : nearest(fits.filter((question) => question.primarySkill === target.primarySkill))
  if (primary !== undefined) return { id: primary.id, match: "primary" }
  const shared = target.secondarySkills.filter((skill) => !isSufficiency(skill))
  const secondary = nearest(fits.filter((question) => question.secondarySkills.some((skill) => shared.includes(skill))))
  return secondary === undefined ? undefined : { id: secondary.id, match: "secondary" }
}
