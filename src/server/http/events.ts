import { Effect, Schema, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { CuratorCookie } from "../../api/Curator.ts"
import { EventsPath, JobChanged, ServerEvent } from "../../api/Events.ts"
import { Curator } from "../curator/Curator.ts"
import { JobFeed } from "../events/JobFeed.ts"

// The Server-Sent Events stream, one per device. For now it carries job
// progress, so it needs the Curator unlocked.
//
// Each event's id is the job revision it carries. A page that has just read
// the job list opens the stream with ?since= the highest revision in that
// list, and a browser that reconnects sends the last id it received as
// Last-Event-ID, so no change falls between the two.

const KeepAliveEvery = "20 seconds"

const encodeEvent = Schema.encodeSync(Schema.toCodecJson(ServerEvent))

const frame = (event: JobChanged) => `id: ${event.job.revision}\ndata: ${JSON.stringify(encodeEvent(event))}\n\n`

const revisionOf = (text: string | null | undefined): number | undefined => {
  if (text === null || text === undefined || !/^\d{1,15}$/.test(text.trim())) return undefined
  return Number(text.trim())
}

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
  const since = revisionOf(request.headers["last-event-id"]) ??
    revisionOf(new URL(request.url, "http://localhost").searchParams.get("since"))
  // Keep-alive comments hold the connection open. Each one also checks the
  // unlock without counting as use, so an open stream neither keeps the
  // Curator unlocked nor outlives a lock. A stream to another device ends at
  // once when its access does, as every response to one does (guard.ts).
  const keepAlive = Stream.tick(KeepAliveEvery).pipe(
    Stream.mapEffect(() =>
      curator.stillUnlocked(token).pipe(
        Effect.flatMap((live) => live ? Effect.void : Effect.fail("locked" as const))
      )
    ),
    Stream.map(() => ": keep-alive\n\n")
  )
  const events = feed.changesAfter(since).pipe(Stream.map((job) => frame(new JobChanged({ job }))))
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
