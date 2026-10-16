import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { CuratorSession } from "./Curator.ts"
import { Named } from "./Practice.ts"

// For the Curator: the Skills whose Retry Ladders are running out of
// Siblings, so new Books or generated Questions can go where they are needed.

// A Skill with few Questions outside the Reserve is listed even before a
// step is skipped.
export const FewSiblings = 5

export class SkillSiblings extends Schema.Class<SkillSiblings>("gmat-prep/api/SkillSiblings")({
  skill: Named,
  section: Named,
  // Sibling steps skipped for want of one, across every Profile.
  skipped: Schema.Int,
  lastSkippedAt: Schema.NullOr(Schema.Number),
  // Published Questions with it as their primary Skill, outside the Mock
  // Reserve, that a Sibling step could serve.
  available: Schema.Int
}) {}

export class SiblingsApi extends HttpApiGroup.make("siblings")
  .add(
    // Skills with a skipped Sibling step, or with few Questions to serve one,
    // the most skipped first.
    HttpApiEndpoint.get("report", "/siblings", { success: Schema.Array(SkillSiblings) })
  )
  .middleware(CuratorSession)
  .prefix("/api/curator")
{}
