import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { CuratorSession } from "./Curator.ts"
import { JobView } from "./Jobs.ts"
import { Named } from "./Practice.ts"

// The Curator's Overview (docs/design.md, "Analytics"): what the Question
// Bank covers, what the Mock Reserve still holds, where Questions run short,
// and what is waiting or costing money this month.

export class CoverageView extends Schema.Class<CoverageView>("gmat-prep/api/CoverageView")({
  skill: Named,
  section: Named,
  // Published Questions carrying it, as primary or secondary Skill, by
  // Difficulty Band.
  easy: Schema.Int,
  medium: Schema.Int,
  hard: Schema.Int
}) {}

export class ReserveGroupView extends Schema.Class<ReserveGroupView>("gmat-prep/api/ReserveGroupView")({
  section: Named,
  group: Named,
  // Reserve Questions still held back for Mocks.
  held: Schema.Int,
  // How many one Mock's Section takes from the group, by the Blueprint.
  perMock: Schema.Int
}) {}

export class CuratorOverview extends Schema.Class<CuratorOverview>("gmat-prep/api/CuratorOverview")({
  // Every Skill in the Taxonomy, in its order.
  coverage: Schema.Array(CoverageView),
  reserve: Schema.Array(ReserveGroupView),
  // How many whole Mocks the held Reserve covers, the scarcest group
  // deciding.
  mocks: Schema.Int,
  // Skills by Question Type running out of Siblings, as the Siblings page
  // lists them, and Skills with few published Questions.
  siblings: Schema.Int,
  thinSkills: Schema.Int,
  // Review Queue items waiting for a decision.
  reviewQueue: Schema.Int,
  // Learners' Problem Reports waiting for a decision, and the Questions they
  // are on; each Question's reports are one of the Review Queue's items.
  problemReports: Schema.Int,
  reportedQuestions: Schema.Int,
  // The month so far, from its first day in the app's time zone.
  monthFrom: Schema.Number,
  // What every LLM call cost this month, and the jobs that ran in it.
  spend: Schema.Number,
  jobs: Schema.Array(JobView)
}) {}

export class OverviewApi extends HttpApiGroup.make("overview")
  .add(HttpApiEndpoint.get("get", "/overview", { success: CuratorOverview }))
  .middleware(CuratorSession)
  .prefix("/api/curator")
{}
