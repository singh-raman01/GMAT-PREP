import { Context, type Effect, Layer, Schema } from "effect"
import type { BookFiles } from "../books/BookFiles.ts"
import type { Db } from "../db/Database.ts"
import type { LlmAdapter, LlmError } from "../llm/LlmAdapter.ts"
import type { Settings } from "../settings/Settings.ts"

// A kind of job: what its parameters and checkpoint look like, and one step
// of work. The runner saves the checkpoint after every step, so a job that
// stops for any reason resumes at the step after the last one saved. A step
// must therefore be safe to run again from the checkpoint before it.

export class JobStepFailed extends Schema.TaggedError<JobStepFailed>()("JobStepFailed", {
  message: Schema.String
}) {}

export type StepOutcome<C> =
  | {
    readonly _tag: "Continue"
    readonly checkpoint: C
    readonly stepsTotal: number | null
    readonly note: string | null
  }
  | { readonly _tag: "Finished"; readonly result: string }

export interface StepInput<P, C> {
  readonly jobId: string
  readonly params: P
  readonly checkpoint: C
  readonly stepsDone: number
}

// What a step may use.
export type StepServices = LlmAdapter | Db | Settings | BookFiles

export interface JobKind<P, C> {
  readonly kind: string
  readonly params: Schema.Codec<P, unknown>
  readonly checkpoint: Schema.Codec<C, unknown>
  readonly label: (params: P) => string
  readonly start: (params: P) => C
  readonly stepsTotal: (params: P) => number | null
  readonly step: (input: StepInput<P, C>) => Effect.Effect<StepOutcome<C>, LlmError | JobStepFailed, StepServices>
}

// Kinds differ in their parameter and checkpoint types; the registry holds any.
export type AnyJobKind = JobKind<any, any>

export class JobKinds extends Context.Service<JobKinds, ReadonlyMap<string, AnyJobKind>>()(
  "gmat-prep/server/JobKinds"
) {
  static readonly layer = (kinds: ReadonlyArray<AnyJobKind>) =>
    Layer.succeed(JobKinds, JobKinds.of(new Map(kinds.map((kind) => [kind.kind, kind]))))
}
