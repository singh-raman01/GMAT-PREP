import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, PubSub, Ref, type Scope, Stream, SubscriptionRef } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LanAccess, type Listening } from "../src/server/access/LanAccess.ts"
import { Network } from "../src/server/access/Network.ts"
import { CloseWaitMs, lanListeners } from "../src/server/http/listeners.ts"

// LAN mode's listeners on their own (decisions 120 and 123), over two
// loopback addresses that stand in for this computer's network addresses,
// with LAN mode and revocations as the test makes them.

const First = "127.0.0.2"
const Second = "127.0.0.3"
const BigBytes = 64 * 1024 * 1024

const sleep = (ms: number) => Effect.promise(() => Bun.sleep(ms))

// /peer answers with the address the request came from, /slow takes 10
// seconds, and /big sends a large file, as a download of the install would.
const listening = (download: string) =>
  Effect.gen(function*() {
    const mode = yield* SubscriptionRef.make(false)
    const revocations = yield* PubSub.unbounded<void>()
    const reported = yield* Ref.make<Listening>({ port: 0, addresses: [], problems: [] })
    const probe = Bun.serve({ hostname: First, port: 0, fetch: () => new Response() })
    const port = probe.port!
    probe.stop(true)
    const access = Layer.succeed(LanAccess, {
      mode: SubscriptionRef.changes(mode),
      revocations: Stream.fromPubSub(revocations),
      reportListening: (now: Listening) => Ref.set(reported, now)
    } as unknown as LanAccess["Service"])
    const network = Layer.succeed(Network, Network.of({
      addresses: () => [
        { address: First, family: "IPv4", internal: false },
        { address: Second, family: "IPv4", internal: false }
      ],
      hostname: () => "study-pc",
      remoteOf: (request) => Option.getOrUndefined(request.remoteAddress)
    }))
    const app = Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (request.url === "/peer") return HttpServerResponse.text(Option.getOrElse(request.remoteAddress, () => "unknown"))
      if (request.url === "/slow") return yield* sleep(10_000).pipe(Effect.as(HttpServerResponse.text("late")))
      return HttpServerResponse.raw(Bun.file(download))
    })
    yield* lanListeners(app, { port, maxRequestBodySize: 1024 }).pipe(Effect.provide(Layer.mergeAll(access, network)))
    return { mode, reported, port, revoke: PubSub.publish(revocations, undefined) }
  })

// Runs a test with a file of the given size to download.
const withFile = <A>(bytes: number, body: (file: string) => Effect.Effect<A, never, Scope.Scope>) => {
  const folder = mkdtempSync(join(tmpdir(), "gmat-prep-test-listeners-"))
  const file = join(folder, "download.bin")
  writeFileSync(file, new Uint8Array(bytes))
  return Effect.runPromise(Effect.scoped(body(file))).finally(() => rmSync(folder, { recursive: true, force: true }))
}

const accepts = (host: string, port: number) =>
  Effect.promise(() =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port })
      socket.on("connect", () => {
        socket.destroy()
        resolve(true)
      })
      socket.on("error", () => resolve(false))
    })
  )

const waitFor = (check: Effect.Effect<boolean>, ms: number) =>
  Effect.gen(function*() {
    for (let waited = 0; waited < ms; waited += 50) {
      if (yield* check) return true
      yield* sleep(50)
    }
    return false
  })

// A connection that sends what it is given, then records what comes back and
// when it closes.
const connection = (host: string, port: number, sent: string, options: { readonly paused?: boolean; readonly from?: string } = {}) =>
  Effect.promise(() =>
    new Promise<{ readonly socket: net.Socket; readonly received: () => string; readonly bytes: () => number; readonly closedAt: () => number | undefined }>((resolve) => {
      const socket = net.connect({ host, port, ...(options.from === undefined ? {} : { localAddress: options.from }) })
      let text = ""
      let bytes = 0
      let closedAt: number | undefined
      socket.on("data", (chunk) => {
        bytes += chunk.length
        if (text.length < 4096) text += chunk.toString("latin1")
      })
      socket.on("error", () => {})
      socket.on("close", () => (closedAt = performance.now()))
      socket.on("connect", () => {
        socket.write(sent)
        if (options.paused === true) socket.pause()
        resolve({ socket, received: () => text, bytes: () => bytes, closedAt: () => closedAt })
      })
    })
  )

