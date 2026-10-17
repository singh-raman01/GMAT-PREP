import { type ScopeAbility, scopeKey, type ScopeKind } from "./abilities.ts"
import type { Frequencies } from "./frequency.ts"

// Weak Areas (docs/design.md, "Learning loop"): the Skills and Question Types
// with enough data whose Ability lags their reference, ranked by Priority,
// the gap times exam frequency.

export interface WeakArea {
  readonly kind: ScopeKind
  readonly id: string
  readonly ability: ScopeAbility
  readonly gap: number
  readonly frequency: number
  readonly priority: number
  // Its misses' Mistake Types, Slow and Guessed among them, by count.
  readonly mix: ReadonlyMap<string, number>
  readonly remedy: Remedy
}

export interface Remedy {
  // A timed Practice Set, for pace; else an untimed one, to see each solved.
  readonly timed: boolean
}

// The Mistake Types in Taxonomy order, which breaks a tie for the most
// common.
const MistakeOrder = ["concept-gap", "wrong-approach", "trap", "calculation-slip", "misread", "time-pressure"]
// These ask for practice on the clock.
const TimedRemedies = new Set(["time-pressure", "calculation-slip", "wrong-approach"])

// A miss of a Question, by what it carries and the kinds it counts: each wrong
// Part's Mistake Type, or Slow or Guessed.
export interface MissFact {
  readonly questionType: string
  readonly primarySkill: string | null
  readonly secondarySkills: ReadonlyArray<string>
  readonly kinds: ReadonlyArray<string>
}

// Each Skill's and Question Type's misses, kind by kind, keyed as scopes are.
export const mixesOf = (misses: ReadonlyArray<MissFact>): ReadonlyMap<string, ReadonlyMap<string, number>> => {
  const mixes = new Map<string, Map<string, number>>()
  for (const miss of misses) {
    const scopes = new Set([
      scopeKey("questionType", miss.questionType),
      ...[miss.primarySkill, ...miss.secondarySkills].flatMap((skill) => (skill === null ? [] : [scopeKey("skill", skill)]))
    ])
    for (const key of scopes) {
      const mix = mixes.get(key) ?? new Map<string, number>()
      for (const kind of miss.kinds) mix.set(kind, (mix.get(kind) ?? 0) + 1)
      mixes.set(key, mix)
    }
  }
  return mixes
}

// Timed when the Skill is slow or its most common Mistake Type is one that
// practice on the clock remedies.
export const remedyOf = (slow: boolean, mix: ReadonlyMap<string, number>): Remedy => {
  const top = [...mix].filter(([kind]) => MistakeOrder.includes(kind))
    .toSorted((a, b) => b[1] - a[1] || MistakeOrder.indexOf(a[0]) - MistakeOrder.indexOf(b[0]))[0]
  return { timed: slow || (top !== undefined && TimedRemedies.has(top[0])) }
}

export const weakAreasOf = (
  abilities: ReadonlyArray<ScopeAbility>,
  frequencies: Frequencies,
  mixes: ReadonlyMap<string, ReadonlyMap<string, number>>
): ReadonlyArray<WeakArea> =>
  abilities.filter((ability) => ability.enough && ability.gap > 0).map((ability) => {
    const frequency = (ability.kind === "skill" ? frequencies.skills : frequencies.questionTypes).get(ability.id) ?? 0
    const mix = mixes.get(scopeKey(ability.kind, ability.id)) ?? new Map<string, number>()
    return {
      kind: ability.kind,
      id: ability.id,
      ability,
      gap: ability.gap,
      frequency,
      priority: ability.gap * frequency,
      mix,
      remedy: remedyOf(ability.slow, mix)
    }
  }).toSorted((a, b) => b.priority - a.priority || b.gap - a.gap || a.id.localeCompare(b.id))
