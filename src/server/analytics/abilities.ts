import { type AbilityFit, fitAbility } from "../ratings/model.ts"

// Skill and Question Type Abilities (docs/design.md, "Ratings and scores"):
// the same fit as a Section's, over the Rated Responses carrying the Skill
// or of the Question Type, with the prior centred on the reference Ability.

export interface RatedFact {
  readonly section: string
  readonly questionType: string
  readonly primarySkill: string | null
  readonly secondarySkills: ReadonlyArray<string>
  // The Question's current Difficulty.
  readonly difficulty: number
  readonly correct: boolean
  // How much its age leaves it: 1 today, half after 30 Study Days.
  readonly recency: number
  // The first Response's time over the Question's own Target Time.
  readonly pace: number
}

// Under this many Rated Responses, a Skill or Question Type shows "not
// enough data".
export const EnoughEvidence = 8
// A secondary Skill's Rated Responses count for half.
export const SecondaryWeight = 0.5
// Slow: the median pace of the correct Rated Responses is over this.
export const SlowPace = 1.3
export const ScopePriorSpread = 1

export type ScopeKind = "skill" | "questionType"

export interface ScopeAbility {
  readonly kind: ScopeKind
  readonly id: string
  // Rated Responses carrying it, at any weight.
  readonly evidence: number
  readonly enough: boolean
  readonly fit: AbilityFit
  readonly reference: number
  // The reference Ability less the Ability: above 0, it lags its Section.
  readonly gap: number
  // The median pace of its correct Rated Responses; null with none.
  readonly pace: number | null
  readonly slow: boolean
  // The Sections its Rated Responses came from, the most weight first.
  readonly sections: ReadonlyArray<string>
}

export const scopeKey = (kind: ScopeKind, id: string) => `${kind}:${id}`

const median = (values: ReadonlyArray<number>) => {
  if (values.length === 0) return null
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

// Every Skill and Question Type the Rated Responses carry. A Section with no
// Ability yet counts as 0, the prior's centre.
export const scopeAbilities = (
  facts: ReadonlyArray<RatedFact>,
  sectionAbility: ReadonlyMap<string, number>
): ReadonlyArray<ScopeAbility> => {
  const scopes = new Map<string, { kind: ScopeKind; id: string; carried: Array<{ fact: RatedFact; role: number }> }>()
  const carry = (kind: ScopeKind, id: string, fact: RatedFact, role: number) => {
    const key = scopeKey(kind, id)
    const found = scopes.get(key) ?? { kind, id, carried: [] }
    found.carried.push({ fact, role })
    scopes.set(key, found)
  }
  for (const fact of facts) {
    carry("questionType", fact.questionType, fact, 1)
    if (fact.primarySkill !== null) carry("skill", fact.primarySkill, fact, 1)
    for (const skill of new Set(fact.secondarySkills)) {
      if (skill !== fact.primarySkill) carry("skill", skill, fact, SecondaryWeight)
    }
  }
  return [...scopes.values()].map(({ kind, id, carried }) => {
    const bySection = new Map<string, number>()
    for (const { fact, role } of carried) bySection.set(fact.section, (bySection.get(fact.section) ?? 0) + role * fact.recency)
    const total = [...bySection.values()].reduce((sum, weight) => sum + weight, 0)
    const reference = total === 0
      ? 0
      : [...bySection].reduce((sum, [section, weight]) => sum + weight * (sectionAbility.get(section) ?? 0), 0) / total
    const fit = fitAbility(
      carried.map(({ fact, role }) => ({ difficulty: fact.difficulty, correct: fact.correct, weight: role * fact.recency })),
      { mean: reference, spread: ScopePriorSpread }
    )
    const pace = median(carried.filter(({ fact }) => fact.correct).map(({ fact }) => fact.pace))
    return {
      kind,
      id,
      evidence: carried.length,
      enough: carried.length >= EnoughEvidence,
      fit,
      reference,
      gap: reference - fit.ability,
      pace,
      slow: pace !== null && pace > SlowPace,
      sections: [...bySection].toSorted((a, b) => b[1] - a[1]).map(([section]) => section)
    }
  })
}
