import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import type { JsonMode } from "../src/api/Settings.ts"
import { AppConfig } from "../src/server/AppConfig.ts"
import { DatabaseLive, Db } from "../src/server/db/Database.ts"
import { llmCalls } from "../src/server/db/schema.ts"
import { JobKinds } from "../src/server/jobs/JobKind.ts"
import { JobStore } from "../src/server/jobs/JobStore.ts"
import { ConnectionTest } from "../src/server/jobs/kinds/connectionTest.ts"
import { LlmAdapter } from "../src/server/llm/LlmAdapter.ts"
import { FakeLlm, LlmTransportFake } from "../src/server/llm/LlmTransport.ts"
import { ApiKeyStore } from "../src/server/settings/ApiKeyStore.ts"
import { Settings } from "../src/server/settings/Settings.ts"
import { tempDataDir } from "./harness.ts"

// The LLM adapter over the fake transport, a real database and a fake clock.
const run = <A, E>(
  effect: Effect.Effect<A, E, LlmAdapter | FakeLlm | Settings | ApiKeyStore | JobStore | Db>
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        LlmAdapter.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(Settings.layer, ApiKeyStore.layer, JobStore.layer, LlmTransportFake)),
          Layer.provideMerge(JobKinds.layer([ConnectionTest])),
          Layer.provideMerge(DatabaseLive),
          Layer.provide(AppConfig.layer({ dataDir: tempDataDir(), preferredPort: 0 })),
          Layer.provideMerge(TestClock.layer())
        )
      )
    )
  )

const configure = (jsonMode: JsonMode = "json-schema") =>
  Effect.gen(function*() {
    const settings = yield* Settings
    const keys = yield* ApiKeyStore
    yield* settings.saveLlm({
      baseUrl: "https://api.example.com/v1/",
      jsonMode,
      models: [{ task: "tagging", model: "small-model" }],
      prices: [{ model: "small-model", inputPerMillion: 2, outputPerMillion: 8 }]
    })
    yield* keys.save("sk-test-12345678")
  })

const Output = Schema.Struct({ ok: Schema.Boolean, word: Schema.String })

const ask = (jobId?: string) =>
  Effect.gen(function*() {
    const llm = yield* LlmAdapter
    return yield* llm.call({
      task: "tagging",
      promptVersion: "test@1",
      system: "You check things.",
      user: "Say apple.",
      output: Output,
      ...(jobId === undefined ? {} : { jobId })
    })
  })

const valid = JSON.stringify({ ok: true, word: "apple" })

const calls = Effect.gen(function*() {
  const db = yield* Db
  return yield* db.select().from(llmCalls).orderBy(llmCalls.createdAt).pipe(Effect.orDie)
})

// Lets forked fibers run to their next wait.
const settle = Effect.promise(() => Bun.sleep(2))

