import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { existsSync } from "node:fs"
import { join } from "node:path"

// URL path to file path. The release build registers the web app files it
// embeds in the executable; development serves web/dist from disk.
const embedded = new Map<string, string>()

export const registerEmbeddedAssets = (assets: Record<string, string>) => {
  for (const [urlPath, filePath] of Object.entries(assets)) embedded.set(urlPath, filePath)
}

const diskRoot = join(import.meta.dir, "..", "..", "..", "web", "dist")

const resolveFile = (urlPath: string): string | undefined => {
  const fromEmbedded = embedded.get(urlPath)
  if (fromEmbedded !== undefined) return fromEmbedded
  if (embedded.size > 0 || urlPath.includes("..")) return undefined
  const onDisk = join(diskRoot, urlPath)
  return existsSync(onDisk) ? onDisk : undefined
}

const serveFile = (file: string, urlPath: string) =>
  Effect.promise(() => Bun.file(file).bytes()).pipe(
    Effect.map((bytes) =>
      HttpServerResponse.uint8Array(bytes, {
        contentType: Bun.file(file).type,
        headers: {
          "cache-control": urlPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache"
        }
      })
    )
  )

// Serves the single-page app: known files as they are, every other path as
// index.html so client-side routes work. Unknown /api paths stay 404.
const serveWeb = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const urlPath = new URL(request.url, "http://localhost").pathname
  if (urlPath.startsWith("/api/")) {
    return HttpServerResponse.text("Not found", { status: 404 })
  }
  const file = resolveFile(urlPath === "/" ? "/index.html" : urlPath)
  if (file !== undefined) {
    return yield* serveFile(file, urlPath)
  }
  const index = resolveFile("/index.html")
  if (index !== undefined) {
    return yield* serveFile(index, "/index.html")
  }
  return HttpServerResponse.text("The web app has not been built. Run: bun run build:web", { status: 404 })
})

export const WebRoutes = HttpRouter.use(Effect.fn(function*(router) {
  yield* router.add("GET", "/*", serveWeb)
}))
