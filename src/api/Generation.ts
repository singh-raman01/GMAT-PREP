import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { CuratorSession } from "./Curator.ts"
import { DifficultyBand } from "./difficulty.ts"
import { JobView, LlmNotConfigured, SpendCap } from "./Jobs.ts"

// Generation batches (ADR 0003): the Curator asks for Data Insights
// Questions of one Question Type, aimed at a Skill and a Difficulty Band.

export const GeneratedQuestionType = Schema.Literals(["di.ta", "di.gi", "di.tpa", "di.msr"])
export type GeneratedQuestionType = typeof GeneratedQuestionType.Type

// Dollars a batch may spend unless the Curator gives another cap.
export const DefaultSpendCap = 2

// How many items a batch asks for: Questions, or MSR sets of three.
export const BatchCount = Schema.Int.check(
  Schema.makeFilter((count: number) => count >= 1 && count <= 20, { description: "a count of 1 to 20" })
)

export class BatchView extends Schema.Class<BatchView>("gmat-prep/api/BatchView")({
  id: Schema.String,
  number: Schema.Int,
  questionType: GeneratedQuestionType,
  skill: Schema.String,
  band: DifficultyBand,
  count: Schema.Int,
  // Items the generator could not make valid.
  failed: Schema.Int,
  // The batch's Questions so far, and what became of them.
  questions: Schema.Int,
  published: Schema.Int,
  held: Schema.Int,
  // Drafts not through the Publish Gate yet: being checked while the job
  // runs, left unchecked once it stopped.
  checking: Schema.Int,
  withdrawn: Schema.Int,
  // Held for Mocks, not released.
  reserved: Schema.Int,
  job: Schema.NullOr(JobView),
  createdAt: Schema.Number
}) {}

// The Skill does not apply to the Question Type; the ones that do are given.
export class SkillNotForType extends Schema.TaggedError<SkillNotForType>()(
  "SkillNotForType",
  { skills: Schema.Array(Schema.String) },
  { httpApiStatus: 422 }
) {}

export class GenerationApi extends HttpApiGroup.make("generation")
  .add(
    HttpApiEndpoint.get("batches", "/generation", { success: Schema.Array(BatchView) }),
    HttpApiEndpoint.post("start", "/generation", {
      payload: Schema.Struct({
        questionType: GeneratedQuestionType,
        skill: Schema.String,
        band: DifficultyBand,
        count: BatchCount,
        spendCap: SpendCap
      }),
      success: BatchView,
      error: [SkillNotForType, LlmNotConfigured]
    })
  )
  .middleware(CuratorSession)
  .prefix("/api/curator")
{}
