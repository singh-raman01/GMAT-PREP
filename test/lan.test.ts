import { describe, expect, test } from "bun:test"
import { Effect, identity, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest, HttpServer } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { mkdirSync, writeFileSync } from "node:fs"
import net from "node:net"
import { join } from "node:path"
import { Api } from "../src/api/Api.ts"
import { EventsPath } from "../src/api/Events.ts"
import { InstallExportPath } from "../src/api/Exports.ts"
import { RefusedHeader } from "../src/api/Lan.ts"
import { AppConfig } from "../src/server/AppConfig.ts"
import { Db } from "../src/server/db/Database.ts"
import { curatorUnlocks, devices, lanMode, profileUnlocks } from "../src/server/db/schema.ts"
import { Snapshots } from "../src/server/snapshots/Snapshots.ts"
import { readTar } from "../src/server/snapshots/tar.ts"
import { curatorBrowser, passphrase } from "./bookFlow.ts"
import {
  openBrowser,
  runWithLanListeners,
  runWithWorkers,
  tempDataDir,
  TestNetwork,
  TestRemoteHeader,
  type WorkerTestServices
} from "./harness.ts"

// LAN mode (decisions 119 to 125): off by default; in LAN mode another
// device on the network must pair with a 6-digit code shown on this
// computer, single-use and good for 5 minutes; paired devices are listed for
// the Curator and can be revoked; a Profile's PIN still guards it.

const Tablet = "192.168.1.31"
const Phone = "192.168.1.32"
const ThisComputer = "192.168.1.20"

const network = Effect.gen(function*() {
  yield* (yield* TestNetwork).setAddresses([
    { address: "127.0.0.1", family: "IPv4", internal: true },
    { address: ThisComputer, family: "IPv4", internal: false }
  ])
})

// A browser on another device: its requests come from that address.
const device = (remote: string) =>
  Effect.gen(function*() {
    const jar = yield* Ref.make(Cookies.empty)
    const api = yield* HttpApiClient.make(Api, {
      transformClient: (client) =>
        client.pipe(HttpClient.withCookiesRef(jar), HttpClient.mapRequest(HttpClientRequest.setHeader(TestRemoteHeader, remote)))
    })
    // A request outside the typed client, to read a refusal as it comes.
    const raw = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function*() {
        const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withCookiesRef(jar))
        const response = yield* client.execute(request.pipe(HttpClientRequest.setHeader(TestRemoteHeader, remote)))
        return { status: response.status, refused: response.headers[RefusedHeader] }
      })
    // Its Cookie header, for a request written by hand.
    const cookie = Ref.get(jar).pipe(Effect.map((cookies) => Cookies.toCookieHeader(cookies)))
    return { api, raw, cookie }
  })

const curator = Effect.gen(function*() {
  const browser = yield* openBrowser
  yield* browser.curatorAccess.setPassphrase({ payload: { passphrase: "correct horse battery" } })
  return browser
})

const run = <A, E>(effect: Effect.Effect<A, E, WorkerTestServices>) => runWithWorkers(effect, undefined, tempDataDir())

