import { type Blueprint, type GroupId, groupsOf, slotsOf } from "../../api/blueprint.ts"
import { bandOf, type DifficultyBand } from "../../api/difficulty.ts"
import { fitAbility, SectionPrior } from "../ratings/model.ts"

// Adaptive selection in Mocks and Sectionals (docs/design.md, "Sessions").
// After each Response the Section's estimate is refitted, and the next unit
// is the best candidate whose group still has room: a single Question, or
// an RC passage's or MSR set's Questions, served one after another.

// What can be served: one Question, or a passage's or set's Questions.
export interface Unit {
  // The Question's id, or the passage's or set's Stimulus id.
  readonly id: string
  readonly group: GroupId
  // Its Questions, in the order they are served.
  readonly questionIds: ReadonlyArray<string>
  // Its Questions' mean Difficulty.
  readonly difficulty: number
  // Held for Mocks and not released.
  readonly reserve: boolean
  // When the Profile last saw one of its Questions; null when none is Seen.
  readonly lastSeenAt: number | null
}

// A unit the Section served, and the slot it took: one of its group's own,
// or one another group passed on.
export interface ServedUnit {
  readonly unitId: string
  readonly group: GroupId
  readonly size: number
  readonly slot: "own" | "passed"
}

// Tiers, in the order they are tried: unseen Reserve within 0.5 of the
// estimate; unseen from anywhere within 0.5; unseen at any distance, the
// Reserve before the rest; then the unit Seen longest ago.
export type Tier = "reserve-near" | "near" | "reserve-far" | "far" | "seen"

export const NearDistance = 0.5
// Within a tier the pick is random among this many closest.
export const PickAmong = 5

export interface Pick {
  readonly unit: Unit
  readonly tier: Tier
  readonly slot: "own" | "passed"
}

export interface Step {
  // The next unit, or none when nothing left can fill an open slot.
  readonly pick: Pick | undefined
  // Slots passed on by groups no unit can fill, by group, kept for the rest
  // of the Section.
  readonly passed: Readonly<Partial<Record<GroupId, number>>>
}

const removeOne = (sizes: Array<number>, size: number) => {
  const index = sizes.indexOf(size)
  if (index >= 0) sizes.splice(index, 1)
}

// Each group's own open slots, by unit size, and the passed slots not used
// yet. Slots a group passed on are no longer its own.
export const openSlots = (
  blueprint: Blueprint,
  section: string,
  served: ReadonlyArray<ServedUnit>,
  passed: Readonly<Partial<Record<GroupId, number>>>
) => {
  const own = new Map<GroupId, Array<number>>()
  for (const group of groupsOf(section)) {
    const sizes = [...slotsOf(blueprint, group.id)]
    for (const unit of served) if (unit.group === group.id && unit.slot === "own") removeOne(sizes, unit.size)
    // A group passes on all its open slots at once.
    own.set(group.id, (passed[group.id] ?? 0) > 0 ? [] : sizes)
  }
  const passedTotal = Object.values(passed).reduce((sum, count) => sum + (count ?? 0), 0)
  const passedUsed = served.filter((unit) => unit.slot === "passed").reduce((sum, unit) => sum + unit.size, 0)
  return { own, passed: Math.max(0, passedTotal - passedUsed) }
}

const distance = (unit: Unit, estimate: number) => Math.abs(unit.difficulty - estimate)

