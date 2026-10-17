import { Effect, Fiber, Option, type Scope, Stream } from "effect"
import { HttpEffect, HttpServerRequest, type HttpServerResponse } from "effect/http"
import { LanAccess } from "../access/LanAccess.ts"
import { Network } from "../access/Network.ts"
import { lanAddressesOf } from "../access/reach.ts"

// LAN mode's listeners (decision 120): while it is on, the app also listens
// on each of this computer's IPv4 network addresses, at its own port, beside
// 127.0.0.1, which never closes. They open and close as LAN mode changes,
// and follow the addresses as interfaces come and go.
//
// Each is a Bun server of its own, rather than one from BunHttpServer, so
// that closing it ends the connections it holds: BunHttpServer waits for
// them without a bound. Bun closes no single connection, and only closing
// its server stops a file it is sending, so a device revoked has its
// connections ended by replacing every listener (decision 123).

export const AddressesCheckedEvery = "10 seconds"

// A listener closing stops taking connections at once, gives the requests
// still being answered this long to be answered, then closes every
// connection it holds, cutting off what it is still sending. A device's
// requests are refused at once when its access ends, so only this computer's
// are waited for.
export const CloseWaitMs = 3000

interface ListenOptions {
  readonly port: number
  readonly maxRequestBodySize: number
}

interface Listener {
  readonly server: ReturnType<typeof Bun.serve>
  // Resolves once no request is being answered.
  readonly answered: () => Promise<void>
}

// Bun names the reason in the error's code; its message is its own words.
const problemOf = (error: unknown) => {
  switch ((error as { readonly code?: unknown } | null)?.code) {
    case "EADDRINUSE":
      return "Another program uses this port on that address."
    case "EADDRNOTAVAIL":
      return "That address has gone from this computer."
    case "EACCES":
      return "This computer does not let the app listen on that address."
    default: {
      const message = error instanceof Error ? error.message.split("\n")[0] : undefined
      return message === undefined || message === "" ? "The app could not listen there." : message
    }
  }
}

export const lanListeners = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  options: ListenOptions
) =>
  Effect.gen(function*() {
    const access = yield* LanAccess
    const network = yield* Network
    const open = new Map<string, Listener>()
    const problems = new Map<string, string>()

    // A request's address comes from the server that took it.
    const peers = new WeakMap<object, string>()
    const served = Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const remoteAddress = Option.fromNullishOr(peers.get(request.source))
      return yield* app.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request.modify({ remoteAddress })))
    })
    // Requests run with the services of this fiber, as response streams do,
    // which leaves the app needing only the request and its scope.
    const services = yield* Effect.context<Exclude<R, HttpServerRequest.HttpServerRequest | Scope.Scope>>()
    const answer = HttpEffect.toWebHandlerWith<never, HttpServerRequest.HttpServerRequest | Scope.Scope>(services)(
      served as Effect.Effect<HttpServerResponse.HttpServerResponse, E, HttpServerRequest.HttpServerRequest | Scope.Scope>
    )

    const serve = (address: string): Listener => {
      let answering = 0
      let waiting: Array<() => void> = []
      const server = Bun.serve({
        hostname: address,
        port: options.port,
        maxRequestBodySize: options.maxRequestBodySize,
        fetch: (request, server) => {
          const peer = server.requestIP(request)?.address
          if (peer !== undefined) peers.set(request, peer)
          answering += 1
          return answer(request).finally(() => {
            answering -= 1
            if (answering === 0) for (const done of waiting.splice(0)) done()
          })
        }
      })
      return { server, answered: () => answering === 0 ? Promise.resolve() : new Promise((done) => waiting.push(done)) }
    }

    // Run to the end even when the app stops meanwhile, as a listener
    // closing is no longer among those open.
    const close = (address: string, listener: Listener) =>
      Effect.gen(function*() {
        void listener.server.stop()
        yield* Effect.promise(listener.answered).pipe(Effect.timeoutOption(CloseWaitMs))
        yield* Effect.promise(() => listener.server.stop(true))
        yield* Effect.logInfo(`LAN mode: no longer listening on ${address}`)
      }).pipe(Effect.uninterruptible)

    // Every listener closing closes at once, so one answering a slow request
    // does not keep the others open.
    const closeAll = (closing: ReadonlyArray<readonly [string, Listener]>) =>
      Effect.forEach(closing, ([address, listener]) => close(address, listener), { concurrency: "unbounded", discard: true })

    const listen = Effect.fnUntraced(function*(address: string) {
      const started = yield* Effect.try({ try: () => serve(address), catch: problemOf }).pipe(Effect.result)
      if (started._tag === "Success") {
        open.set(address, started.success)
        problems.delete(address)
        return yield* Effect.logInfo(`LAN mode: other devices can open http://${address}:${options.port}`)
      }
      if (problems.get(address) !== started.failure) {
        yield* Effect.logWarning(`LAN mode: cannot listen on ${address}: ${started.failure}`)
      }
      problems.set(address, started.failure)
    })

    const report = Effect.suspend(() =>
      access.reportListening({
        port: options.port,
        addresses: [...open.keys()].sort(),
        problems: [...problems].map(([address, detail]) => ({ address, detail }))
      })
    )

    const sync = Effect.fnUntraced(function*(on: boolean) {
      const wanted = on ? lanAddressesOf(network.addresses()) : []
      const closing = [...open].filter(([address]) => !wanted.includes(address))
      for (const [address] of closing) open.delete(address)
      for (const address of [...problems.keys()]) if (!wanted.includes(address)) problems.delete(address)
      for (const address of wanted) if (!open.has(address)) yield* listen(address)
      yield* report
      yield* closeAll(closing)
    })

    // Each listener gives way to a new one on its address, which takes the
    // connections from then on, and closes as above.
    const renew = Effect.gen(function*() {
      const replaced = [...open]
      for (const [address, listener] of replaced) {
        // Its port is free once it stops taking connections.
        void listener.server.stop()
        open.delete(address)
        yield* listen(address)
      }
      yield* report
      yield* closeAll(replaced)
    })

    // At each change of LAN mode, every few seconds while it is on, and at
    // each device revoked.
    let lan = false
    const turns = Stream.mergeAll([
      access.mode.pipe(Stream.map((on) => {
        lan = on
        return "sync" as const
      })),
      Stream.tick(AddressesCheckedEvery).pipe(Stream.as("sync" as const)),
      access.revocations.pipe(Stream.as("renew" as const))
    ], { concurrency: "unbounded" })
    const syncing = yield* turns.pipe(
      Stream.runForEach((turn) => (turn === "renew" && lan ? renew : sync(lan))),
      Effect.forkScoped
    )
    yield* Effect.addFinalizer(() => Fiber.interrupt(syncing).pipe(Effect.andThen(Effect.suspend(() => closeAll([...open])))))
  })