describe("LLM adapter", () => {
  test("a valid reply is checked, priced from tokens and recorded with its model and prompt version", () =>
    run(Effect.gen(function*() {
      yield* configure()
      const fake = yield* FakeLlm
      yield* fake.reply({ content: valid, tokensIn: 1000, tokensOut: 200 })
      const reply = yield* ask()
      expect(reply.value).toEqual({ ok: true, word: "apple" })
      expect(reply.model).toBe("small-model")
      expect(reply.promptVersion).toBe("test@1")
      expect(reply.cost).toBeCloseTo((1000 * 2 + 200 * 8) / 1_000_000, 12)

      const [request] = yield* fake.requests
      expect(request?.url).toBe("https://api.example.com/v1/chat/completions")
      expect(Redacted.value(request!.apiKey)).toBe("sk-test-12345678")
      expect(request?.model).toBe("small-model")
      expect(request?.jsonMode).toBe("json-schema")
      expect(request?.jsonSchema).toMatchObject({ type: "object", required: ["ok", "word"] })

      const [recorded] = yield* calls
      expect(recorded).toMatchObject({
        task: "tagging",
        model: "small-model",
        promptVersion: "test@1",
        tokensIn: 1000,
        tokensOut: 200,
        tokensEstimated: false,
        outcome: "ok"
      })
      expect(recorded?.cost).toBeCloseTo(reply.cost, 12)
    })))

  test("an invalid reply is retried once with the reply and what was wrong with it", () =>
    run(Effect.gen(function*() {
      yield* configure()
      const fake = yield* FakeLlm
      yield* fake.reply({ content: "Sure! Here it is." }, { content: valid })
      const reply = yield* ask()
      expect(reply.value.word).toBe("apple")
      const requests = yield* fake.requests
      expect(requests).toHaveLength(2)
      const retry = requests[1]!.messages
      expect(retry.at(-2)).toEqual({ role: "assistant", content: "Sure! Here it is." })
      expect(retry.at(-1)?.content).toContain("not valid JSON")
      expect((yield* calls).map((call) => call.outcome)).toEqual(["invalid", "ok"])
    })))

  test("a second invalid reply fails the call with the problem", () =>
    run(Effect.gen(function*() {
      yield* configure()
      const fake = yield* FakeLlm
      yield* fake.reply({ content: JSON.stringify({ ok: "yes" }) }, { content: JSON.stringify({ word: 3 }) })
      const error = yield* ask().pipe(Effect.flip)
      expect(error._tag).toBe("LlmInvalidReply")
      expect(error._tag === "LlmInvalidReply" && error.problem).toContain("did not match the schema")
      expect((yield* calls).map((call) => call.outcome)).toEqual(["invalid", "invalid"])
    })))

  test("a reply in a code fence still counts", () =>
    run(Effect.gen(function*() {
      yield* configure()
      const fake = yield* FakeLlm
      yield* fake.respondWith(() => ({ content: "```json\n" + valid + "\n```" }))
      const reply = yield* ask()
      expect(reply.value.ok).toBe(true)
    })))

  test("a reply without usage figures is priced from four characters a token, and marked as estimated", () =>
    run(Effect.gen(function*() {
      yield* configure()
      const fake = yield* FakeLlm
      yield* fake.reply({ content: valid, tokensIn: null, tokensOut: null })
      const reply = yield* ask()
      const [request] = yield* fake.requests
      const sentChars = request!.messages.map((message) => message.content).join("").length
      expect(reply.tokensIn).toBe(Math.ceil(sentChars / 4))
      expect(reply.tokensOut).toBe(Math.ceil(valid.length / 4))
      const [recorded] = yield* calls
      expect(recorded).toMatchObject({ tokensEstimated: true, tokensIn: reply.tokensIn, tokensOut: reply.tokensOut })
      expect(recorded?.cost).toBeCloseTo((reply.tokensIn * 2 + reply.tokensOut * 8) / 1_000_000, 12)
    })))

  test("429 waits for the Retry-After the API gives, then tries again", () =>
    run(Effect.gen(function*() {
      yield* configure()
      const fake = yield* FakeLlm
      yield* fake.reply({ status: 429, retryAfterMs: 20_000 }, { content: valid })
      const fiber = yield* Effect.forkChild(ask())
      yield* settle
      yield* TestClock.adjust("19 seconds")
      yield* settle
      expect(fiber.pollUnsafe()).toBeUndefined()
      expect(yield* fake.requests).toHaveLength(1)
      yield* TestClock.adjust("1 second")
      yield* settle
      const reply = yield* Fiber.join(fiber)
      expect(reply.value.word).toBe("apple")
      expect((yield* calls).map((call) => call.outcome)).toEqual(["unavailable", "ok"])
    })))

  test("5xx and lost connections are retried with backoff, then the call gives up", () =>
    run(Effect.gen(function*() {
      yield* configure()
      const fake = yield* FakeLlm
      yield* fake.reply({ networkError: "connection reset" })
      yield* fake.respondWith(() => ({ status: 503, message: "overloaded" }))
      const fiber = yield* Effect.forkChild(ask())
      // The first wait is 1 second times a jitter of 0.5 to 1.5.
      yield* settle
      yield* TestClock.adjust("499 millis")
      yield* settle
      expect(yield* fake.requests).toHaveLength(1)
      yield* TestClock.adjust("1001 millis")
      yield* settle
      expect(yield* fake.requests).toHaveLength(2)
      // The second wait doubles: at least a second.
      yield* TestClock.adjust("999 millis")
      yield* settle
      expect(yield* fake.requests).toHaveLength(2)
      for (let i = 0; i < 20; i++) {
        yield* settle
        yield* TestClock.adjust("5 seconds")
      }
      const error = yield* Fiber.join(fiber).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "LlmUnavailable", status: 503, message: "overloaded" })
      expect(yield* fake.requests).toHaveLength(6)
    })))

  test("a request that could not be sent is not retried", () =>
    run(Effect.gen(function*() {
      yield* configure()
      const fake = yield* FakeLlm
      yield* fake.reply({ notSent: "the API key has characters that cannot be sent" })
      const error = yield* ask().pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "LlmRefused", status: 0 })
      expect(yield* fake.requests).toHaveLength(1)
      expect((yield* calls).map((call) => call.outcome)).toEqual(["refused"])
    })))

  test("an API key echoed in an error is never stored", () =>
    run(Effect.gen(function*() {
      yield* configure()
      const fake = yield* FakeLlm
      yield* fake.reply({ status: 401, message: "Incorrect API key provided: sk-test-12345678" })
      const error = yield* ask().pipe(Effect.flip)
      expect(JSON.stringify(error)).not.toContain("sk-test-12345678")
      const [recorded] = yield* calls
      expect(recorded?.detail).toContain("[the API key]")
      expect(recorded?.detail).not.toContain("sk-test-12345678")
    })))

  test("an output that is not an object is sent wrapped and taken back out", () =>
    run(Effect.gen(function*() {
      yield* configure()
      const fake = yield* FakeLlm
      yield* fake.reply({ content: JSON.stringify({ value: ["a", "b"] }) })
      const llm = yield* LlmAdapter
      const reply = yield* llm.call({
        task: "tagging",
        promptVersion: "test@1",
        system: "List letters.",
        user: "Two letters.",
        output: Schema.Array(Schema.String)
      })
      expect(reply.value).toEqual(["a", "b"])
      const [request] = yield* fake.requests
      expect(request?.jsonSchema).toMatchObject({ type: "object", required: ["value"] })
    })))

  test("a refused request is not retried", () =>
    run(Effect.gen(function*() {
      yield* configure()
      const fake = yield* FakeLlm
      yield* fake.reply({ status: 401, message: "Incorrect API key provided" })
      const error = yield* ask().pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "LlmRefused", status: 401, message: "Incorrect API key provided" })
      expect(yield* fake.requests).toHaveLength(1)
      expect((yield* calls).map((call) => call.outcome)).toEqual(["refused"])
    })))

  test("a Retry-After over a minute gives up at once, passing on the wait", () =>
    run(Effect.gen(function*() {
      yield* configure()
      const fake = yield* FakeLlm
      yield* fake.reply({ status: 429, retryAfterMs: 120_000 })
      const error = yield* ask().pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "LlmUnavailable", retryAfterMs: 120_000 })
      expect(yield* fake.requests).toHaveLength(1)
    })))

  test("missing settings are named, and nothing is sent", () =>
    run(Effect.gen(function*() {
      const fake = yield* FakeLlm
      const error = yield* ask().pipe(Effect.flip)
      expect(error._tag === "LlmNotConfigured" && error.missing).toEqual([
        "the API base URL",
        "the API key",
        "a model for Tagging"
      ])
      expect(yield* fake.requests).toHaveLength(0)
    })))

  test("in instructions mode the schema goes in the prompt", () =>
    run(Effect.gen(function*() {
      yield* configure("instructions")
      const fake = yield* FakeLlm
      yield* fake.reply({ content: valid })
      yield* ask()
      const [request] = yield* fake.requests
      expect(request?.jsonMode).toBe("instructions")
      expect(request?.messages[0]?.content).toContain("\"required\":[\"ok\",\"word\"]")
    })))

  test("spend counts against the job's cap, and no call starts once the cap is reached", () =>
    run(Effect.gen(function*() {
      yield* configure()
      const fake = yield* FakeLlm
      yield* fake.respondWith(() => ({ content: valid, tokensIn: 1000, tokensOut: 200 }))
      const store = yield* JobStore
      const job = yield* store.create(
        ConnectionTest,
        { task: "tagging" as const, model: "small-model", word: "apple" },
        0.005
      )
      yield* ask(job.id)
      yield* ask(job.id)
      const error = yield* ask(job.id).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "SpendCapReached", cap: 0.005 })
      expect(yield* fake.requests).toHaveLength(2)
      const [listed] = yield* store.list
      expect(listed?.spend).toBeCloseTo(0.0072, 12)
    })))

  test("the retry after an invalid reply does not start once the cap is reached", () =>
    run(Effect.gen(function*() {
      yield* configure()
      const fake = yield* FakeLlm
      const store = yield* JobStore
      const job = yield* store.create(
        ConnectionTest,
        { task: "tagging" as const, model: "small-model", word: "apple" },
        0.005
      )
      // Each reply costs $0.0036, so the invalid one passes the cap.
      yield* fake.reply({ content: valid, tokensIn: 1000, tokensOut: 200 })
      yield* fake.reply({ content: "not JSON", tokensIn: 1000, tokensOut: 200 })
      yield* ask(job.id)
      const error = yield* ask(job.id).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "SpendCapReached", cap: 0.005 })
      expect(yield* fake.requests).toHaveLength(2)
    })))
})
