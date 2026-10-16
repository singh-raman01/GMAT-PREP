import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { HttpServer } from "effect/http"
import { ServerEvent } from "../src/api/Events.ts"
import { FakeLlm } from "../src/server/llm/LlmTransport.ts"
import { ApiKeyStore } from "../src/server/settings/ApiKeyStore.ts"
import { Settings } from "../src/server/settings/Settings.ts"
import { advanceUntil, openInspectableBrowser, runWithWorker, runWithWorkers } from "./harness.ts"

const decodeEvent = Schema.decodeUnknownSync(Schema.toCodecJson(ServerEvent))

// Reads a Server-Sent Events stream in the background and keeps its events,
// each with the id it came with.
const listen = (url: string, headers: Record<string, string>) => {
  const events: Array<ServerEvent> = []
  const ids: Array<string> = []
  let ended = false
  const controller = new AbortController()
  const done = fetch(url, { headers, signal: controller.signal }).then(async (response) => {
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ""
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        ended = true
        return
      }
      buffer += value
      const frames = buffer.split("\n\n")
      buffer = frames.pop() ?? ""
      for (const frame of frames) {
        const lines = frame.split("\n")
        const data = lines.find((line) => line.startsWith("data: "))
        const id = lines.find((line) => line.startsWith("id: "))
        if (data !== undefined) {
          events.push(decodeEvent(JSON.parse(data.slice(6))))
          ids.push(id?.slice(4) ?? "")
        }
      }
    }
  }).catch(() => {})
  return { events, ids, ended: () => ended, close: () => controller.abort(), done }
}

const configure = Effect.gen(function*() {
  const settings = yield* Settings
  yield* settings.saveLlm({
    baseUrl: "https://api.example.com/v1",
    jsonMode: "json-schema",
    models: [{ task: "tagging", model: "small-model" }],
    prices: [{ model: "small-model", inputPerMillion: 2, outputPerMillion: 8 }]
  })
  yield* (yield* ApiKeyStore).save("sk-test-12345678")
})

// A Curator browser, and the address and cookie to open a stream with.
const openCurator = Effect.gen(function*() {
  const curator = yield* openInspectableBrowser
  yield* curator.api.curatorAccess.setPassphrase({ payload: { passphrase: "correct horse battery" } })
  const token = Option.getOrThrow(yield* curator.cookie("gp_curator"))
  const server = yield* HttpServer.HttpServer
  const { port } = server.address as { readonly port: number }
  return { api: curator.api, url: `http://127.0.0.1:${port}/api/events`, cookie: `gp_curator=${token}` }
})

describe("The events stream", () => {
  test("carries job progress to the jobs screen as it happens", () =>
    runWithWorker(Effect.gen(function*() {
      yield* configure
      const fake = yield* FakeLlm
      yield* fake.respondWith((request) => {
        const word = /word set to "([a-z]+)"/.exec(request.messages.at(-1)?.content ?? "")?.[1] ?? ""
        return { content: JSON.stringify({ ok: true, word }) }
      })

      const curator = yield* openCurator
      const stream = listen(curator.url, { cookie: curator.cookie })

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
      expect(stream.ids).toEqual(revisions.map(String))
      expect(stream.events.at(-1)?.job).toMatchObject({ id: job.id, status: "done" })
    })))

  test("a stream opened after the job list sends every change since the list, even one before the stream", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* configure
      const curator = yield* openCurator
      const job = yield* curator.api.jobs.testConnection({ payload: { task: "tagging" } })
      const listed = yield* curator.api.jobs.list()
      const since = Math.max(...listed.map((each) => each.revision))
      // The job changes between the list and the stream.
      yield* curator.api.jobs.cancel({ params: { id: job.id } })

      const byQuery = listen(`${curator.url}?since=${since}`, { cookie: curator.cookie })
      // A browser reconnecting names the last event it received instead.
      const byHeader = listen(curator.url, { cookie: curator.cookie, "last-event-id": String(since) })
      yield* advanceUntil(
        Effect.sync(() => (byQuery.events.length > 0 && byHeader.events.length > 0 ? true : undefined)),
        { step: "500 millis" }
      )
      byQuery.close()
      byHeader.close()
      for (const stream of [byQuery, byHeader]) {
        expect(stream.events[0]?.job).toMatchObject({ id: job.id, status: "cancelled" })
      }
    })))

  test("the stream ends soon after the Curator locks", () =>
    runWithWorkers(Effect.gen(function*() {
      const curator = yield* openCurator
      const stream = listen(curator.url, { cookie: curator.cookie })
      yield* advanceUntil(Effect.succeed(true), { maxSteps: 1 })
      yield* curator.api.curatorSession.lock()
      yield* advanceUntil(Effect.sync(() => (stream.ended() ? true : undefined)), { step: "5 seconds" })
      expect(stream.ended()).toBe(true)
    })))
})
