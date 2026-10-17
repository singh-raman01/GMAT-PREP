import { describe, expect, test } from "bun:test"
import { Effect, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { Api } from "../src/api/Api.ts"
import { RefusedHeader } from "../src/api/Lan.ts"
import { Db } from "../src/server/db/Database.ts"
import { devices, lanMode } from "../src/server/db/schema.ts"
import { Snapshots } from "../src/server/snapshots/Snapshots.ts"
import { openBrowser, runWithWorkers, tempDataDir, TestNetwork, TestRemoteHeader, type WorkerTestServices } from "./harness.ts"

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
    return { api, raw }
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
      yield* host.snapshots.restore({ params: { id: taken.id } })
      const view = yield* host.curatorLan.view()
      expect(view.on).toBe(true)
      expect(view.devices.map((each) => [each.name, each.revokedAt === null])).toEqual([["Tablet", true], ["Phone", false]])
      expect((yield* tablet.raw(HttpClientRequest.get("/api/profiles"))).status).toBe(200)
      expect((yield* phone.raw(HttpClientRequest.get("/api/profiles"))).status).toBe(403)
    })))
})
