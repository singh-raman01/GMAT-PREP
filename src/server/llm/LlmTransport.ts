import { Clock, Context, Effect, Layer, Option, Redacted, Ref, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { JsonMode } from "../../api/Settings.ts"
import { sha256 } from "../access/tokens.ts"

// One request to an OpenAI-compatible chat completions endpoint, and its reply.
// The adapter decides what to retry; the transport only reports what happened.

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant"
  readonly content: string
}

export interface TransportRequest {
  readonly url: string
  readonly apiKey: Redacted.Redacted<string>
  readonly model: string
  readonly messages: ReadonlyArray<ChatMessage>
  readonly jsonMode: JsonMode
  readonly schemaName: string
  readonly jsonSchema: object
}

export interface TransportReply {
  readonly content: string | null
  readonly finishReason: string | null
  readonly tokensIn: number | null
  readonly tokensOut: number | null
}

// status is null when no response arrived: a network error or a timeout.
export class TransportFailure extends Schema.TaggedError<TransportFailure>()("TransportFailure", {
  status: Schema.NullOr(Schema.Int),
  retryAfterMs: Schema.NullOr(Schema.Number),
  message: Schema.String
}) {}

export class LlmTransport extends Context.Service<LlmTransport, {
  complete(request: TransportRequest): Effect.Effect<TransportReply, TransportFailure>
}>()("gmat-prep/server/LlmTransport") {}

const RequestTimeout = "180 seconds"

// Retry-After is either seconds or an HTTP date.
export const parseRetryAfter = (header: string | undefined, now: number): number | null => {
  if (header === undefined || header.trim() === "") return null
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  return Number.isNaN(date) ? null : Math.max(0, date - now)
}

// Providers put the reason in error.message; otherwise the start of the body.
const errorMessage = (body: string): string => {
  try {
    const parsed = JSON.parse(body) as { readonly error?: { readonly message?: unknown } | string }
    if (typeof parsed.error === "string") return parsed.error
    if (typeof parsed.error?.message === "string") return parsed.error.message
  } catch {
    // Not JSON.
  }
  return body.trim().slice(0, 300) || "no details"
}

const Completion = Schema.Struct({
  choices: Schema.Array(Schema.Struct({
    message: Schema.optional(Schema.Struct({ content: Schema.optional(Schema.NullOr(Schema.String)) })),
    finish_reason: Schema.optional(Schema.NullOr(Schema.String))
  })),
  usage: Schema.optional(Schema.NullOr(Schema.Struct({
    prompt_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
    completion_tokens: Schema.optional(Schema.NullOr(Schema.Number))
  })))
})
const decodeCompletion = Schema.decodeUnknownOption(Completion)

const requestBody = (request: TransportRequest) => ({
  model: request.model,
  messages: request.messages,
  ...(request.jsonMode === "json-schema"
    ? {
      response_format: {
        type: "json_schema",
        json_schema: { name: request.schemaName, strict: true, schema: request.jsonSchema }
      }
    }
    : request.jsonMode === "json-object"
    ? { response_format: { type: "json_object" } }
    : {})
})

// The live transport, over HTTP.
export const LlmTransportHttp = Layer.effect(
  LlmTransport,
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const complete = Effect.fn("LlmTransport.complete")(function*(request: TransportRequest) {
      const response = yield* client.execute(
        HttpClientRequest.post(request.url).pipe(
          HttpClientRequest.bearerToken(request.apiKey),
          HttpClientRequest.bodyJsonUnsafe(requestBody(request))
        )
      ).pipe(
        Effect.timeoutOrElse({
          duration: RequestTimeout,
          orElse: () => Effect.fail(new TransportFailure({ status: null, retryAfterMs: null, message: "timed out" }))
        }),
        Effect.catchTag(
          "HttpClientError",
          (error) => Effect.fail(new TransportFailure({ status: null, retryAfterMs: null, message: error.message }))
        )
      )
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      if (response.status < 200 || response.status >= 300) {
        const now = yield* Clock.currentTimeMillis
        return yield* new TransportFailure({
          status: response.status,
          retryAfterMs: parseRetryAfter(response.headers["retry-after"], now),
          message: errorMessage(body)
        })
      }
      const parsed = Option.flatMap(
        Option.liftThrowable(() => JSON.parse(body) as unknown)(),
        (json) => decodeCompletion(json)
      )
      if (Option.isNone(parsed)) {
        return { content: null, finishReason: "unreadable response", tokensIn: null, tokensOut: null }
      }
      const choice = parsed.value.choices[0]
      return {
        content: choice?.message?.content ?? null,
        finishReason: choice?.finish_reason ?? null,
        tokensIn: parsed.value.usage?.prompt_tokens ?? null,
        tokensOut: parsed.value.usage?.completion_tokens ?? null
      }
    })
    return LlmTransport.of({ complete })
  })
)

