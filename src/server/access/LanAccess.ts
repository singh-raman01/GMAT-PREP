import { eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, PubSub, Ref, Semaphore, Stream, SubscriptionRef } from "effect"
import type { HttpServerRequest } from "effect/http"
import {
  DeviceCookie,
  type DeviceId,
  DeviceNotFound,
  DeviceView,
  LanModeOff,
  LanProblemView,
  LanView,
  NewPairingCode,
  PairedDevice,
  PairingCodeLength,
  PairingCodeWrong,
  PairingNotNeeded,
  PairingStatus
} from "../../api/Lan.ts"
import { Db } from "../db/Database.ts"
import { devices, lanMode } from "../db/schema.ts"
import { Network } from "./Network.ts"
import { hostName, isOwnAddress, judge, LoopbackNames, reachOf, type Refused, type Verdict } from "./reach.ts"
import { LastUsedResolutionMs, newToken, sha256 } from "./tokens.ts"

// LAN mode, pairing and paired devices (decisions 119 to 125).

// A pairing code works once, for 5 minutes, and five wrong codes in a row
// end it.
export const PairingCodeMs = 5 * 60 * 1000
export const MaxWrongCodes = 5

// What the listeners on the network report: the port, the addresses they
// listen on, and those they could not.
export interface Listening {
  readonly port: number
  readonly addresses: ReadonlyArray<string>
  readonly problems: ReadonlyArray<{ readonly address: string; readonly detail: string }>
}

const NotListening: Listening = { port: 0, addresses: [], problems: [] }

type DeviceRow = typeof devices.$inferSelect

interface Pairing {
  // The code shown last, by its hash, while it may still be used.
  readonly code: { readonly hash: string; readonly expiresAt: number } | null
  readonly wrong: number
}

// Six digits, each code as likely as any other.
const newPairingCode = () => {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000
  for (;;) {
    const value = crypto.getRandomValues(new Uint32Array(1))[0] ?? limit
    if (value < limit) return String(value % 1_000_000).padStart(PairingCodeLength, "0")
  }
}

const deviceView = (row: DeviceRow) =>
  new DeviceView({
    id: row.id as DeviceId,
    name: row.name,
    pairedAt: row.pairedAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt
  })

// Devices still paired first, the latest paired first; then revoked ones.
const deviceOrder = (a: DeviceRow, b: DeviceRow) =>
  a.revokedAt === null && b.revokedAt === null
    ? b.pairedAt - a.pairedAt
    : a.revokedAt === null
    ? -1
    : b.revokedAt === null
    ? 1
    : b.revokedAt - a.revokedAt