describe("LAN mode", () => {
  test("is off by default, and while off another device gets nothing at all", () =>
    run(Effect.gen(function*() {
      yield* network
      const host = yield* curator
      expect(yield* host.curatorLan.view()).toMatchObject({ on: false, devices: [], codeUntil: null })
      const tablet = yield* device(Tablet)
      for (const path of ["/", "/api/pairing", "/api/profiles"]) {
        expect([path, yield* tablet.raw(HttpClientRequest.get(path))]).toEqual([path, { status: 403, refused: "lan-off" }])
      }
      // This computer itself is never refused, by any of its addresses.
      const self = yield* device(ThisComputer)
      expect((yield* self.raw(HttpClientRequest.get("/api/profiles"))).status).toBe(200)
    })))

  test("turned on is kept, and a device not paired gets the app's pages and pairing, and is refused the rest", () =>
    run(Effect.gen(function*() {
      yield* network
      const host = yield* curator
      expect(yield* host.curatorLan.setMode({ payload: { on: true } })).toMatchObject({ on: true })
      const [row] = yield* (yield* Db).select().from(lanMode)
      expect(row?.on).toBe(true)
      const tablet = yield* device(Tablet)
      expect((yield* tablet.raw(HttpClientRequest.get("/"))).status).not.toBe(403)
      expect(yield* tablet.api.pairing.status()).toMatchObject({ fromHost: false, lan: true, device: null })
      for (const path of ["/api/profiles", "/api/events", "/API/profiles", "//api/profiles", "/%61pi/profiles"]) {
        expect([path, yield* tablet.raw(HttpClientRequest.get(path))]).toEqual([path, { status: 403, refused: "not-paired" }])
      }
      expect(yield* tablet.raw(HttpClientRequest.post("/api/profiles").pipe(HttpClientRequest.bodyJsonUnsafe({ name: "Eve" })))).toEqual({
        status: 403,
        refused: "not-paired"
      })
    })))

  test("a device pairs with the code shown on this computer, once, within 5 minutes", () =>
    run(Effect.gen(function*() {
      yield* network
      const host = yield* curator
      yield* host.curatorLan.setMode({ payload: { on: true } })
      const tablet = yield* device(Tablet)
      // No code is waiting yet: every try is wrong.
      expect(yield* tablet.api.pairing.pair({ payload: { code: "000000", name: "Tablet" } }).pipe(Effect.flip)).toMatchObject({
        _tag: "PairingCodeWrong",
        attemptsLeft: 0
      })
      const shown = yield* host.curatorLan.makeCode()
      expect(shown.code).toMatch(/^\d{6}$/)
      expect(yield* host.curatorLan.view()).toMatchObject({ codeUntil: shown.expiresAt })
      const wrong = String((Number(shown.code) + 1) % 1_000_000).padStart(6, "0")
      expect(yield* tablet.api.pairing.pair({ payload: { code: wrong, name: "Tablet" } }).pipe(Effect.flip)).toMatchObject({ attemptsLeft: 4 })
      expect(yield* tablet.api.pairing.pair({ payload: { code: shown.code, name: "  Asha's tablet  " } })).toMatchObject({ name: "Asha's tablet" })
      expect(yield* tablet.api.pairing.status()).toMatchObject({ device: "Asha's tablet" })
      expect((yield* tablet.raw(HttpClientRequest.get("/api/profiles"))).status).toBe(200)
      // The code worked once.
      const phone = yield* device(Phone)
      expect(yield* phone.api.pairing.pair({ payload: { code: shown.code, name: "Phone" } }).pipe(Effect.flip)).toMatchObject({ attemptsLeft: 0 })
      // A new code lasts 5 minutes.
      const next = yield* host.curatorLan.makeCode()
      yield* TestClock.adjust("5 minutes")
      expect(yield* phone.api.pairing.pair({ payload: { code: next.code, name: "Phone" } }).pipe(Effect.flip)).toMatchObject({ attemptsLeft: 0 })
      expect((yield* host.curatorLan.view()).devices.map((each) => each.name)).toEqual(["Asha's tablet"])
      // Only the token's hash is stored.
      const [stored] = yield* (yield* Db).select().from(devices)
      expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    })))

  test("the paired device's cookie is HttpOnly, SameSite=Strict, and kept for 400 days", () =>
    run(Effect.gen(function*() {
      yield* network
      const host = yield* curator
      yield* host.curatorLan.setMode({ payload: { on: true } })
      const { code } = yield* host.curatorLan.makeCode()
      const response = yield* (yield* HttpClient.HttpClient).execute(
        HttpClientRequest.post("/api/pairing/pair").pipe(
          HttpClientRequest.setHeader(TestRemoteHeader, Tablet),
          HttpClientRequest.bodyJsonUnsafe({ code, name: "Tablet" })
        )
      )
      expect(response.status).toBe(200)
      const cookie = response.headers["set-cookie"] ?? ""
      expect(cookie).toMatch(/^gp_device=[A-Za-z0-9_-]{43};/)
      expect(cookie.split("; ").slice(1).toSorted()).toEqual(["HttpOnly", `Max-Age=${400 * 24 * 60 * 60}`, "Path=/", "SameSite=Strict"])
    })))

  test("five wrong codes in a row end the code, so a new one must be shown", () =>
    run(Effect.gen(function*() {
      yield* network
      const host = yield* curator
      yield* host.curatorLan.setMode({ payload: { on: true } })
      const shown = yield* host.curatorLan.makeCode()
      const phone = yield* device(Phone)
      const lefts: Array<number> = []
      for (let n = 1; n <= 5; n += 1) {
        const guess = String((Number(shown.code) + n) % 1_000_000).padStart(6, "0")
        const refused = yield* phone.api.pairing.pair({ payload: { code: guess, name: "Phone" } }).pipe(Effect.flip)
        lefts.push((refused as { readonly attemptsLeft: number }).attemptsLeft)
      }
      expect(lefts).toEqual([4, 3, 2, 1, 0])
      expect(yield* phone.api.pairing.pair({ payload: { code: shown.code, name: "Phone" } }).pipe(Effect.flip)).toMatchObject({ attemptsLeft: 0 })
      expect((yield* host.curatorLan.view()).codeUntil).toBeNull()
    })))

  test("only this computer shows codes, turns LAN mode on or off and revokes devices, even from a paired device with the Curator unlocked", () =>
    run(Effect.gen(function*() {
      yield* network
      const host = yield* curator
      yield* host.curatorLan.setMode({ payload: { on: true } })
      const tablet = yield* device(Tablet)
      yield* tablet.api.pairing.pair({ payload: { code: (yield* host.curatorLan.makeCode()).code, name: "Tablet" } })
      yield* tablet.api.curatorAccess.unlock({ payload: { passphrase: "correct horse battery" } })
      // Other Curator tools work from the tablet.
      expect((yield* tablet.raw(HttpClientRequest.get("/api/curator/snapshots"))).status).toBe(200)
      for (const request of [
        HttpClientRequest.get("/api/curator/lan"),
        HttpClientRequest.post("/api/curator/lan/code"),
        HttpClientRequest.put("/api/curator/lan").pipe(HttpClientRequest.bodyJsonUnsafe({ on: false })),
        HttpClientRequest.post("/API/Curator/%4Can/code")
      ]) {
        expect(yield* tablet.raw(request)).toEqual({ status: 403, refused: "host-only" })
      }
      // This computer needs no pairing.
      expect(yield* host.pairing.pair({ payload: { code: "123456", name: "Here" } }).pipe(Effect.flip)).toMatchObject({ _tag: "PairingNotNeeded" })
    })))

  test("a revoked device is refused at once, and a Profile with a PIN still needs it on a paired device", () =>
    run(Effect.gen(function*() {
      yield* network
      const host = yield* curator
      yield* host.curatorLan.setMode({ payload: { on: true } })
      const learner = yield* openBrowser
      const priya = yield* learner.profiles.create({ payload: { name: "Priya", pin: "2468", timeZone: "UTC" } })
      const tablet = yield* device(Tablet)
      yield* tablet.api.pairing.pair({ payload: { code: (yield* host.curatorLan.makeCode()).code, name: "Tablet" } })
      expect(yield* tablet.api.profiles.unlock({ params: { id: priya.id }, payload: {} }).pipe(Effect.flip)).toMatchObject({ _tag: "PinRequired" })
      yield* tablet.api.profiles.unlock({ params: { id: priya.id }, payload: { pin: "2468" } })
      expect(yield* tablet.api.session.me()).toMatchObject({ name: "Priya" })
      const [paired] = (yield* host.curatorLan.view()).devices
      const after = yield* host.curatorLan.revoke({ params: { id: paired!.id } })
      expect(after.devices[0]?.revokedAt).not.toBeNull()
      expect(yield* tablet.raw(HttpClientRequest.get("/api/session/me"))).toEqual({ status: 403, refused: "not-paired" })
      expect(yield* tablet.api.pairing.status()).toMatchObject({ device: null })
    })))

  test("turning LAN mode off refuses paired devices at once and ends a code waiting", () =>
    run(Effect.gen(function*() {
      yield* network
      const host = yield* curator
      yield* host.curatorLan.setMode({ payload: { on: true } })
      const tablet = yield* device(Tablet)
      yield* tablet.api.pairing.pair({ payload: { code: (yield* host.curatorLan.makeCode()).code, name: "Tablet" } })
      yield* host.curatorLan.makeCode()
      const off = yield* host.curatorLan.setMode({ payload: { on: false } })
      expect(off).toMatchObject({ on: false, codeUntil: null, urls: [] })
      expect(yield* tablet.raw(HttpClientRequest.get("/api/profiles"))).toEqual({ status: 403, refused: "lan-off" })
      expect(yield* host.curatorLan.makeCode().pipe(Effect.flip)).toMatchObject({ _tag: "LanModeOff" })
    })))

  test("a restore keeps LAN mode and the paired devices as they are now", () =>
    run(Effect.gen(function*() {
      yield* network
      const host = yield* curator
      const snapshots = yield* Snapshots
      const taken = yield* snapshots.take("manual")
      yield* host.curatorLan.setMode({ payload: { on: true } })
      const tablet = yield* device(Tablet)
      yield* tablet.api.pairing.pair({ payload: { code: (yield* host.curatorLan.makeCode()).code, name: "Tablet" } })
      const phone = yield* device(Phone)
      yield* phone.api.pairing.pair({ payload: { code: (yield* host.curatorLan.makeCode()).code, name: "Phone" } })
      const listed = (yield* host.curatorLan.view()).devices
      yield* host.curatorLan.revoke({ params: { id: listed.find((each) => each.name === "Phone")!.id } })
      yield* host.snapshots.restore({ params: { id: taken.id }, payload: { passphrase: "correct horse battery" } })
      const view = yield* host.curatorLan.view()
      expect(view.on).toBe(true)
      expect(view.devices.map((each) => [each.name, each.revokedAt === null])).toEqual([["Tablet", true], ["Phone", false]])
      expect((yield* tablet.raw(HttpClientRequest.get("/api/profiles"))).status).toBe(200)
      expect((yield* phone.raw(HttpClientRequest.get("/api/profiles"))).status).toBe(403)
    })))
})

