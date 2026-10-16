import { Cause, Clock, Context, Deferred, Effect, Layer, Option, Schema } from "effect"
import { formatDollars } from "../../api/money.ts"
import { type LlmError, SpendCapReached } from "../llm/LlmAdapter.ts"
import { type AnyJobKind, JobKinds, type JobStepFailed, type StepServices } from "./JobKind.ts"
import { decodeJson, type JobEnd, type JobRow, JobStore } from "./JobStore.ts"

// The worker's loop: claim a job, run its steps with a heartbeat, save a
// checkpoint after each step, and end the job's turn as done, failed, paused
// or cancelled. When the worker is killed nothing is written; the heartbeat
// goes stale and the next worker claims the job from its last checkpoint.

export const HeartbeatEvery = "5 seconds"
export const PollEvery = "1 second"
// How long a job waits after the API kept failing before it tries again.
export const ApiPauseMs = 5 * 60 * 1000

const PausedByCurator = "Paused by the Curator"
const CancelledByCurator = "Cancelled by the Curator"

// Why a step stopped, as the job's note.
export const endForError = (error: LlmError | JobStepFailed, now: number): JobEnd => {
  switch (error._tag) {
    case "SpendCapReached":
      return {
        _tag: "Paused",
        note: `The spend cap is reached: ${formatDollars(error.spend)} of ${formatDollars(error.cap)}. Raise the cap to continue.`,
        resumeAt: null
      }
    case "LlmUnavailable":
      return {
        _tag: "Paused",
        note: `The API is not responding (${error.status ?? "no response"}: ${error.message}). The job resumes on its own.`,
        resumeAt: now + Math.max(ApiPauseMs, error.retryAfterMs ?? 0)
      }
    case "LlmNotConfigured":
      return { _tag: "Failed", note: `Set ${error.missing.join(", ")} in Settings, then resume the job.` }
    case "LlmRefused":
      return { _tag: "Failed", note: `The API refused the request (${error.status}): ${error.message}` }
    case "LlmInvalidReply":
      return { _tag: "Failed", note: `The model's reply could not be used, even after a retry: ${error.problem}` }
    case "JobStepFailed":
      return { _tag: "Failed", note: error.message }
  }
}

const encodeCheckpoint = (kind: AnyJobKind, checkpoint: unknown) =>
  JSON.stringify(Schema.encodeSync(Schema.toCodecJson(kind.checkpoint))(checkpoint))

export class JobRunner extends Context.Service<JobRunner, {
  // Claims and runs one job; false when none was waiting.
  readonly runOnce: Effect.Effect<boolean, never, StepServices>
}>()("gmat-prep/server/JobRunner") {
  static readonly layer = Layer.effect(
    JobRunner,
    Effect.gen(function*() {
      const store = yield* JobStore
      const kinds = yield* JobKinds
      const workerId = `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`

      // Runs steps until the job ends its turn. "lost" means another worker
      // owns the job now, or it changed under this one.
      const runSteps = (row: JobRow, kind: AnyJobKind, params: unknown, start: unknown) =>
        Effect.gen(function*() {
          let checkpoint = start
          let stepsDone = row.stepsDone
          for (;;) {
            const spend = yield* store.spendOf(row.id)
            if (Option.isSome(spend) && spend.value.spend >= spend.value.cap) {
              return endForError(new SpendCapReached(spend.value), 0)
            }
            const outcome = yield* Effect.result(kind.step({ jobId: row.id, params, checkpoint, stepsDone }))
            const now = yield* Clock.currentTimeMillis
            if (outcome._tag === "Failure") return endForError(outcome.failure, now)
            const step = outcome.success
            if (step._tag === "Finished") return { _tag: "Done", result: step.result } as const
            stepsDone += 1
            const saved = yield* store.saveStep(row.id, workerId, {
              checkpoint: encodeCheckpoint(kind, step.checkpoint),
              stepsDone,
              stepsTotal: step.stepsTotal,
              note: step.note
            })
            if (Option.isNone(saved)) return "lost" as const
            checkpoint = step.checkpoint
            if (saved.value.requested === "cancel") return { _tag: "Cancelled", note: CancelledByCurator } as const
            if (saved.value.requested === "pause") {
              return { _tag: "Paused", note: PausedByCurator, resumeAt: null } as const
            }
          }
        })

      const runJob = (row: JobRow) =>
        Effect.gen(function*() {
          const end = (jobEnd: JobEnd) => store.finish(row.id, workerId, jobEnd).pipe(Effect.asVoid)
          const kind = kinds.get(row.kind)
          if (kind === undefined) {
            return yield* end({ _tag: "Failed", note: `This version of the app cannot run ${row.kind} jobs.` })
          }
          const params = decodeJson(kind.params, row.params)
          if (Option.isNone(params)) {
            return yield* end({ _tag: "Failed", note: "The job's settings could not be read." })
          }
          const checkpoint = row.checkpoint === null
            ? Option.some(kind.start(params.value))
            : decodeJson(kind.checkpoint, row.checkpoint)
          if (Option.isNone(checkpoint)) {
            return yield* end({ _tag: "Failed", note: "The job's saved progress could not be read." })
          }
          if (row.requested === "cancel") return yield* end({ _tag: "Cancelled", note: CancelledByCurator })
          if (row.requested === "pause") return yield* end({ _tag: "Paused", note: PausedByCurator, resumeAt: null })

          // The heartbeat keeps the claim. A cancel stops the step at once; a
          // pause waits for the step to finish and be saved.
          const stop = yield* Deferred.make<"lost" | "cancel">()
          yield* Effect.forkScoped(
            Effect.forever(
              Effect.gen(function*() {
                yield* Effect.sleep(HeartbeatEvery)
                const beat = yield* store.heartbeat(row.id, workerId)
                if (Option.isNone(beat)) return yield* Deferred.succeed(stop, "lost")
                if (beat.value.requested === "cancel") yield* Deferred.succeed(stop, "cancel")
              })
            )
          )

          const outcome = yield* Effect.raceFirst(
            runSteps(row, kind, params.value, checkpoint.value),
            Deferred.await(stop)
          ).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logError(`Job ${row.id} stopped on an internal error`, Cause.pretty(cause)).pipe(
                  Effect.as({
                    _tag: "Failed",
                    note: "The job stopped on an internal error; see the app's log."
                  } as JobEnd)
                )
            )
          )
          if (outcome === "lost") return
          if (outcome === "cancel") return yield* end({ _tag: "Cancelled", note: CancelledByCurator })
          yield* end(outcome)
        }).pipe(Effect.scoped)

      const runOnce = Effect.gen(function*() {
        const claimed = yield* store.claim(workerId)
        if (Option.isNone(claimed)) return false
        yield* runJob(claimed.value)
        return true
      })

      return JobRunner.of({ runOnce })
    })
  )

  // Runs jobs until interrupted, checking for new ones every second.
  static readonly loop = Effect.gen(function*() {
    const runner = yield* JobRunner
    return yield* Effect.forever(
      runner.runOnce.pipe(Effect.flatMap((ran) => (ran ? Effect.void : Effect.sleep(PollEvery))))
    )
  })
}
