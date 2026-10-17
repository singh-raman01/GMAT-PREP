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
  // Its most common Mistake Type, and the most common Trap Pattern of the
  // wrong options picked in its misses.
  readonly topMistake: string | null
  readonly topTrap: string | null
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
  // The Trap Patterns of the wrong options picked.
  readonly traps?: ReadonlyArray<string>
}

type Counts = ReadonlyMap<string, ReadonlyMap<string, number>>

// Each Skill's and Question Type's misses, counted by what pick gives,
// keyed as scopes are.
const countedBy = (misses: ReadonlyArray<MissFact>, pick: (miss: MissFact) => ReadonlyArray<string>): Counts => {
  const counts = new Map<string, Map<string, number>>()
  for (const miss of misses) {
    const scopes = new Set([
      scopeKey("questionType", miss.questionType),
      ...[miss.primarySkill, ...miss.secondarySkills].flatMap((skill) => (skill === null ? [] : [scopeKey("skill", skill)]))
    ])
    for (const key of scopes) {
      const count = counts.get(key) ?? new Map<string, number>()
      for (const kind of pick(miss)) count.set(kind, (count.get(kind) ?? 0) + 1)
      counts.set(key, count)
    }
  }
  return counts
}

// Each Skill's and Question Type's misses, kind by kind.
export const mixesOf = (misses: ReadonlyArray<MissFact>): Counts => countedBy(misses, (miss) => miss.kinds)

// Each Skill's and Question Type's misses, Trap Pattern by Trap Pattern.
export const trapsOf = (misses: ReadonlyArray<MissFact>): Counts => countedBy(misses, (miss) => miss.traps ?? [])

// The most common Mistake Type, Taxonomy order breaking a tie.
export const topMistakeOf = (mix: ReadonlyMap<string, number>) =>
  [...mix].filter(([kind]) => MistakeOrder.includes(kind))
    .toSorted((a, b) => b[1] - a[1] || MistakeOrder.indexOf(a[0]) - MistakeOrder.indexOf(b[0]))[0]?.[0] ?? null

// The most common Trap Pattern, the first by id breaking a tie.
export const topTrapOf = (traps: ReadonlyMap<string, number>) =>
  [...traps].toSorted((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0] ?? null

// Timed when the Skill is slow or its most common Mistake Type is one that
// practice on the clock remedies.
export const remedyOf = (slow: boolean, mix: ReadonlyMap<string, number>): Remedy => {
  const top = topMistakeOf(mix)
  return { timed: slow || (top !== null && TimedRemedies.has(top)) }
}

export const weakAreasOf = (
  abilities: ReadonlyArray<ScopeAbility>,
  frequencies: Frequencies,
  mixes: Counts,
  traps: Counts = new Map()
): ReadonlyArray<WeakArea> =>
  abilities.filter((ability) => ability.enough && ability.gap > 0).map((ability) => {
    const frequency = (ability.kind === "skill" ? frequencies.skills : frequencies.questionTypes).get(ability.id) ?? 0
    const mix = mixes.get(scopeKey(ability.kind, ability.id)) ?? new Map<string, number>()
    return {
      topMistake: topMistakeOf(mix),
      topTrap: topTrapOf(traps.get(scopeKey(ability.kind, ability.id)) ?? new Map()),
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
