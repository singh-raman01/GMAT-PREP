import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest, HttpServer } from "effect/http"
import { runWithApp } from "./harness.ts"

// A web page on another site can point its own host name at 127.0.0.1 (DNS
// rebinding) and reach the app with that name in the Host header. The app
// answers only to the names of this computer.

const statusFor = (path: string, host: string) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(HttpClientRequest.get(path).pipe(HttpClientRequest.setHeader("host", host)))
    return response.status
  })

describe("Host check", () => {
  test("a request that names another host is refused", () =>
    runWithApp(Effect.gen(function*() {
      expect(yield* statusFor("/api/health", "evil.example")).toBe(403)
      expect(yield* statusFor("/api/profiles", "evil.example:4747")).toBe(403)
      expect(yield* statusFor("/", "127.0.0.1.evil.example")).toBe(403)
    })))

  test("this computer's names are accepted, with or without a port", () =>
    runWithApp(Effect.gen(function*() {
      for (const host of ["127.0.0.1:4747", "localhost:4747", "LOCALHOST", "[::1]:4747", "127.0.0.1"]) {
        expect(yield* statusFor("/api/health", host)).toBe(200)
      }
    })))

  test("every response forbids type sniffing and framing", () =>
    runWithApp(Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      // "/" is the web app, or a 404 when it has not been built; either way it
      // gets the headers.
      const requests = [
        HttpClientRequest.get("/"),
        HttpClientRequest.get("/api/health"),
        HttpClientRequest.get("/api/nothing-here"),
        HttpClientRequest.get("/api/health").pipe(HttpClientRequest.setHeader("host", "evil.example")),
        HttpClientRequest.post("/api/profiles").pipe(HttpClientRequest.bodyJsonUnsafe({ name: "Asha", pin: "1" }))
      ]
      const statuses: Array<number> = []
      for (const request of requests) {
        const response = yield* client.execute(request)
        statuses.push(response.status)
        expect(response.headers["x-content-type-options"]).toBe("nosniff")
        expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'")
        expect(response.headers["referrer-policy"]).toBe("no-referrer")
      }
      expect(statuses.slice(1)).toEqual([200, 404, 403, 400])
    })))
})

// SameSite cookies stop other sites from using a Profile's unlock, but not
// pages on other ports of this computer, and not writes that need no unlock,
// such as creating a Profile. Browsers name the page in Origin, so writes are
// accepted only from the app's own origin, and only as JSON.
describe("Cross-site writes", () => {
  const ownOrigin = Effect.gen(function*() {
    const server = yield* HttpServer.HttpServer
    const address = server.address as { readonly port: number }
    return `http://127.0.0.1:${address.port}`
  })

  const createProfile = (headers: Record<string, string>, body: string) =>
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(
        HttpClientRequest.post("/api/profiles").pipe(
          HttpClientRequest.setHeaders(headers),
          HttpClientRequest.bodyText(body, headers["content-type"] ?? "")
        )
      )
      return response.status
    })

  const profileCount = Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(HttpClientRequest.get("/api/profiles"))
    return ((yield* response.json) as ReadonlyArray<unknown>).length
  })

  const json = JSON.stringify({ name: "Asha" })

  test("a write from another site or another port of this computer is refused", () =>
    runWithApp(Effect.gen(function*() {
      const type = { "content-type": "application/json" }
      expect(yield* createProfile({ ...type, origin: "https://evil.example" }, json)).toBe(403)
      expect(yield* createProfile({ ...type, origin: "http://127.0.0.1:3000" }, json)).toBe(403)
      expect(yield* createProfile({ ...type, origin: "null" }, json)).toBe(403)
      expect(yield* profileCount).toBe(0)
    })))

  test("a write from the app's own origin, or from a tool that names none, is accepted", () =>
    runWithApp(Effect.gen(function*() {
      const type = { "content-type": "application/json" }
      expect(yield* createProfile({ ...type, origin: yield* ownOrigin }, json)).toBe(200)
      expect(yield* createProfile(type, JSON.stringify({ name: "Ravi" }))).toBe(200)
      expect(yield* profileCount).toBe(2)
    })))

  test("a write whose body is not JSON is refused", () =>
    runWithApp(Effect.gen(function*() {
      expect(yield* createProfile({ "content-type": "text/plain" }, json)).toBe(415)
      expect(yield* createProfile({ "content-type": "application/x-www-form-urlencoded" }, "name=Asha")).toBe(415)
      // A cross-site fetch in no-cors mode can send a body with no type at all.
      const origin = yield* ownOrigin
      const untyped = yield* Effect.promise(() =>
        fetch(`${origin}/api/profiles`, { method: "POST", body: new Blob([json]) }).then((response) => response.status)
      )
      expect(untyped).toBe(415)
      expect(yield* profileCount).toBe(0)
    })))

  test("a JSON body over 1 MB is refused", () =>
    runWithApp(Effect.gen(function*() {
      const huge = JSON.stringify({ name: "Asha", pin: "1".repeat(1_100_000) })
      expect(yield* createProfile({ "content-type": "application/json" }, huge)).toBe(413)
    })))
})