const appPort = Effect.gen(function*() {
  const server = yield* HttpServer.HttpServer
  return server.address._tag === "UnixPathAddress" ? 0 : server.address.port
})

// A request written on a socket by hand, so that a test can hold back the end
// of its body or read the reply slowly, and see what the server sends and
// when it closes the connection.
const socketTo = (host = "127.0.0.1") => Effect.gen(function*() {
  const port = yield* appPort
  return yield* Effect.promise(() =>
    new Promise<{
      readonly socket: net.Socket
      readonly port: number
      readonly reply: () => string
      readonly bytes: () => number
      readonly closed: () => boolean
    }>((resolve) => {
      const socket = net.connect({ host, port })
      let reply = ""
      let bytes = 0
      let closed = false
      socket.on("data", (chunk) => {
        bytes += chunk.length
        if (reply.length < 4096) reply += chunk.toString("latin1")
      })
      socket.on("error", () => {})
      socket.on("close", () => (closed = true))
      socket.on("connect", () => resolve({ socket, port, reply: () => reply, bytes: () => bytes, closed: () => closed }))
    })
  )
})

const sleep = (ms: number) => Effect.promise(() => Bun.sleep(ms))

// This computer's network address, in tests with LAN mode's listeners.
const LanAddress = "127.0.0.2"

