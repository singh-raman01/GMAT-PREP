import { eq, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Random, Redacted, Schema } from "effect"
import { LlmNotConfigured } from "../../api/Jobs.ts"
import type { LlmTask } from "../../api/Settings.ts"
import { Db } from "../db/Database.ts"
import { jobs, llmCalls } from "../db/schema.ts"
import { nextRevision } from "../jobs/revision.ts"
import { ApiKeyStore } from "../settings/ApiKeyStore.ts"
import { completionsUrl, missingSettings, Settings } from "../settings/Settings.ts"
import { strictJsonSchema } from "./jsonSchema.ts"
import { type ChatMessage, LlmTransport, type TransportFailure, type TransportReply } from "./LlmTransport.ts"

// The API refused the request for a reason retrying cannot fix, such as a
// wrong key (401) or an unknown model (404).
export class LlmRefused extends Schema.TaggedError<LlmRefused>()("LlmRefused", {
  status: Schema.Int,
  message: Schema.String
}) {}

// The API kept failing with 429, 5xx or no response. retryAfterMs is the
// API's own estimate, when it gave one.
export class LlmUnavailable extends Schema.TaggedError<LlmUnavailable>()("LlmUnavailable", {
  status: Schema.NullOr(Schema.Int),
  message: Schema.String,
  retryAfterMs: Schema.NullOr(Schema.Number)
}) {}

// The reply did not match its schema, even after one retry with the error.
export class LlmInvalidReply extends Schema.TaggedError<LlmInvalidReply>()("LlmInvalidReply", {
  problem: Schema.String
}) {}

export class SpendCapReached extends Schema.TaggedError<SpendCapReached>()("SpendCapReached", {
  spend: Schema.Number,
  cap: Schema.Number
}) {}

export type LlmError = LlmNotConfigured | LlmRefused | LlmUnavailable | LlmInvalidReply | SpendCapReached

export interface LlmRequest<A> {
  readonly task: LlmTask
  // Names the prompt and its version, such as "connection-test@1".
  readonly promptVersion: string
  readonly system: string
  // The input. Book text goes here as quoted data, never as instructions.
  readonly user: string
  readonly output: Schema.Codec<A, unknown>
  // The job the call is made for; its spend counts against the job's cap.
  readonly jobId?: string
  // How many times to send it while the API is down or rate limited; a
  // Learner waiting on a reply, as in Tutor Chat, is given fewer.
  readonly attempts?: number
}

// A checked reply and where it came from. Every stored output keeps the
// model, prompt version and time.
export interface LlmReply<A> {
  readonly value: A
  readonly model: string
  readonly promptVersion: string
  readonly at: number
  // Tokens and dollars for this call and any retries it needed.
  readonly tokensIn: number
  readonly tokensOut: number
  readonly cost: number
}

// Retries for 429, 5xx and lost connections, before the call gives up.
const MaxAttempts = 6
const MaxBackoffMs = 30_000
// A Retry-After longer than this is not waited out inside the call; the
// caller pauses instead (a job resumes on its own).
const MaxInlineWaitMs = 60_000

const retryable = (failure: TransportFailure) =>
  failure.sent && (
    failure.status === null || failure.status === 408 || failure.status === 409 || failure.status === 425 ||
    failure.status === 429 || failure.status >= 500
  )

// Roughly four characters per token, for APIs that report no usage.
const estimateTokens = (text: string) => Math.ceil(text.length / 4)

const stripCodeFence = (content: string) => {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(content)
  return fenced?.[1] ?? content
}

// Parses and checks a reply, or says what is wrong with it. A wrapped output
// arrives as { value }.
const checkReply = <A>(
  output: Schema.Codec<A, unknown>,
  wrapped: boolean,
  reply: TransportReply
): Effect.Effect<A, string> => {
  if (reply.content === null || reply.content.trim() === "") {
    return Effect.fail(
      reply.finishReason === "length" ? "the reply was cut off before any JSON" : "the reply was empty"
    )
  }
  const parsed = Option.liftThrowable(() => JSON.parse(stripCodeFence(reply.content!)) as unknown)()
  if (Option.isNone(parsed)) {
    return Effect.fail(
      reply.finishReason === "length"
        ? "the reply was cut off at the token limit, so its JSON is incomplete"
        : "the reply was not valid JSON"
    )
  }
  const value = wrapped
    ? (typeof parsed.value === "object" && parsed.value !== null && "value" in parsed.value
      ? (parsed.value as { readonly value: unknown }).value
      : undefined)
    : parsed.value
  if (value === undefined) return Effect.fail("it did not match the schema: the value field is missing")
  return Schema.decodeUnknownEffect(Schema.toCodecJson(output))(value).pipe(
    Effect.mapError((error) => `it did not match the schema: ${error.message.slice(0, 1500)}`)
  )
}