// The next unit to serve. pool is every unit the Section could serve; the
// units it served are left out here. random gives numbers in [0, 1).
export const nextUnit = (input: {
  readonly blueprint: Blueprint
  readonly section: string
  readonly pool: ReadonlyArray<Unit>
  readonly served: ReadonlyArray<ServedUnit>
  readonly passed: Readonly<Partial<Record<GroupId, number>>>
  readonly estimate: number
  readonly random: () => number
}): Step => {
  const servedIds = new Set(input.served.map((unit) => unit.unitId))
  const left = input.pool.filter((unit) => !servedIds.has(unit.id))
  // A group with open slots that no unit left fits passes them on.
  const passed = { ...input.passed }
  for (const [group, sizes] of openSlots(input.blueprint, input.section, input.served, passed).own) {
    if (sizes.length === 0) continue
    if (!left.some((unit) => unit.group === group && sizes.includes(unit.questionIds.length))) {
      passed[group] = sizes.reduce((sum, size) => sum + size, 0)
    }
  }
  const open = openSlots(input.blueprint, input.section, input.served, passed)
  // A unit takes its group's own slot of its size, else a passed slot when
  // it is a single Question.
  const slotFor = (unit: Unit): "own" | "passed" | undefined =>
    open.own.get(unit.group)?.includes(unit.questionIds.length)
      ? "own"
      : unit.questionIds.length === 1 && open.passed > 0
      ? "passed"
      : undefined
  const candidates = left.filter((unit) => slotFor(unit) !== undefined)
  const near = (unit: Unit) => distance(unit, input.estimate) <= NearDistance
  const unseen = candidates.filter((unit) => unit.lastSeenAt === null)
  const tiers: ReadonlyArray<readonly [Tier, ReadonlyArray<Unit>]> = [
    ["reserve-near", unseen.filter((unit) => unit.reserve && near(unit))],
    ["near", unseen.filter((unit) => !unit.reserve && near(unit))],
    ["reserve-far", unseen.filter((unit) => unit.reserve)],
    ["far", unseen]
  ]
  for (const [tier, units] of tiers) {
    if (units.length === 0) continue
    const closest = units.toSorted((a, b) => distance(a, input.estimate) - distance(b, input.estimate) || a.id.localeCompare(b.id))
      .slice(0, PickAmong)
    const unit = closest[Math.min(closest.length - 1, Math.floor(input.random() * closest.length))]!
    return { pick: { unit, tier, slot: slotFor(unit)! }, passed }
  }
  // Every candidate is Seen: the one Seen longest ago, a unit by its most
  // recent sighting.
  const seen = candidates.toSorted((a, b) =>
    (a.lastSeenAt ?? 0) - (b.lastSeenAt ?? 0) || distance(a, input.estimate) - distance(b, input.estimate) ||
    a.id.localeCompare(b.id)
  )[0]
  return { pick: seen === undefined ? undefined : { unit: seen, tier: "seen", slot: slotFor(seen)! }, passed }
}

// The Section's estimate from its Responses so far, each at its Question's
// Difficulty: the fit every selection uses, from Medium (0) with spread 1.
export const sectionEstimate = (answers: ReadonlyArray<{ readonly difficulty: number; readonly correct: boolean }>) =>
  fitAbility(answers.map((answer) => ({ ...answer, weight: 1 })), SectionPrior).ability

// A generator of numbers in [0, 1) from a seed, so a Section's picks can be
// repeated (mulberry32 over a hash of the seed).
export const seededRandom = (seed: string): (() => number) => {
  let state = 2166136261
  for (let i = 0; i < seed.length; i++) state = Math.imul(state ^ seed.charCodeAt(i), 16777619)
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// What the start check counts for one group: its unseen Reserve Questions in
// units that fit a slot, by Difficulty Band.
export interface GroupStock {
  readonly group: GroupId
  readonly needed: number
  readonly unseen: number
  readonly byBand: Readonly<Record<DifficultyBand, number>>
}

// A Mock or Sectional starts only when the Reserve holds, unseen by the
// Profile, at least twice the Blueprint count for each group of the Section,
// counting all three Difficulty Bands together.
export const sectionStock = (
  blueprint: Blueprint,
  section: string,
  pool: ReadonlyArray<Unit>
): ReadonlyArray<GroupStock> =>
  groupsOf(section).map((group) => {
    const sizes = slotsOf(blueprint, group.id)
    const units = pool.filter((unit) =>
      unit.group === group.id && unit.reserve && unit.lastSeenAt === null && sizes.includes(unit.questionIds.length)
    )
    const byBand: Record<DifficultyBand, number> = { easy: 0, medium: 0, hard: 0 }
    for (const unit of units) byBand[bandOf(unit.difficulty)] += unit.questionIds.length
    return {
      group: group.id,
      needed: 2 * sizes.reduce((sum, size) => sum + size, 0),
      unseen: units.reduce((sum, unit) => sum + unit.questionIds.length, 0),
      byBand
    }
  })