export class LanAccess extends Context.Service<LanAccess, {
  // Whether a request may be answered, and whether it came from this computer.
  judge(request: HttpServerRequest.HttpServerRequest): Effect.Effect<Verdict>
  fromHost(request: HttpServerRequest.HttpServerRequest): Effect.Effect<boolean>
  status(request: HttpServerRequest.HttpServerRequest): Effect.Effect<PairingStatus>
  pair(
    request: HttpServerRequest.HttpServerRequest,
    code: string,
    name: string
  ): Effect.Effect<{ readonly token: string; readonly device: PairedDevice }, PairingCodeWrong | PairingNotNeeded>
  readonly view: Effect.Effect<LanView>
  setMode(on: boolean): Effect.Effect<LanView>
  readonly makeCode: Effect.Effect<NewPairingCode, LanModeOff>
  revoke(id: DeviceId): Effect.Effect<LanView, DeviceNotFound>
  // LAN mode now and at each change, for the listeners.
  readonly mode: Stream.Stream<boolean>
  // Each device revoked, for the listeners, which close the connections it
  // may still have open.
  readonly revocations: Stream.Stream<void>
  reportListening(listening: Listening): Effect.Effect<void>
  // Waits until a request may no longer be answered, as when LAN mode goes
  // off or its device is revoked, and gives the refusal.
  accessEnds(request: HttpServerRequest.HttpServerRequest): Effect.Effect<Refused>
}>()("gmat-prep/server/access/LanAccess") {
  static readonly layer = Layer.effect(
    LanAccess,
    Effect.gen(function*() {
      const db = yield* Db
      const network = yield* Network

      const [modeRow] = yield* db.select().from(lanMode).where(eq(lanMode.id, 1)).pipe(Effect.orDie)
      const modeRef = yield* SubscriptionRef.make(modeRow?.on ?? false)
      const listeningRef = yield* Ref.make(NotListening)
      const pairingRef = yield* Ref.make<Pairing>({ code: null, wrong: 0 })
      // Each change that can end a device's access.
      const changes = yield* PubSub.unbounded<"lan-off" | "revoked">()
      const onePairingAtATime = (yield* Semaphore.make(1)).withPermits(1)

      // Every device, by token hash and by id. Only this process writes them.
      const byHash = new Map<string, DeviceRow>()
      const byId = new Map<string, DeviceRow>()
      const keep = (row: DeviceRow) => {
        byHash.set(row.tokenHash, row)
        byId.set(row.id, row)
      }
      for (const row of yield* db.select().from(devices).pipe(Effect.orDie)) keep(row)

      // The paired device a request comes from, not revoked; its use is
      // written down at most every few minutes.
      const deviceOf = Effect.fnUntraced(function*(request: HttpServerRequest.HttpServerRequest) {
        const token = request.cookies[DeviceCookie.key]
        if (token === undefined || token === "") return undefined
        const row = byHash.get(sha256(token))
        if (row === undefined || row.revokedAt !== null) return undefined
        const now = yield* Clock.currentTimeMillis
        if (now - row.lastSeenAt > LastUsedResolutionMs) {
          yield* db.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, row.id)).pipe(Effect.orDie)
          const seen = { ...row, lastSeenAt: now }
          keep(seen)
          return seen
        }
        return row
      })

      const judgeRequest = Effect.fnUntraced(function*(request: HttpServerRequest.HttpServerRequest) {
        const on = yield* SubscriptionRef.get(modeRef)
        const host = hostName(request.headers["host"])
        const remote = network.remoteOf(request)
        // This computer by loopback, as nearly every request is: no need to
        // read its interfaces.
        if (host !== undefined && LoopbackNames.includes(host)) {
          if (remote === undefined ? !on : isOwnAddress(remote, new Set())) return { _tag: "allow", fromHost: true } as const
        }
        const reach = reachOf(on, network.addresses(), network.hostname())
        const local = remote === undefined ? !on : isOwnAddress(remote, reach.ownAddresses)
        const device = local ? undefined : yield* deviceOf(request)
        return judge({ method: request.method, url: request.url, host, remote, paired: device !== undefined }, reach)
      })

      const fromHost = (request: HttpServerRequest.HttpServerRequest) =>
        judgeRequest(request).pipe(Effect.map((verdict) => verdict._tag === "allow" && verdict.fromHost))

      const status = Effect.fn("LanAccess.status")(function*(request: HttpServerRequest.HttpServerRequest) {
        const host = yield* fromHost(request)
        const device = host ? undefined : yield* deviceOf(request)
        return new PairingStatus({ fromHost: host, lan: yield* SubscriptionRef.get(modeRef), device: device?.name ?? null })
      })

      const pair = Effect.fn("LanAccess.pair")(function*(request: HttpServerRequest.HttpServerRequest, code: string, name: string) {
        if (yield* fromHost(request)) return yield* new PairingNotNeeded()
        const now = yield* Clock.currentTimeMillis
        const pairing = yield* Ref.get(pairingRef)
        const live = pairing.code !== null && now < pairing.code.expiresAt ? pairing.code : null
        if (live === null || sha256(code) !== live.hash) {
          const wrong = pairing.wrong + 1
          // The code ends at the fifth wrong try in a row, and with no code
          // waiting every try is wrong.
          const ended = live === null || wrong >= MaxWrongCodes
          yield* Ref.set(pairingRef, ended ? { code: null, wrong: 0 } : { code: live, wrong })
          return yield* new PairingCodeWrong({ attemptsLeft: ended ? 0 : MaxWrongCodes - wrong })
        }
        yield* Ref.set(pairingRef, { code: null, wrong: 0 })
        const token = newToken()
        const row: DeviceRow = {
          id: crypto.randomUUID(),
          name: name.trim(),
          tokenHash: sha256(token),
          pairedAt: now,
          lastSeenAt: now,
          revokedAt: null
        }
        yield* db.insert(devices).values(row).pipe(Effect.orDie)
        keep(row)
        return { token, device: new PairedDevice({ name: row.name }) }
      }, onePairingAtATime)

      const localName = () => {
        const name = network.hostname().trim().toLowerCase()
        return name === "" ? undefined : name.endsWith(".local") ? name : `${name}.local`
      }

      const view = Effect.gen(function*() {
        const on = yield* SubscriptionRef.get(modeRef)
        const listening = yield* Ref.get(listeningRef)
        const now = yield* Clock.currentTimeMillis
        const { code } = yield* Ref.get(pairingRef)
        const listened = on && listening.port > 0 ? listening.addresses : []
        const name = localName()
        const urls = [
          ...listened.map((address) => `http://${address}:${listening.port}`),
          ...(listened.length > 0 && name !== undefined ? [`http://${name}:${listening.port}`] : [])
        ]
        return new LanView({
          on,
          urls,
          problems: on ? listening.problems.map((problem) => new LanProblemView(problem)) : [],
          codeUntil: on && code !== null && now < code.expiresAt ? code.expiresAt : null,
          devices: [...byId.values()].sort(deviceOrder).map(deviceView)
        })
      })

      const setMode = Effect.fn("LanAccess.setMode")(function*(on: boolean) {
        const changedAt = yield* Clock.currentTimeMillis
        yield* db.insert(lanMode)
          .values({ id: 1, on, changedAt })
          .onConflictDoUpdate({ target: lanMode.id, set: { on, changedAt } })
          .pipe(Effect.orDie)
        yield* SubscriptionRef.set(modeRef, on)
        if (!on) {
          yield* Ref.set(pairingRef, { code: null, wrong: 0 })
          yield* PubSub.publish(changes, "lan-off")
        }
        return yield* view
      })

      const makeCode = Effect.gen(function*() {
        if (!(yield* SubscriptionRef.get(modeRef))) return yield* new LanModeOff()
        const code = newPairingCode()
        const expiresAt = (yield* Clock.currentTimeMillis) + PairingCodeMs
        // A new code ends the one before, with its wrong tries.
        yield* Ref.set(pairingRef, { code: { hash: sha256(code), expiresAt }, wrong: 0 })
        return new NewPairingCode({ code, expiresAt })
      }).pipe(onePairingAtATime)

      const revoke = Effect.fn("LanAccess.revoke")(function*(id: DeviceId) {
        const row = byId.get(id)
        if (row === undefined) return yield* new DeviceNotFound()
        if (row.revokedAt === null) {
          const revokedAt = yield* Clock.currentTimeMillis
          yield* db.update(devices).set({ revokedAt }).where(eq(devices.id, id)).pipe(Effect.orDie)
          keep({ ...row, revokedAt })
          yield* PubSub.publish(changes, "revoked")
        }
        return yield* view
      })

      // Judged again at each change that can end a device's access,
      // subscribed first so that no change is missed.
      const accessEnds = (request: HttpServerRequest.HttpServerRequest) =>
        Effect.gen(function*() {
          const changed = yield* PubSub.subscribe(changes)
          for (;;) {
            const verdict = yield* judgeRequest(request)
            if (verdict._tag === "refuse") return verdict
            yield* PubSub.take(changed)
          }
        }).pipe(Effect.scoped)

      return LanAccess.of({
        judge: judgeRequest,
        fromHost,
        status,
        pair,
        view,
        setMode,
        makeCode,
        revoke,
        mode: SubscriptionRef.changes(modeRef),
        revocations: Stream.fromPubSub(changes).pipe(Stream.filter((change) => change === "revoked"), Stream.as(undefined)),
        reportListening: (listening) => Ref.set(listeningRef, listening),
        accessEnds
      })
    })
  )
}
