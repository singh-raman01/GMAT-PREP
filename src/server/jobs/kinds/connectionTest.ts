import { Effect, Schema } from "effect"
import { formatDollars } from "../../../api/money.ts"
import { LlmTask, LlmTaskLabels } from "../../../api/Settings.ts"
import { LlmAdapter } from "../../llm/LlmAdapter.ts"
import { type JobKind, JobStepFailed } from "../JobKind.ts"

// One LLM call end to end: settings, key, request, schema check and spend.

const Params = Schema.Struct({
  task: LlmTask,
  // The model set for the task when the test was started, for its label.
  model: Schema.String,
  // A word the model must send back, so a canned reply cannot pass.
  word: Schema.String
})

// A single step, so there is nothing to carry between steps.
const Checkpoint = Schema.Struct({})

export const ConnectionTestReply = Schema.Struct({ ok: Schema.Boolean, word: Schema.String })

export const ConnectionTest: JobKind<typeof Params.Type, typeof Checkpoint.Type> = {
  kind: "connection-test",
  params: Params,
  checkpoint: Checkpoint,
  label: (params) => `Connection test: ${LlmTaskLabels[params.task]} on ${params.model}`,
  start: () => ({}),
  stepsTotal: () => 1,
  step: ({ jobId, params }) =>
    Effect.gen(function*() {
      const llm = yield* LlmAdapter
      const reply = yield* llm.call({
        task: params.task,
        promptVersion: "connection-test@1",
        system: "You are checking that an API connection works. Follow the instruction exactly.",
        user: `Reply with ok set to true and word set to "${params.word}".`,
        output: ConnectionTestReply,
        jobId
      })
      if (!reply.value.ok || reply.value.word !== params.word) {
        return yield* new JobStepFailed({
          message: `The model replied, but not as asked: ${JSON.stringify(reply.value)}.`
        })
      }
      return {
        _tag: "Finished" as const,
        result: `${reply.model} replied as asked, using ${reply.tokensIn + reply.tokensOut} tokens for ${
          formatDollars(reply.cost)
        }.`
      }
    })
}

// Lowercase letters only, so the model has nothing to reformat.
export const randomWord = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => String.fromCharCode(97 + (byte % 26))).join("")
