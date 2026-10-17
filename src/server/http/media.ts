import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { CuratorCookie } from "../../api/Curator.ts"
import { ProfileCookie } from "../../api/Profiles.ts"
import { FigureFiles } from "../books/FigureFiles.ts"
import { renderChart } from "../charts/charts.ts"
import { Curator } from "../curator/Curator.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { decodeFigure, storedStimulus } from "../stimuli/stimuli.ts"

// Charts and figures as images, for an unlocked Profile or the Curator. They
// are files, not data: URLs, which the app's content policy refuses. Each is
// Book content, so browsers do not keep it after the tab locks.

const unlocked = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const profile = yield* (yield* Profiles).fromToken(request.cookies[ProfileCookie.key] ?? "").pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false))
  )
  if (profile) return true
  return yield* (yield* Curator).check(request.cookies[CuratorCookie.key] ?? "").pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false))
  )
})

// Drawing a chart takes tens of milliseconds, so the last ones drawn are
// kept, by the Stimulus as stored.
const drawn = new Map<string, string>()
const KeepDrawn = 100

const keepDrawn = (key: string, svg: string) => {
  drawn.set(key, svg)
  if (drawn.size > KeepDrawn) drawn.delete(drawn.keys().next().value!)
}

const headers = {
  "cache-control": "no-store",
  // An image cannot run scripts; a drawn chart may style its own text.
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'"
}

const serveStimulusImage = Effect.gen(function*() {
  if (!(yield* unlocked)) return HttpServerResponse.text("Unlock a Profile to see this.", { status: 401 })
  const params = yield* HttpRouter.params
  const found = yield* storedStimulus(params["id"] ?? "").pipe(Effect.orDie)
  if (found === undefined) return HttpServerResponse.text("There is no such image.", { status: 404 })
  const { row, dataset } = found
  if (row.kind === "chart" && row.chartSpec !== null && dataset !== null) {
    const key = `${row.id}|${row.datasetId}|${row.chartSpec}`
    const svg = drawn.get(key) ?? (yield* renderChart(JSON.parse(row.chartSpec), dataset).pipe(
      Effect.tap((made) => Effect.sync(() => keepDrawn(key, made))),
      Effect.orElseSucceed(() => undefined)
    ))
    if (svg === undefined) return HttpServerResponse.text("This chart could not be drawn.", { status: 500 })
    return HttpServerResponse.text(svg, { contentType: "image/svg+xml", headers })
  }
  if (row.kind === "figure" && row.figure !== null) {
    const png = yield* (yield* FigureFiles).read(decodeFigure(row.figure).file)
    if (png === undefined) return HttpServerResponse.text("The figure's image is missing.", { status: 404 })
    return HttpServerResponse.uint8Array(png, { contentType: "image/png", headers })
  }
  return HttpServerResponse.text("There is no such image.", { status: 404 })
})

export const MediaRoutes = HttpRouter.use(Effect.fn(function*(router) {
  yield* router.add("GET", "/api/media/stimuli/:id", serveStimulusImage)
}))
