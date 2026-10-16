import { Schema } from "effect"
import { Blueprint, type GroupId, GroupIds } from "../../api/blueprint.ts"
import { SectionalReport } from "../../api/Sectionals.ts"
import { type ScoreLine, UncalibratedLine } from "../ratings/scale.ts"
import type { ServedUnit } from "./adaptive.ts"

// What a Section run under Mock rules stores in its Session's config.

// The kinds of Session such a Section is: a Sectional, or one of a Mock's
// three Sections.
export const SectionKinds = ["sectional", "mock-section"] as const

const Tier = Schema.Literals(["reserve-near", "near", "reserve-far", "far", "seen"])

const ServedUnitRecord = Schema.Struct({
  unitId: Schema.String,
  group: Schema.Literals(GroupIds),
  // Its Questions in serving order, as they stood when it was chosen. The
  // unit takes a slot of this size.
  questionIds: Schema.Array(Schema.String),
  // Those the Profile had Seen when it was chosen, and of them, those a
  // Paper Mark had made Seen.
  seen: Schema.Array(Schema.String),
  paper: Schema.optional(Schema.Array(Schema.String)),
  // Those passed over because they left the Question Bank before their turn.
  skipped: Schema.Array(Schema.String),
  tier: Tier,
  slot: Schema.Literals(["own", "passed"])
})
export type ServedUnitRecord = typeof ServedUnitRecord.Type

const LineRecord = Schema.Struct({ offset: Schema.Number, slope: Schema.Number, calibrated: Schema.Boolean })

export const SectionalConfig = Schema.Struct({
  section: Schema.String,
  // For a Mock's Section: the Mock, and its place there from 1.
  mock: Schema.optional(Schema.Struct({ id: Schema.String, place: Schema.Int })),
  // The Blueprint as it stood at the start.
  blueprint: Blueprint,
  // The units served, in order.
  units: Schema.Array(ServedUnitRecord),
  // Slots passed on by groups no unit could fill, by group.
  passed: Schema.Record(Schema.String, Schema.Int),
  stage: Schema.Literals(["question", "review"]),
  // Slots nothing was left to fill when Review & Edit began.
  unfilled: Schema.Int,
  // Kept when the Section closes, so later Difficulty moves leave it as it
  // was. Whether each answer is right is read again against the current
  // keys whenever the report is shown, on the score line kept with it.
  report: Schema.NullOr(SectionalReport),
  line: Schema.optional(LineRecord)
})
export type SectionalConfig = typeof SectionalConfig.Type
export const encodeConfig = Schema.encodeSync(Schema.fromJsonString(SectionalConfig))
export const decodeConfig = Schema.decodeUnknownSync(Schema.fromJsonString(SectionalConfig))

export const servedUnitsOf = (config: SectionalConfig): ReadonlyArray<ServedUnit> =>
  config.units.map((unit) => ({ unitId: unit.unitId, group: unit.group, size: unit.questionIds.length, slot: unit.slot }))

export const passedOf = (config: SectionalConfig) => config.passed as Readonly<Partial<Record<GroupId, number>>>

// Every Question of the units a running Section chose, served yet or not.
export const chosenQuestions = (config: SectionalConfig) => config.units.flatMap((unit) => unit.questionIds)

// The score line a closed Section's report is scored on.
export const lineOf = (config: SectionalConfig): ScoreLine => config.line ?? UncalibratedLine
