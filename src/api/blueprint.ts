import { Schema } from "effect"

// The Section Blueprint: how many Questions each group of Question Types
// gets in an adaptive Section. An RC passage's or an MSR set's Questions are
// one unit, served one after another, so those groups are set as the sizes
// of their units; the others as a count of single Questions. GMAC does not
// publish the mix, so these are defaults the Curator can change.

export const GroupIds = ["ps", "rc", "cr", "ds", "msr", "ta", "gi", "tpa"] as const
export type GroupId = (typeof GroupIds)[number]

export type BlueprintSection = "quant" | "verbal" | "di"

export interface BlueprintGroup {
  readonly id: GroupId
  readonly name: string
  readonly section: BlueprintSection
  // Its Questions come in units, each about one Stimulus.
  readonly units: boolean
  readonly fits: (questionType: string) => boolean
}

export const BlueprintGroups: ReadonlyArray<BlueprintGroup> = [
  { id: "ps", name: "Problem Solving", section: "quant", units: false, fits: (type) => type === "quant.ps" },
  {
    id: "rc",
    name: "Reading Comprehension",
    section: "verbal",
    units: true,
    fits: (type) => type.startsWith("verbal.rc-")
  },
  {
    id: "cr",
    name: "Critical Reasoning",
    section: "verbal",
    units: false,
    fits: (type) => type.startsWith("verbal.cr-")
  },
  { id: "ds", name: "Data Sufficiency", section: "di", units: false, fits: (type) => type === "di.ds" },
  { id: "msr", name: "Multi-Source Reasoning", section: "di", units: true, fits: (type) => type === "di.msr" },
  { id: "ta", name: "Table Analysis", section: "di", units: false, fits: (type) => type === "di.ta" },
  { id: "gi", name: "Graphics Interpretation", section: "di", units: false, fits: (type) => type === "di.gi" },
  { id: "tpa", name: "Two-Part Analysis", section: "di", units: false, fits: (type) => type === "di.tpa" }
]

// What the Curator can set: a group gets 1 to 40 single Questions, or 1 to 8
// units of 2 to 6 Questions each.
export const GroupCountRange = { minimum: 1, maximum: 40 } as const
export const UnitSizeRange = { minimum: 2, maximum: 6 } as const
export const UnitsRange = { minimum: 1, maximum: 8 } as const

const Count = Schema.Int.check(Schema.isBetween(GroupCountRange))
const Units = Schema.Array(Schema.Int.check(Schema.isBetween(UnitSizeRange))).check(
  Schema.isMinLength(UnitsRange.minimum),
  Schema.isMaxLength(UnitsRange.maximum)
)

export const Blueprint = Schema.Struct({
  ps: Count,
  rc: Units,
  cr: Count,
  ds: Count,
  msr: Units,
  ta: Count,
  gi: Count,
  tpa: Count
})
export type Blueprint = typeof Blueprint.Type

export const DefaultBlueprint: Blueprint = { ps: 21, rc: [3, 3, 3, 4], cr: 10, ds: 7, msr: [3], ta: 3, gi: 4, tpa: 3 }

export const groupOf = (questionType: string): BlueprintGroup | undefined =>
  BlueprintGroups.find((group) => group.fits(questionType))

export const groupsOf = (section: string): ReadonlyArray<BlueprintGroup> =>
  BlueprintGroups.filter((group) => group.section === section)

// A group's slots, by the size of the unit each takes: one for a single
// Question.
export const slotsOf = (blueprint: Blueprint, group: GroupId): ReadonlyArray<number> => {
  const value = blueprint[group]
  return typeof value === "number" ? Array.from({ length: value }, () => 1) : value
}

const total = (sizes: ReadonlyArray<number>) => sizes.reduce((sum, size) => sum + size, 0)

// How many Questions a group gets.
export const groupCount = (blueprint: Blueprint, group: GroupId) => total(slotsOf(blueprint, group))

// How many Questions a Section gets.
export const sectionCount = (blueprint: Blueprint, section: string) =>
  total(groupsOf(section).map((group) => groupCount(blueprint, group.id)))

// Whether a unit of this many Questions of this type fits a slot.
export const fitsSlot = (questionType: string, unitSize: number, blueprint: Blueprint = DefaultBlueprint) => {
  const group = groupOf(questionType)
  return group !== undefined && slotsOf(blueprint, group.id).includes(unitSize)
}
