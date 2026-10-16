import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { statSync } from "node:fs"
import { join, resolve, sep } from "node:path"

// Where the web app's files come from: the release build embeds them in the
// executable, and development serves web/dist from disk.
export interface WebFiles {
  // The file for a URL path, or undefined when there is none.
  readonly find: (urlPath: string) => string | undefined
}

const embedded = new Map<string, string>()

// Called by the release build's entry, before the server starts.
export const registerEmbeddedAssets = (assets: Record<string, string>) => {
  for (const [urlPath, filePath] of Object.entries(assets)) embedded.set(urlPath, filePath)
}

const embeddedFiles: WebFiles = { find: (urlPath) => embedded.get(urlPath) }

// Only regular files inside the folder; nothing reached through "..".
export const filesOnDisk = (folder: string): WebFiles => {
  const root = resolve(folder)
  return {
    find: (urlPath) => {
      const path = resolve(root, `.${urlPath}`)
      if (!path.startsWith(root + sep)) return undefined
      try {
        return statSync(path).isFile() ? path : undefined
      } catch {
        return undefined
      }
    }
  }
}

const devFiles = filesOnDisk(join(import.meta.dir, "..", "..", "..", "web", "dist"))

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

const notFound = HttpServerResponse.text("Not found", { status: 404 })

const decodePath = (pathname: string): string | undefined => {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return undefined
  }
}

// Serves the single-page app. A known file is served as it is. A path that
// names a file (under /assets, or with an extension) and has none is a 404.
// Any other path is a page of the app, so it gets index.html.
const serveWeb = (files: WebFiles) =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const urlPath = decodePath(new URL(request.url, "http://localhost").pathname)
    if (urlPath === undefined || urlPath.startsWith("/api/") || urlPath.includes("\0")) {
      return notFound
    }
    const file = files.find(urlPath === "/" ? "/index.html" : urlPath)
    if (file !== undefined) {
      return yield* serveFile(file, urlPath)
    }
    const lastSegment = urlPath.slice(urlPath.lastIndexOf("/") + 1)
    if (urlPath === "/assets" || urlPath.startsWith("/assets/") || lastSegment.includes(".")) {
      return notFound
    }
    const index = files.find("/index.html")
    if (index !== undefined) {
      return yield* serveFile(index, "/index.html")
    }
    return HttpServerResponse.text("The web app has not been built. Run: bun run build:web", { status: 404 })
  })

export const makeWebRoutes = (files: WebFiles) =>
  HttpRouter.use(Effect.fn(function*(router) {
    yield* router.add("GET", "/*", serveWeb(files))
  }))

// Embedded files when the build registered any, otherwise web/dist.
export const WebRoutes = makeWebRoutes({
  find: (urlPath) => (embedded.size > 0 ? embeddedFiles : devFiles).find(urlPath)
})
