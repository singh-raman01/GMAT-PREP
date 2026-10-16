import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { CuratorSession } from "./Curator.ts"
import { LlmTask } from "./Settings.ts"

export const JobStatus = Schema.Literals(["queued", "running", "paused", "failed", "done", "cancelled"])
export type JobStatus = typeof JobStatus.Type

export const JobId = Schema.String.pipe(Schema.brand("JobId"))
export type JobId = typeof JobId.Type

// US dollars.
export const SpendCap = Schema.Number.check(
  Schema.makeFilter((cap: number) => Number.isFinite(cap) && cap > 0 && cap <= 10_000, {
    description: "a spend cap above 0 and up to 10000 dollars"
  })
)

export class JobView extends Schema.Class<JobView>("gmat-prep/api/JobView")({
  id: JobId,
  kind: Schema.String,
  label: Schema.String,
  status: JobStatus,
  stepsDone: Schema.Int,
  stepsTotal: Schema.NullOr(Schema.Int),
  // What the job is doing, or why it paused or failed.
  note: Schema.NullOr(Schema.String),
  // What a finished job found, in words.
  result: Schema.NullOr(Schema.String),
  spend: Schema.Number,
  spendCap: Schema.Number,
  // Whether pause or cancel was asked while the job runs.
  requested: Schema.NullOr(Schema.Literals(["pause", "cancel"])),
  resumeAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number),
  // Higher for every later change; a client keeps the highest it has seen.
  revision: Schema.Int
}) {}

export class JobNotFound extends Schema.TaggedError<JobNotFound>()(
  "JobNotFound",
  {},
  { httpApiStatus: 404 }
) {}

// The job's status does not allow the action, such as resuming a finished job.
export class JobNotChangeable extends Schema.TaggedError<JobNotChangeable>()(
  "JobNotChangeable",
  { status: JobStatus },
  { httpApiStatus: 409 }
) {}

export class SpendCapTooLow extends Schema.TaggedError<SpendCapTooLow>()(
  "SpendCapTooLow",
  { spend: Schema.Number },
  { httpApiStatus: 409 }
) {}

// Something the LLM needs is not set yet, such as the API key.
export class LlmNotConfigured extends Schema.TaggedError<LlmNotConfigured>()(
  "LlmNotConfigured",
  { missing: Schema.Array(Schema.String) },
  { httpApiStatus: 409 }
) {}

const jobParams = { params: { id: JobId } }

export class JobsApi extends HttpApiGroup.make("jobs")
  .add(
    HttpApiEndpoint.get("list", "/jobs", {
      success: Schema.Array(JobView)
    }),
    HttpApiEndpoint.post("testConnection", "/jobs/connection-test", {
      payload: Schema.Struct({ task: LlmTask, spendCap: Schema.optional(SpendCap) }),
      success: JobView,
      error: LlmNotConfigured
    }),
    HttpApiEndpoint.post("pause", "/jobs/:id/pause", {
      ...jobParams,
      success: JobView,
      error: [JobNotFound, JobNotChangeable]
    }),
    HttpApiEndpoint.post("resume", "/jobs/:id/resume", {
      ...jobParams,
      payload: Schema.Struct({ spendCap: Schema.optional(SpendCap) }),
      success: JobView,
      error: [JobNotFound, JobNotChangeable, SpendCapTooLow]
    }),
    HttpApiEndpoint.post("cancel", "/jobs/:id/cancel", {
      ...jobParams,
      success: JobView,
      error: [JobNotFound, JobNotChangeable]
    })
  )
  .middleware(CuratorSession)
  .prefix("/api/curator")
{}
