// The Section Blueprint: how many Questions each group of Question Types gets
// in a Mock Section, and the sizes of the units it serves them in (an RC
// passage or an MSR set is one unit). GMAC does not publish the mix, so these
// are defaults.

export interface BlueprintGroup {
  readonly name: string
  readonly section: "quant" | "verbal" | "di"
  readonly count: number
  // Units of these sizes fit a slot of the group.
  readonly unitSizes: ReadonlyArray<number>
  readonly fits: (questionType: string) => boolean
}

export const SectionBlueprint: ReadonlyArray<BlueprintGroup> = [
  { name: "Problem Solving", section: "quant", count: 21, unitSizes: [1], fits: (type) => type === "quant.ps" },
  {
    name: "Reading Comprehension",
    section: "verbal",
    count: 13,
    unitSizes: [3, 4],
    fits: (type) => type.startsWith("verbal.rc-")
  },
  {
    name: "Critical Reasoning",
    section: "verbal",
    count: 10,
    unitSizes: [1],
    fits: (type) => type.startsWith("verbal.cr-")
  },
  { name: "Data Sufficiency", section: "di", count: 7, unitSizes: [1], fits: (type) => type === "di.ds" },
  { name: "Multi-Source Reasoning", section: "di", count: 3, unitSizes: [3], fits: (type) => type === "di.msr" },
  { name: "Table Analysis", section: "di", count: 3, unitSizes: [1], fits: (type) => type === "di.ta" },
  { name: "Graphics Interpretation", section: "di", count: 4, unitSizes: [1], fits: (type) => type === "di.gi" },
  { name: "Two-Part Analysis", section: "di", count: 3, unitSizes: [1], fits: (type) => type === "di.tpa" }
]

export const groupOf = (questionType: string): BlueprintGroup | undefined =>
  SectionBlueprint.find((group) => group.fits(questionType))

// Whether a unit of this many Questions of this type fits a slot.
export const fitsSlot = (questionType: string, unitSize: number) =>
  groupOf(questionType)?.unitSizes.includes(unitSize) ?? false
