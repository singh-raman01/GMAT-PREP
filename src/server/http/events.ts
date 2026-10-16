import { Effect, Schema, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { CuratorCookie } from "../../api/Curator.ts"
import { EventsPath, JobChanged, ServerEvent } from "../../api/Events.ts"
import { Curator } from "../curator/Curator.ts"
import { JobFeed } from "../events/JobFeed.ts"

// The Server-Sent Events stream, one per device. For now it carries job
// progress, so it needs the Curator unlocked.

const KeepAliveEvery = "20 seconds"

const encodeEvent = Schema.encodeSync(Schema.toCodecJson(ServerEvent))

const frame = (event: ServerEvent) => `data: ${JSON.stringify(encodeEvent(event))}\n\n`

const serveEvents = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const curator = yield* Curator
  const feed = yield* JobFeed
  const token = request.cookies[CuratorCookie.key] ?? ""
  const unlocked = yield* curator.check(token).pipe(
    Effect.as(true),
    Effect.catchTag("CuratorNotUnlocked", () => Effect.succeed(false))
  )
  if (!unlocked) {
    return HttpServerResponse.text("Unlock as the Curator to receive job events.", { status: 401 })
  }
  // Keep-alive comments hold the connection open. Each one also checks the
  // unlock, so the stream ends soon after the Curator locks.
  const keepAlive = Stream.tick(KeepAliveEvery).pipe(
    Stream.mapEffect(() => curator.check(token)),
    Stream.map(() => ": keep-alive\n\n")
  )
  const events = feed.changes.pipe(Stream.map((job) => frame(new JobChanged({ job }))))
  const body = Stream.concat(
    Stream.succeed("retry: 3000\n\n"),
    Stream.merge(events, keepAlive)
  ).pipe(Stream.ignore, Stream.encodeText)
  return HttpServerResponse.stream(body, {
    contentType: "text/event-stream",
    headers: { "cache-control": "no-store" }
  })
})

export const EventsRoutes = HttpRouter.use(Effect.fn(function*(router) {
  yield* router.add("GET", EventsPath, serveEvents)
}))