const listensOn = (host: string, port: number) =>
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

const waitUntil = (check: Effect.Effect<boolean> | (() => boolean), ms: number) =>
  Effect.gen(function*() {
    const holds = Effect.isEffect(check) ? check : Effect.sync(check)
    for (let waited = 0; waited < ms; waited += 25) {
      if (yield* holds) return true
      yield* sleep(25)
    }
    return yield* holds
  })

const headOf = (
  request: { readonly method: string; readonly path: string; readonly port: number; readonly cookie: string; readonly remote?: string; readonly host?: string }
) =>
  `${request.method} ${request.path} HTTP/1.1\r\nHost: ${request.host ?? "127.0.0.1"}:${request.port}\r\nCookie: ${request.cookie}\r\n` +
  (request.remote === undefined ? "" : `${TestRemoteHeader}: ${request.remote}\r\n`) + "Connection: close\r\n"

// The status line and the refusal's reason, from a reply read off a socket.
const statusOf = (reply: string) => ({
  status: reply.split("\r\n")[0],
  refused: /\r\nx-gp-refused: ([^\r]*)/i.exec(reply)?.[1]
})

describe("Moving the install", () => {
  test("leaves LAN mode, the paired devices and every unlock out of the archive, so the computer it moves to starts closed", async () => {
    const moved = tempDataDir()
    const old = await run(Effect.gen(function*() {
      yield* network
      const host = yield* curatorBrowser
      yield* host.api.curatorLan.setMode({ payload: { on: true } })
      const tablet = yield* device(Tablet)
      yield* tablet.api.pairing.pair({ payload: { code: (yield* host.api.curatorLan.makeCode()).code, name: "Tablet" } })
      yield* tablet.api.curatorAccess.unlock({ payload: { passphrase } })
      const priya = yield* (yield* openBrowser).profiles.create({ payload: { name: "Priya", pin: "2468", timeZone: "UTC" } })
      yield* tablet.api.profiles.unlock({ params: { id: priya.id }, payload: { pin: "2468" } })
      yield* host.api.curatorData.exportInstall()
      const response = yield* (yield* HttpClient.HttpClient).execute(
        HttpClientRequest.get(InstallExportPath).pipe(HttpClientRequest.setHeader("cookie", host.cookie))
      )
      const database = readTar(new Uint8Array(yield* response.arrayBuffer))[0]!
      expect(database.name).toBe("gmat-prep.sqlite")
      // Not a row of them, and not one of the token hashes this install
      // trusts, is in the archive's database.
      const db = yield* Db
      const trusted = [
        ...(yield* db.select().from(devices)).map((row) => row.tokenHash),
        ...(yield* db.select().from(curatorUnlocks)).map((row) => row.tokenHash),
        ...(yield* db.select().from(profileUnlocks)).map((row) => row.tokenHash)
      ]
      expect(trusted.length).toBeGreaterThanOrEqual(4)
      const bytes = Buffer.from(database.content)
      expect(trusted.filter((hash) => bytes.includes(hash))).toEqual([])
      yield* Effect.sync(() => writeFileSync(join(moved, "gmat-prep.sqlite"), database.content))
      // This computer stays as it was.
      expect(yield* host.api.curatorLan.view()).toMatchObject({ on: true, devices: [{ name: "Tablet", revokedAt: null }] })
      expect((yield* tablet.raw(HttpClientRequest.get("/api/profiles"))).status).toBe(200)
      return { tablet: yield* tablet.cookie, host: host.cookie }
    }))
    await runWithWorkers(Effect.gen(function*() {
      yield* network
      const client = yield* HttpClient.HttpClient
      const send = (path: string, cookie: string, remote?: string) =>
        client.execute(
          HttpClientRequest.get(path).pipe(
            HttpClientRequest.setHeader("cookie", cookie),
            remote === undefined ? identity : HttpClientRequest.setHeader(TestRemoteHeader, remote)
          )
        ).pipe(Effect.map((response) => ({ status: response.status, refused: response.headers[RefusedHeader] })))
      // The Curator's unlock from the other computer opens nothing here.
      expect(yield* send("/api/curator/snapshots", old.host)).toEqual({ status: 401, refused: undefined })
      // The passphrase and the Profiles move; LAN mode and the devices do not.
      const host = yield* openBrowser
      yield* host.curatorAccess.unlock({ payload: { passphrase } })
      expect(yield* host.curatorLan.view()).toMatchObject({ on: false, devices: [] })
      expect((yield* host.profiles.list()).map((profile) => profile.name)).toEqual(["Priya"])
      // The tablet's old cookie lets it in neither while LAN mode is off nor
      // once it is on.
      expect(yield* send("/api/profiles", old.tablet, Tablet)).toEqual({ status: 403, refused: "lan-off" })
      yield* host.curatorLan.setMode({ payload: { on: true } })
      expect(yield* send("/api/profiles", old.tablet, Tablet)).toEqual({ status: 403, refused: "not-paired" })
    }), undefined, moved)
  })
})