// A fake for tests: replies are queued by the test, and requests are kept so
// the test can check what was sent.
export type FakeOutcome =
  | { readonly content: string; readonly tokensIn?: number; readonly tokensOut?: number; readonly finishReason?: string }
  | { readonly status: number; readonly retryAfterMs?: number; readonly message?: string }
  | { readonly networkError: string }

export class FakeLlm extends Context.Service<FakeLlm, {
  reply(...outcomes: ReadonlyArray<FakeOutcome>): Effect.Effect<void>
  // Answers every request that finds the queue empty.
  respondWith(responder: (request: TransportRequest) => FakeOutcome): Effect.Effect<void>
  readonly requests: Effect.Effect<ReadonlyArray<TransportRequest>>
}>()("gmat-prep/server/FakeLlm") {}

const toResult = (outcome: FakeOutcome): Effect.Effect<TransportReply, TransportFailure> => {
  if ("content" in outcome) {
    return Effect.succeed({
      content: outcome.content,
      finishReason: outcome.finishReason ?? "stop",
      tokensIn: outcome.tokensIn ?? 100,
      tokensOut: outcome.tokensOut ?? 20
    })
  }
  if ("status" in outcome) {
    return Effect.fail(
      new TransportFailure({
        status: outcome.status,
        retryAfterMs: outcome.retryAfterMs ?? null,
        message: outcome.message ?? `status ${outcome.status}`
      })
    )
  }
  return Effect.fail(new TransportFailure({ status: null, retryAfterMs: null, message: outcome.networkError }))
}

export const LlmTransportFake = Effect.gen(function*() {
  const queue = yield* Ref.make<ReadonlyArray<FakeOutcome>>([])
  const responder = yield* Ref.make<Option.Option<(request: TransportRequest) => FakeOutcome>>(Option.none())
  const sent = yield* Ref.make<ReadonlyArray<TransportRequest>>([])

  const complete = (request: TransportRequest) =>
    Effect.gen(function*() {
      yield* Ref.update(sent, (all) => [...all, request])
      const next = yield* Ref.modify(queue, (all) => [all[0], all.slice(1)] as const)
      if (next !== undefined) return yield* toResult(next)
      const fallback = yield* Ref.get(responder)
      if (Option.isSome(fallback)) return yield* toResult(fallback.value(request))
      return yield* Effect.die(new Error(`FakeLlm has no reply for a ${request.schemaName} request`))
    })

  const fake = FakeLlm.of({
    reply: (...outcomes) => Ref.update(queue, (all) => [...all, ...outcomes]),
    respondWith: (respond) => Ref.set(responder, Option.some(respond)),
    requests: Ref.get(sent)
  })
  return Context.make(LlmTransport, LlmTransport.of({ complete })).pipe(Context.add(FakeLlm, fake))
}).pipe(Layer.effectContext)

// Replies recorded to files, keyed by a hash of the request without the key.
// Replay never touches the network. Recording calls the live transport once
// per new request and saves its reply for every later run.
export const recordingKey = (request: TransportRequest) =>
  sha256(
    JSON.stringify({
      model: request.model,
      messages: request.messages,
      jsonMode: request.jsonMode,
      schemaName: request.schemaName,
      jsonSchema: request.jsonSchema
    })
  )

const recordingFile = (directory: string, request: TransportRequest) =>
  join(directory, `${recordingKey(request)}.json`)

const readRecording = (file: string): Option.Option<TransportReply> =>
  existsSync(file) ? Option.some(JSON.parse(readFileSync(file, "utf8")) as TransportReply) : Option.none()

export const LlmTransportReplay = (directory: string) =>
  Layer.succeed(
    LlmTransport,
    LlmTransport.of({
      complete: (request) => {
        const file = recordingFile(directory, request)
        const recorded = readRecording(file)
        return Option.isSome(recorded)
          ? Effect.succeed(recorded.value)
          : Effect.die(new Error(`No recorded reply for this ${request.schemaName} request: ${file}`))
      }
    })
  )

// Requires the live transport underneath.
export const LlmTransportRecording = (directory: string) =>
  Layer.effect(
    LlmTransport,
    Effect.gen(function*() {
      const live = yield* LlmTransport
      const complete = Effect.fn("LlmTransport.recording")(function*(request: TransportRequest) {
        const file = recordingFile(directory, request)
        const recorded = readRecording(file)
        if (Option.isSome(recorded)) return recorded.value
        const reply = yield* live.complete(request)
        yield* Effect.sync(() => {
          mkdirSync(directory, { recursive: true })
          writeFileSync(file, JSON.stringify(reply, null, 2))
        })
        return reply
      })
      return LlmTransport.of({ complete })
    })
  )
