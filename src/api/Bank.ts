import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { CuratorSession } from "./Curator.ts"

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

export class BankApi extends HttpApiGroup.make("bank")
  .add(
    // Skills that fit the Question Types the Bank holds and have fewer than
    // ThinSkillThreshold Questions; empty until a Book has been extracted.
    HttpApiEndpoint.get("thinSkills", "/bank/thin-skills", { success: Schema.Array(SkillCount) })
  )
  .middleware(CuratorSession)
  .prefix("/api/curator")
{}
