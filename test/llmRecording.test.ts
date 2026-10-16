import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Redacted } from "effect"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import {
  LlmTransport,
  LlmTransportFake,
  LlmTransportRecording,
  LlmTransportReplay,
  type TransportRequest
} from "../src/server/llm/LlmTransport.ts"
import { FakeLlm } from "../src/server/llm/LlmTransport.ts"
import { tempDataDir } from "./harness.ts"

// Recorded replies let tests that need a real model's answers, such as the
// golden set, run offline at no cost after one recording run.

const request = (content: string, apiKey = "sk-one"): TransportRequest => ({
  url: "https://api.example.com/v1/chat/completions",
  apiKey: Redacted.make(apiKey),
  model: "small-model",
  messages: [{ role: "user", content }],
  jsonMode: "json-schema",
  schemaName: "tagging",
  jsonSchema: { type: "object" }
})

describe("Recorded LLM replies", () => {
  test("a recording run saves each new reply once, and a replay serves it without the network", async () => {
    const folder = tempDataDir()
    const recorded = await Effect.runPromise(
      Effect.gen(function*() {
        // One fake API, both behind the recording transport and visible here.
        const fakeServices = yield* Layer.build(LlmTransportFake)
        const fake = Context.get(fakeServices, FakeLlm)
        const recording = yield* Layer.build(
          LlmTransportRecording(folder).pipe(Layer.provide(Layer.succeed(LlmTransport, Context.get(fakeServices, LlmTransport))))
        )
        const transport = Context.get(recording, LlmTransport)
        yield* fake.reply({ content: "{\"ok\":true}", tokensIn: 7, tokensOut: 3 })
        const first = yield* transport.complete(request("hello"))
        // The same request again comes from the recording, not the live API.
        const again = yield* transport.complete(request("hello"))
        return { first, again, live: (yield* fake.requests).length }
      }).pipe(Effect.scoped)
    )
    expect(recorded.first).toEqual({ content: "{\"ok\":true}", finishReason: "stop", tokensIn: 7, tokensOut: 3 })
    expect(recorded.again).toEqual(recorded.first)
    expect(recorded.live).toBe(1)
    expect(readdirSync(folder)).toHaveLength(1)

    const replayed = await Effect.runPromise(
      Effect.gen(function*() {
        const transport = yield* LlmTransport
        // The key is not part of the recording, so another key finds it too.
        return yield* transport.complete(request("hello", "sk-two"))
      }).pipe(Effect.provide(LlmTransportReplay(folder)))
    )
    expect(replayed).toEqual(recorded.first)
  })

  test("a replay with no recording for a request says which file is missing", async () => {
    const folder = tempDataDir()
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const transport = yield* LlmTransport
        return yield* transport.complete(request("never recorded"))
      }).pipe(Effect.provide(LlmTransportReplay(folder)), Effect.sandbox, Effect.flip)
    )
    expect(String(failure)).toContain(join(folder, ""))
    expect(String(failure)).toContain("No recorded reply")
  })
})