const schemaName = (task: LlmTask) => task.replace(/[^a-zA-Z0-9_-]/g, "_")

export class LlmAdapter extends Context.Service<LlmAdapter, {
  call<A>(request: LlmRequest<A>): Effect.Effect<LlmReply<A>, LlmError>
}>()("gmat-prep/server/LlmAdapter") {
  static readonly layer = Layer.effect(
    LlmAdapter,
    Effect.gen(function*() {
      const db = yield* Db
      const settingsService = yield* Settings
      const keys = yield* ApiKeyStore
      const transport = yield* LlmTransport

      const jobSpend = (jobId: string) =>
        db.select({ spend: jobs.spend, cap: jobs.spendCap }).from(jobs).where(eq(jobs.id, jobId)).pipe(
          Effect.map((rows) => rows[0]),
          Effect.orDie
        )

      // One row per request, and the job's spend in the same transaction.
      const record = (entry: {
        readonly jobId: string | undefined
        readonly task: LlmTask
        readonly model: string
        readonly promptVersion: string
        readonly tokensIn: number
        readonly tokensOut: number
        readonly tokensEstimated: boolean
        readonly cost: number
        readonly outcome: "ok" | "invalid" | "refused" | "unavailable"
        readonly detail: string | null
      }) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          yield* db.transaction((tx) =>
            Effect.gen(function*() {
              yield* tx.insert(llmCalls).values({
                id: crypto.randomUUID(),
                jobId: entry.jobId ?? null,
                task: entry.task,
                model: entry.model,
                promptVersion: entry.promptVersion,
                tokensIn: entry.tokensIn,
                tokensOut: entry.tokensOut,
                tokensEstimated: entry.tokensEstimated,
                cost: entry.cost,
                outcome: entry.outcome,
                detail: entry.detail,
                createdAt: now
              })
              if (entry.jobId !== undefined && entry.cost > 0) {
                yield* tx.update(jobs)
                  .set({ spend: sql`${jobs.spend} + ${entry.cost}`, revision: nextRevision, updatedAt: now })
                  .where(eq(jobs.id, entry.jobId))
              }
            })
          )
        }).pipe(Effect.orDie)

      const call = <A>(request: LlmRequest<A>): Effect.Effect<LlmReply<A>, LlmError> =>
        Effect.gen(function*() {
          const settings = yield* settingsService.llm
          const apiKey = yield* keys.read
          const model = settings.models[request.task]
          const price = model === undefined ? undefined : settings.prices[model]
          if (settings.baseUrl === null || Option.isNone(apiKey) || model === undefined || price === undefined) {
            return yield* new LlmNotConfigured({
              missing: missingSettings(settings, Option.isSome(apiKey), request.task)
            })
          }

          // No request starts once the job's cap is reached, a retry included.
          const checkCap = Effect.gen(function*() {
            if (request.jobId === undefined) return
            const job = yield* jobSpend(request.jobId)
            if (job !== undefined && job.spend >= job.cap) {
              return yield* new SpendCapReached({ spend: job.spend, cap: job.cap })
            }
          })
          yield* checkCap

          // A provider or proxy may echo the key in an error; it is never stored.
          const key = Redacted.value(apiKey.value)
          const redact = (text: string) => text.split(key).join("[the API key]")

          const { jsonSchema, wrapped } = strictJsonSchema(request.output)
          const instructions = settings.jsonMode === "json-schema"
            ? "Reply with JSON only."
            : `Reply with only a JSON value that matches this JSON Schema:\n${JSON.stringify(jsonSchema)}`
          const base: ReadonlyArray<ChatMessage> = [
            { role: "system", content: `${request.system}\n\n${instructions}` },
            { role: "user", content: request.user }
          ]
          const costOf = (tokensIn: number, tokensOut: number) =>
            (tokensIn * price.input + tokensOut * price.output) / 1_000_000
          let spent = 0

          // Sends one conversation, retrying 429, 5xx and lost connections
          // with exponential backoff, jitter and the API's Retry-After.
          const send = (messages: ReadonlyArray<ChatMessage>) =>
            Effect.gen(function*() {
              for (let attempt = 1;; attempt++) {
                const outcome = yield* Effect.result(transport.complete({
                  url: completionsUrl(settings.baseUrl!),
                  apiKey: apiKey.value,
                  model,
                  messages,
                  jsonMode: settings.jsonMode,
                  schemaName: schemaName(request.task),
                  jsonSchema
                }))
                if (outcome._tag === "Success") {
                  const reply = outcome.success
                  const tokensEstimated = reply.tokensIn === null || reply.tokensOut === null
                  const tokensIn = reply.tokensIn ?? estimateTokens(messages.map((message) => message.content).join(""))
                  const tokensOut = reply.tokensOut ?? estimateTokens(reply.content ?? "")
                  return { reply, tokensIn, tokensOut, tokensEstimated, cost: costOf(tokensIn, tokensOut) }
                }
                const failure = outcome.failure
                const message = redact(failure.message)
                const unavailable = retryable(failure)
                yield* record({
                  jobId: request.jobId,
                  task: request.task,
                  model,
                  promptVersion: request.promptVersion,
                  tokensIn: 0,
                  tokensOut: 0,
                  tokensEstimated: false,
                  cost: 0,
                  outcome: unavailable ? "unavailable" : "refused",
                  detail: `${failure.status ?? (failure.sent ? "no response" : "not sent")}: ${message}`.slice(0, 500)
                })
                if (!unavailable) {
                  return yield* new LlmRefused({ status: failure.status ?? 0, message })
                }
                const waitFor = failure.retryAfterMs ?? 0
                if (attempt >= (request.attempts ?? MaxAttempts) || waitFor > MaxInlineWaitMs) {
                  return yield* new LlmUnavailable({
                    status: failure.status,
                    message,
                    retryAfterMs: failure.retryAfterMs
                  })
                }
                const jitter = 0.5 + (yield* Random.next)
                const backoff = Math.min(MaxBackoffMs, 1000 * 2 ** (attempt - 1)) * jitter
                yield* Effect.sleep(Math.max(waitFor, backoff))
              }
            })

          const attempt = (messages: ReadonlyArray<ChatMessage>) =>
            Effect.gen(function*() {
              const sent = yield* send(messages)
              spent += sent.cost
              const checked = yield* Effect.result(checkReply(request.output, wrapped, sent.reply))
              yield* record({
                jobId: request.jobId,
                task: request.task,
                model,
                promptVersion: request.promptVersion,
                tokensIn: sent.tokensIn,
                tokensOut: sent.tokensOut,
                tokensEstimated: sent.tokensEstimated,
                cost: sent.cost,
                outcome: checked._tag === "Success" ? "ok" : "invalid",
                detail: checked._tag === "Success" ? null : checked.failure.slice(0, 500)
              })
              return { sent, checked }
            })

          const first = yield* attempt(base)
          // An invalid reply gets one retry, with the reply and what was wrong,
          // unless the first attempt used up the cap.
          if (first.checked._tag === "Failure") yield* checkCap
          const final = first.checked._tag === "Success" ? first : yield* attempt([
            ...base,
            { role: "assistant", content: first.sent.reply.content ?? "" },
            {
              role: "user",
              content:
                `That reply cannot be used because ${first.checked.failure}. Reply again with only JSON that matches the required schema.`
            }
          ])
          if (final.checked._tag === "Failure") {
            return yield* new LlmInvalidReply({ problem: final.checked.failure })
          }
          const at = yield* Clock.currentTimeMillis
          return {
            value: final.checked.success,
            model,
            promptVersion: request.promptVersion,
            at,
            tokensIn: final === first ? first.sent.tokensIn : first.sent.tokensIn + final.sent.tokensIn,
            tokensOut: final === first ? first.sent.tokensOut : first.sent.tokensOut + final.sent.tokensOut,
            cost: spent
          }
        })

      return LlmAdapter.of({ call })
    })
  )
}
