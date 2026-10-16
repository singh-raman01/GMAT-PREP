import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
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
