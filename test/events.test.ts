import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { HttpServer } from "effect/http"
import { ServerEvent } from "../src/api/Events.ts"
import { FakeLlm } from "../src/server/llm/LlmTransport.ts"
import { ApiKeyStore } from "../src/server/settings/ApiKeyStore.ts"
import { Settings } from "../src/server/settings/Settings.ts"
import { advanceUntil, openInspectableBrowser, runWithWorker } from "./harness.ts"

const decodeEvent = Schema.decodeUnknownSync(Schema.toCodecJson(ServerEvent))

// Reads a Server-Sent Events stream in the background and keeps its events.
const listen = (url: string, cookie: string) => {
  const events: Array<ServerEvent> = []
  const controller = new AbortController()
  const done = fetch(url, { headers: { cookie }, signal: controller.signal }).then(async (response) => {
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ""
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += value
      const frames = buffer.split("\n\n")
      buffer = frames.pop() ?? ""
      for (const frame of frames) {
        const data = frame.split("\n").find((line) => line.startsWith("data: "))
        if (data !== undefined) events.push(decodeEvent(JSON.parse(data.slice(6))))
      }
    }
  }).catch(() => {})
  return { events, close: () => controller.abort(), done }
}

describe("The events stream", () => {
  test("carries job progress to the jobs screen as it happens", () =>
    runWithWorker(Effect.gen(function*() {
      const settings = yield* Settings
      yield* settings.saveLlm({
        baseUrl: "https://api.example.com/v1",
        jsonMode: "json-schema",
        models: [{ task: "tagging", model: "small-model" }],
        prices: [{ model: "small-model", inputPerMillion: 2, outputPerMillion: 8 }]
      })
      yield* (yield* ApiKeyStore).save("sk-test-12345678")
      const fake = yield* FakeLlm
      yield* fake.respondWith((request) => {
        const word = /word set to "([a-z]+)"/.exec(request.messages.at(-1)?.content ?? "")?.[1] ?? ""
        return { content: JSON.stringify({ ok: true, word }) }
      })

      const curator = yield* openInspectableBrowser
      yield* curator.api.curatorAccess.setPassphrase({ payload: { passphrase: "correct horse battery" } })
      const token = Option.getOrThrow(yield* curator.cookie("gp_curator"))
      const server = yield* HttpServer.HttpServer
      const { port } = server.address as { readonly port: number }
      const stream = listen(`http://127.0.0.1:${port}/api/events`, `gp_curator=${token}`)

      const job = yield* curator.api.jobs.testConnection({ payload: { task: "tagging" } })
      yield* advanceUntil(
        Effect.sync(() =>
          stream.events.some((event) => event.job.id === job.id && event.job.status === "done") ? true : undefined
        ),
        { step: "500 millis" }
      )
      stream.close()
      const revisions = stream.events.map((event) => event.job.revision)
      expect(revisions).toEqual([...revisions].sort((a, b) => a - b))
      expect(stream.events.at(-1)?.job).toMatchObject({ id: job.id, status: "done" })
    })))
})
