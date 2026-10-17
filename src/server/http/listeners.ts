import { BunHttpServer } from "@effect/platform-bun"
import { Cause, Effect, Exit, Scope, Stream } from "effect"
import type { HttpServerResponse } from "effect/http"
import { LanAccess } from "../access/LanAccess.ts"
import { Network } from "../access/Network.ts"
import { lanAddressesOf } from "../access/reach.ts"

// LAN mode's listeners (decision 120): while it is on, the app also listens
// on each of this computer's IPv4 network addresses, at its own port, beside
// 127.0.0.1, which never closes. They open and close as LAN mode changes,
// and follow the addresses as interfaces come and go.

export const AddressesCheckedEvery = "10 seconds"

// A listener closing waits this long for its requests, then lets them go:
// LAN mode refuses them by then anyway.
const CloseWaitMs = 3000

interface ListenOptions {
  readonly port: number
  readonly maxRequestBodySize: number
}

const problemOf = (cause: Cause.Cause<unknown>) => {
  const text = Cause.pretty(cause)
  if (/EADDRINUSE|address already in use/i.test(text)) return "Another program uses this port on that address."
  if (/EADDRNOTAVAIL|not available/i.test(text)) return "That address has gone from this computer."
  if (/EACCES|permission/i.test(text)) return "This computer does not let the app listen on that address."
  return text.split("\n")[0] ?? "The app could not listen there."
}

export const lanListeners = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  options: ListenOptions
) =>
  Effect.gen(function*() {
    const access = yield* LanAccess
    const network = yield* Network
    const open = new Map<string, Scope.Closeable>()
    const problems = new Map<string, string>()

    const close = (address: string, scope: Scope.Closeable) =>
      Effect.gen(function*() {
        open.delete(address)
        yield* Scope.close(scope, Exit.void).pipe(Effect.timeoutOption(CloseWaitMs), Effect.ignore)
        yield* Effect.logInfo(`LAN mode: no longer listening on ${address}`)
      })

    const listen = Effect.fnUntraced(function*(address: string) {
      const scope = yield* Scope.make()
      const started = yield* BunHttpServer.make({ hostname: address, ...options }).pipe(
        Effect.flatMap((server) => server.serve(app)),
        Scope.provide(scope),
        Effect.exit
      )
      if (Exit.isSuccess(started)) {
        open.set(address, scope)
        problems.delete(address)
        return yield* Effect.logInfo(`LAN mode: other devices can open http://${address}:${options.port}`)
      }
      const problem = problemOf(started.cause)
      if (problems.get(address) !== problem) yield* Effect.logWarning(`LAN mode: cannot listen on ${address}: ${problem}`)
      problems.set(address, problem)
      yield* Scope.close(scope, Exit.void)
    })

    const sync = Effect.fnUntraced(function*(on: boolean) {
      const wanted = on ? lanAddressesOf(network.addresses()) : []
      for (const [address, scope] of [...open]) if (!wanted.includes(address)) yield* close(address, scope)
      for (const address of [...problems.keys()]) if (!wanted.includes(address)) problems.delete(address)
      for (const address of wanted) if (!open.has(address)) yield* listen(address)
      yield* access.reportListening({
        port: options.port,
        addresses: [...open.keys()].sort(),
        problems: [...problems].map(([address, detail]) => ({ address, detail }))
      })
    })

    // At each change of LAN mode, and every few seconds while it is on.
    let lan = false
    const turns = Stream.merge(
      access.mode.pipe(Stream.map((on) => void (lan = on))),
      Stream.tick(AddressesCheckedEvery)
    )
    yield* turns.pipe(Stream.runForEach(() => sync(lan)), Effect.forkScoped)
    yield* Effect.addFinalizer(() => Effect.forEach([...open], ([address, scope]) => close(address, scope), { discard: true }))
  })
