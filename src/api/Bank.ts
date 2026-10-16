import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { CuratorSession } from "./Curator.ts"
import { TaxonomyView } from "./Taxonomy.ts"

// The Question Bank as the Curator watches it.

// After ingestion, a Skill with fewer published Questions than this is
// flagged for merging into a related Skill.
export const ThinSkillThreshold = 15

export class SkillCount extends Schema.Class<SkillCount>("gmat-prep/api/SkillCount")({
  id: Schema.String,
  name: Schema.String,
  // Published Questions tagged with it, as primary or secondary Skill.
  questions: Schema.Int
}) {}

// A Section's Mock Reserve (ADR 0008).
export class ReserveSection extends Schema.Class<ReserveSection>("gmat-prep/api/ReserveSection")({
  id: Schema.String,
  name: Schema.String,
  // Its published Questions.
  questions: Schema.Int,
  // Reserve Questions still held back for Mocks, and those released into
  // Practice Sets.
  held: Schema.Int,
  released: Schema.Int
}) {}

export const MaxRelease = 1000

export class UnknownSection extends Schema.TaggedError<UnknownSection>()(
  "UnknownSection",
  { section: Schema.String },
  { httpApiStatus: 422 }
) {}

export class BankApi extends HttpApiGroup.make("bank")
  .add(
    // Skills that fit the Question Types the Bank holds and have fewer than
    // ThinSkillThreshold Questions; empty until a Book has been extracted.
    HttpApiEndpoint.get("thinSkills", "/bank/thin-skills", { success: Schema.Array(SkillCount) }),
    HttpApiEndpoint.get("reserve", "/bank/reserve", { success: Schema.Array(ReserveSection) }),
    // Releases up to count of a Section's held Reserve Questions into
    // Practice Sets. Release is one-way: a Question a Learner may have Seen
    // cannot become unseen again.
    HttpApiEndpoint.post("releaseReserve", "/bank/reserve/release", {
      payload: Schema.Struct({
        section: Schema.String,
        count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MaxRelease }))
      }),
      success: Schema.Array(ReserveSection),
      error: UnknownSection
    }),
    // The Taxonomy, for the Curator's screens, which have no Profile open.
    HttpApiEndpoint.get("taxonomy", "/bank/taxonomy", { success: TaxonomyView })
  )
  .middleware(CuratorSession)
  .prefix("/api/curator")
{}
