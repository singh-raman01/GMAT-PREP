import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HttpRouter } from "effect/http"
import { filesOnDisk, makeWebRoutes } from "../src/server/http/web.ts"

// The web app's files, served from a folder laid out as Vite builds it.
const serve = () => {
  const outside = mkdtempSync(join(tmpdir(), "gmat-prep-web-"))
  const root = join(outside, "dist")
  mkdirSync(join(root, "assets", "nested"), { recursive: true })
  writeFileSync(join(root, "index.html"), "<!doctype html><title>GMAT prep</title>")
  writeFileSync(join(root, "assets", "app-1234.js"), "console.log(1)")
  writeFileSync(join(outside, "secret.txt"), "not for the web")
  const { handler, dispose } = HttpRouter.toWebHandler(makeWebRoutes(filesOnDisk(root)), { disableLogger: true })
  const get = async (path: string) => {
    const response = await handler(new Request(`http://127.0.0.1${path}`))
    return { status: response.status, type: response.headers.get("content-type") ?? "", body: await response.text(), cache: response.headers.get("cache-control") }
  }
  return { get, dispose }
}

describe("Web app files", () => {
  test("pages are the app, and its files are served with long caching", async () => {
    const web = serve()
    const home = await web.get("/")
    expect(home.status).toBe(200)
    expect(home.type).toContain("text/html")
    const route = await web.get("/curator/jobs")
    expect(route.body).toBe(home.body)
    const script = await web.get("/assets/app-1234.js")
    expect(script.status).toBe(200)
    expect(script.cache).toContain("immutable")
    expect(home.cache).toBe("no-cache")
    await web.dispose()
  })

  test("a missing file is a 404, not the app's page", async () => {
    const web = serve()
    for (const path of ["/assets/missing.js", "/assets", "/assets/nested", "/favicon.ico", "/api/unknown"]) {
      expect({ path, status: (await web.get(path)).status }).toEqual({ path, status: 404 })
    }
    await web.dispose()
  })

  test("paths cannot reach files outside the app's folder", async () => {
    const web = serve()
    for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/assets/..%5c..%5csecret.txt"]) {
      const response = await web.get(path)
      expect(response.body).not.toContain("not for the web")
    }
    await web.dispose()
  })
})