describe("Ending a device's access", () => {
  test("a write a device began is refused and not carried out once it is revoked or LAN mode goes off", () =>
    run(Effect.gen(function*() {
      yield* network
      const host = yield* curator
      yield* host.curatorLan.setMode({ payload: { on: true } })
      const revoke = Effect.gen(function*() {
        const [paired] = (yield* host.curatorLan.view()).devices
        yield* host.curatorLan.revoke({ params: { id: paired!.id } })
      })
      const lanOff = host.curatorLan.setMode({ payload: { on: false } })
      for (const [remote, end, reason] of [[Tablet, revoke, "not-paired"], [Phone, lanOff, "lan-off"]] as const) {
        const other = yield* device(remote)
        yield* other.api.pairing.pair({ payload: { code: (yield* host.curatorLan.makeCode()).code, name: remote } })
        const body = Buffer.from(JSON.stringify({ name: `Written from ${remote}`, timeZone: "UTC" }))
        const write = yield* socketTo()
        // The request's head and all but the end of its body go first.
        write.socket.write(
          headOf({ method: "POST", path: "/api/profiles", port: write.port, cookie: yield* other.cookie, remote }) +
            `Content-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`
        )
        write.socket.write(body.subarray(0, body.length - 2))
        yield* sleep(300)
        yield* end
        // The device is refused before the end of the body arrives.
        expect(yield* waitUntil(() => write.reply() !== "", 2000)).toBe(true)
        write.socket.write(body.subarray(body.length - 2))
        yield* waitUntil(write.closed, 2000)
        expect([remote, statusOf(write.reply())]).toEqual([remote, { status: "HTTP/1.1 403 Forbidden", refused: reason }])
      }
      expect(yield* host.profiles.list()).toEqual([])
    })))

  test("a download a device began over the network stops once it is revoked or LAN mode goes off, and one on this computer goes on", () =>
    runWithLanListeners(Effect.gen(function*() {
      // This computer's network address is a loopback one, which the
      // listeners listen on; the devices say where they are in a header.
      yield* (yield* TestNetwork).setAddresses([
        { address: "127.0.0.1", family: "IPv4", internal: true },
        { address: LanAddress, family: "IPv4", internal: false }
      ])
      const host = yield* curatorBrowser
      yield* host.api.curatorLan.setMode({ payload: { on: true } })
      const port = yield* appPort
      expect(yield* waitUntil(listensOn(LanAddress, port), 3000)).toBe(true)
      // A large Book, so the archive takes a while to read.
      const { dataDir } = yield* AppConfig
      yield* Effect.sync(() => {
        mkdirSync(join(dataDir, "books"), { recursive: true })
        writeFileSync(join(dataDir, "books", `${"c".repeat(64)}.pdf`), new Uint8Array(48 * 1024 * 1024))
      })
      const archive = yield* host.api.curatorData.exportInstall()
      const revoke = Effect.gen(function*() {
        const live = (yield* host.api.curatorLan.view()).devices.filter((each) => each.revokedAt === null)
        yield* host.api.curatorLan.revoke({ params: { id: live[0]!.id } })
      })
      const lanOff = host.api.curatorLan.setMode({ payload: { on: false } })
      for (const [remote, end] of [[Tablet, revoke], [Phone, lanOff]] as const) {
        const other = yield* device(remote)
        yield* other.api.pairing.pair({ payload: { code: (yield* host.api.curatorLan.makeCode()).code, name: remote } })
        yield* other.api.curatorAccess.unlock({ payload: { passphrase } })
        const fromDevice = yield* socketTo(LanAddress)
        fromDevice.socket.write(
          headOf({ method: "GET", path: InstallExportPath, port, cookie: yield* other.cookie, remote, host: LanAddress }) + "\r\n"
        )
        const fromHost = yield* socketTo()
        fromHost.socket.write(headOf({ method: "GET", path: InstallExportPath, port, cookie: host.cookie }) + "\r\n")
        // Both begin, and read no further for now.
        yield* waitUntil(() => fromDevice.bytes() > 0 && fromHost.bytes() > 0, 5000)
        fromDevice.socket.pause()
        fromHost.socket.pause()
        expect([statusOf(fromDevice.reply()).status, statusOf(fromHost.reply()).status]).toEqual(["HTTP/1.1 200 OK", "HTTP/1.1 200 OK"])
        yield* end
        yield* sleep(200)
        fromDevice.socket.resume()
        fromHost.socket.resume()
        expect(yield* waitUntil(() => fromDevice.closed() && fromHost.closed(), 10_000)).toBe(true)
        expect([remote, fromDevice.bytes() < archive.size]).toEqual([remote, true])
        expect([remote, fromHost.bytes() > archive.size]).toEqual([remote, true])
      }
    })), 60_000)

  test("a device's event stream ends once LAN mode goes off, and this computer's stays open", () =>
    run(Effect.gen(function*() {
      yield* network
      const host = yield* curatorBrowser
      yield* host.api.curatorLan.setMode({ payload: { on: true } })
      const tablet = yield* device(Tablet)
      yield* tablet.api.pairing.pair({ payload: { code: (yield* host.api.curatorLan.makeCode()).code, name: "Tablet" } })
      yield* tablet.api.curatorAccess.unlock({ payload: { passphrase } })
      const fromTablet = yield* socketTo()
      fromTablet.socket.write(headOf({ method: "GET", path: EventsPath, port: fromTablet.port, cookie: yield* tablet.cookie, remote: Tablet }) + "\r\n")
      const fromHost = yield* socketTo()
      fromHost.socket.write(headOf({ method: "GET", path: EventsPath, port: fromHost.port, cookie: host.cookie }) + "\r\n")
      expect(yield* waitUntil(() => fromTablet.reply().includes("retry: 3000") && fromHost.reply().includes("retry: 3000"), 5000)).toBe(true)
      yield* host.api.curatorLan.setMode({ payload: { on: false } })
      expect(yield* waitUntil(fromTablet.closed, 2000)).toBe(true)
      yield* sleep(500)
      expect(fromHost.closed()).toBe(false)
      fromHost.socket.destroy()
    })))
})