describe("LAN mode's listeners", () => {
  test("listen on each network address while LAN mode is on, and give the app the address a request came from", () =>
    withFile(1, (file) =>
      Effect.gen(function*() {
        const { mode, reported, port } = yield* listening(file)
        yield* SubscriptionRef.set(mode, true)
        expect(yield* waitFor(accepts(Second, port), 3000)).toBe(true)
        expect(yield* Ref.get(reported)).toEqual({ port, addresses: [First, Second], problems: [] })
        const asked = yield* connection(First, port, `GET /peer HTTP/1.1\r\nHost: ${First}:${port}\r\nConnection: close\r\n\r\n`, { from: "127.0.0.9" })
        yield* waitFor(Effect.sync(() => asked.closedAt() !== undefined), 3000)
        expect(asked.received().split("\r\n\r\n")[1]).toBe("127.0.0.9")
      })
    ))

  test("turned off, stop taking connections at once, give a request still being answered 3 seconds, and close the rest at once", () =>
    withFile(BigBytes, (file) =>
      Effect.gen(function*() {
        const { mode, reported, port } = yield* listening(file)
        yield* SubscriptionRef.set(mode, true)
        expect(yield* waitFor(accepts(Second, port), 3000)).toBe(true)
        // A request the app takes long to answer on the first address; on the
        // second, a download read slowly and a request whose headers never end.
        const slow = yield* connection(First, port, `GET /slow HTTP/1.1\r\nHost: ${First}:${port}\r\n\r\n`)
        const download = yield* connection(Second, port, `GET /big HTTP/1.1\r\nHost: ${Second}:${port}\r\n\r\n`, { paused: true })
        const unfinished = yield* connection(Second, port, `GET /peer HTTP/1.1\r\nHost: ${Second}:${port}\r\n`)
        yield* sleep(500)
        const off = performance.now()
        yield* SubscriptionRef.set(mode, false)
        yield* sleep(300)
        expect({ first: yield* accepts(First, port), second: yield* accepts(Second, port) }).toEqual({ first: false, second: false })
        // Nothing on the second address is being answered, so it closes all it
        // holds at once, the download part way.
        download.socket.resume()
        expect(yield* waitFor(Effect.sync(() => download.closedAt() !== undefined && unfinished.closedAt() !== undefined), 1500)).toBe(true)
        expect(download.bytes()).toBeLessThan(BigBytes)
        // The first gives the request it is answering its time, then closes it.
        expect(slow.closedAt()).toBeUndefined()
        yield* waitFor(Effect.sync(() => slow.closedAt() !== undefined), 4000)
        const seconds = (slow.closedAt()! - off) / 1000
        expect(seconds).toBeGreaterThanOrEqual(CloseWaitMs / 1000 - 0.5)
        expect(seconds).toBeLessThanOrEqual(CloseWaitMs / 1000 + 1.5)
        expect(slow.received()).toBe("")
        expect((yield* Ref.get(reported)).addresses).toEqual([])
        // Turned on again, both addresses listen again.
        yield* SubscriptionRef.set(mode, true)
        expect(yield* waitFor(Effect.zipWith(accepts(First, port), accepts(Second, port), (a, b) => a && b), 3000)).toBe(true)
        for (const each of [slow, download, unfinished]) each.socket.destroy()
      })
    ), 30_000)

  test("at a device revoked, take new connections on new listeners at once, and close the old ones as when LAN mode goes off", () =>
    withFile(BigBytes, (file) =>
      Effect.gen(function*() {
        const { mode, reported, port, revoke } = yield* listening(file)
        yield* SubscriptionRef.set(mode, true)
        expect(yield* waitFor(accepts(Second, port), 3000)).toBe(true)
        const slow = yield* connection(First, port, `GET /slow HTTP/1.1\r\nHost: ${First}:${port}\r\n\r\n`)
        const download = yield* connection(Second, port, `GET /big HTTP/1.1\r\nHost: ${Second}:${port}\r\n\r\n`, { paused: true })
        yield* sleep(500)
        const revoked = performance.now()
        yield* revoke
        yield* sleep(300)
        // Both addresses answer at once, from new listeners.
        for (const address of [First, Second]) {
          const asked = yield* connection(address, port, `GET /peer HTTP/1.1\r\nHost: ${address}:${port}\r\nConnection: close\r\n\r\n`)
          expect(yield* waitFor(Effect.sync(() => asked.closedAt() !== undefined), 2000)).toBe(true)
          expect(asked.received().split("\r\n")[0]).toBe("HTTP/1.1 200 OK")
        }
        // The old ones close what they hold: the download at once, the request
        // being answered after its time.
        download.socket.resume()
        expect(yield* waitFor(Effect.sync(() => download.closedAt() !== undefined), 1500)).toBe(true)
        expect(download.bytes()).toBeLessThan(BigBytes)
        expect(slow.closedAt()).toBeUndefined()
        yield* waitFor(Effect.sync(() => slow.closedAt() !== undefined), 4000)
        const seconds = (slow.closedAt()! - revoked) / 1000
        expect(seconds).toBeGreaterThanOrEqual(CloseWaitMs / 1000 - 0.5)
        expect(seconds).toBeLessThanOrEqual(CloseWaitMs / 1000 + 1.5)
        expect((yield* Ref.get(reported)).addresses).toEqual([First, Second])
        for (const each of [slow, download]) each.socket.destroy()
      })
    ), 30_000)

  test("say in plain words when another program holds the port on an address", () =>
    withFile(1, (file) =>
      Effect.gen(function*() {
        const { mode, reported, port } = yield* listening(file)
        const squatter = Bun.serve({ hostname: Second, port, fetch: () => new Response("another program") })
        yield* Effect.addFinalizer(() => Effect.sync(() => squatter.stop(true)))
        yield* SubscriptionRef.set(mode, true)
        yield* waitFor(Ref.get(reported).pipe(Effect.map((now) => now.problems.length > 0)), 3000)
        expect(yield* Ref.get(reported)).toEqual({
          port,
          addresses: [First],
          problems: [{ address: Second, detail: "Another program uses this port on that address." }]
        })
      })
    ))
})
