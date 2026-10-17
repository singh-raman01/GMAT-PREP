import { BunHttpServer } from "@effect/platform-bun"
import { Context, type Duration, Effect, type Fiber, Layer, Option, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest, HttpRouter, type HttpServer } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Api } from "../src/api/Api.ts"
import { Network } from "../src/server/access/Network.ts"
import type { NetworkAddress } from "../src/server/access/reach.ts"
import { AppConfig } from "../src/server/AppConfig.ts"
import { AppRoutes, AppServices, makeAppServices } from "../src/server/app.ts"
import type { Db } from "../src/server/db/Database.ts"
import { type AnyJobKind, JobKinds } from "../src/server/jobs/JobKind.ts"
import { JobRunner } from "../src/server/jobs/JobRunner.ts"
import type { JobStore } from "../src/server/jobs/JobStore.ts"
import { ConnectionTest } from "../src/server/jobs/kinds/connectionTest.ts"
import { type FakeLlm, LlmTransport, LlmTransportFake } from "../src/server/llm/LlmTransport.ts"
import { SnapshotCopier, SnapshotCopierInProcess, SnapshotWorkFailed } from "../src/server/snapshots/copier.ts"
import type { Snapshots } from "../src/server/snapshots/Snapshots.ts"
import type { ApiKeyStore } from "../src/server/settings/ApiKeyStore.ts"
import type { Settings } from "../src/server/settings/Settings.ts"
import { workerServices } from "../src/server/worker/services.ts"
import { WorkerSupervisor } from "../src/server/worker/WorkerSupervisor.ts"
import { FigureFiles } from "../src/server/books/FigureFiles.ts"
import { ErrorLog } from "../src/server/learning/ErrorLog.ts"

// Each test's data folder, removed when the test run ends: a full run makes
// hundreds, and left behind they fill the disk.
const madeDirs: Array<string> = []
process.once("exit", () => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true })
})

export const tempDataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "gmat-prep-test-"))
  madeDirs.push(dir)
  return dir
}

// One browser: a typed API client with its own cookie jar.
export const openBrowser = Effect.gen(function*() {
  const jar = yield* Ref.make(Cookies.empty)
  return yield* HttpApiClient.make(Api, { transformClient: HttpClient.withCookiesRef(jar) })
})

// A browser whose cookies the test can read, to replay an old unlock.
export const openInspectableBrowser = Effect.gen(function*() {
  const jar = yield* Ref.make(Cookies.empty)
  const api = yield* HttpApiClient.make(Api, { transformClient: HttpClient.withCookiesRef(jar) })
  const cookie = (name: string) => Ref.get(jar).pipe(Effect.map((cookies) => Cookies.getValue(cookies, name)))
  return { api, cookie }
})

// GET with a given Cookie header, as a browser holding that cookie would send.
export const getWithCookie = (path: string, cookie: string) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(HttpClientRequest.get(path).pipe(HttpClientRequest.setHeader("cookie", cookie)))
    return response.status
  })

// This computer's network as a test sets it: no address on a network until
// the test gives one, and a request from the address its X-Test-Remote
// header names, so a test can be another device on the network.
export const TestRemoteHeader = "x-test-remote"

export class TestNetwork extends Context.Service<TestNetwork, {
  setAddresses(addresses: ReadonlyArray<NetworkAddress>): Effect.Effect<void>
}>()("gmat-prep/test/TestNetwork") {}

const NetworkTest = Layer.unwrap(
  Effect.sync(() => {
    let addresses: ReadonlyArray<NetworkAddress> = [{ address: "127.0.0.1", family: "IPv4", internal: true }]
    return Layer.mergeAll(
      Layer.succeed(
        Network,
        Network.of({
          addresses: () => addresses,
          hostname: () => "study-pc",
          remoteOf: (request) => request.headers[TestRemoteHeader] ?? Option.getOrUndefined(request.remoteAddress)
        })
      ),
      Layer.succeed(TestNetwork, TestNetwork.of({ setAddresses: (next) => Effect.sync(() => void (addresses = next)) }))
    )
  })
)

// The real routes and services on an ephemeral port, with a fake clock and no
// worker process.
export const appLayer = (dataDir: string) =>
  HttpRouter.serve(AppRoutes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provide(AppServices),
    Layer.provide(WorkerSupervisor.layerIdle),
    Layer.provide(AppConfig.layer({ dataDir, preferredPort: 0 })),
    Layer.provide(LlmTransportFake),
    Layer.provide(SnapshotCopierTest),
    Layer.provide(NetworkTest),
    Layer.provideMerge(BunHttpServer.layerTest),
    Layer.provideMerge(TestClock.layer())
  )

export const runWithApp = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient | HttpServer.HttpServer>,
  dataDir: string = tempDataDir()
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(appLayer(dataDir))))

// Snapshot copies in this process, the next ones failing with the details a
// test queues, as a full disk would make them.
export class CopierFaults extends Context.Service<CopierFaults, {
  failNext(...details: ReadonlyArray<string>): Effect.Effect<void>
}>()("gmat-prep/test/CopierFaults") {}

const SnapshotCopierTest = Layer.unwrap(
  Effect.gen(function*() {
    const faults = yield* Ref.make<ReadonlyArray<string>>([])
    const real = yield* SnapshotCopier.pipe(Effect.provide(SnapshotCopierInProcess))
    const nextFault = Ref.modify(faults, (queued) => [queued[0], queued.slice(1)] as const)
    return Layer.mergeAll(
      Layer.succeed(
        SnapshotCopier,
        SnapshotCopier.of({
          ...real,
          copy: (from, to) =>
            nextFault.pipe(Effect.flatMap((detail) => detail === undefined ? real.copy(from, to) : Effect.fail(new SnapshotWorkFailed({ detail }))))
        })
      ),
      Layer.succeed(CopierFaults, CopierFaults.of({ failNext: (...details) => Ref.update(faults, (queued) => [...queued, ...details]) }))
    )
  })
)

// Starts job workers in this process, each on its own database connection
// with its own worker id, as separate worker processes would be. They share
// the fake LLM. A worker's fiber can be interrupted to stand in for killing it.
export class TestWorkers extends Context.Service<TestWorkers, {
  readonly start: Effect.Effect<Fiber.Fiber<never, unknown>>
}>()("gmat-prep/test/TestWorkers") {}

const testWorkersLayer = (kinds: ReadonlyArray<AnyJobKind>) =>
  Layer.effect(
    TestWorkers,
    Effect.gen(function*() {
      const transport = yield* LlmTransport
      const config = yield* AppConfig
      const services = workerServices(Layer.succeed(LlmTransport, transport), JobKinds.layer(kinds)).pipe(
        Layer.provide(Layer.succeed(AppConfig, config))
      )
      return TestWorkers.of({ start: Effect.forkChild(JobRunner.loop.pipe(Effect.provide(services))) })
    })
  )

// What a test with workers can use: the server's services, the fake LLM the
// workers call, the workers, and the HTTP client and server.
export type WorkerTestServices =
  | HttpClient.HttpClient
  | HttpServer.HttpServer
  | FakeLlm
  | LlmTransport
  | TestWorkers
  | JobStore
  | Settings
  | ApiKeyStore
  | Db
  | AppConfig
  | Snapshots
  | CopierFaults
  | FigureFiles
  | ErrorLog
  | TestNetwork

// Sets the fake clock before the app starts, as a start later in the day.
const clockStartsAt = (millis: number | undefined) =>
  millis === undefined ? Layer.empty : Layer.effectDiscard(TestClock.setTime(millis))

export const appWithWorkersLayer = (dataDir: string, kinds: ReadonlyArray<AnyJobKind>, startAt?: number) => {
  const server = HttpRouter.serve(AppRoutes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provideMerge(makeAppServices(JobKinds.layer(kinds))),
    Layer.provide(WorkerSupervisor.layerIdle),
    Layer.provideMerge(SnapshotCopierTest),
    Layer.provideMerge(NetworkTest),
    Layer.provideMerge(AppConfig.layer({ dataDir, preferredPort: 0 })),
    Layer.provideMerge(BunHttpServer.layerTest),
    Layer.provideMerge(clockStartsAt(startAt)),
    Layer.provideMerge(TestClock.layer())
  )
  return testWorkersLayer(kinds).pipe(Layer.provideMerge(server), Layer.provideMerge(LlmTransportFake))
}

// The app with no worker running; the test starts workers when it wants them.
// startAt sets the fake clock before the app starts.
export const runWithWorkers = <A, E>(
  effect: Effect.Effect<A, E, WorkerTestServices>,
  kinds: ReadonlyArray<AnyJobKind> = [ConnectionTest],
  dataDir: string = tempDataDir(),
  startAt?: number
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(appWithWorkersLayer(dataDir, kinds, startAt))))

// The app with one worker already running.
export const runWithWorker = <A, E>(
  effect: Effect.Effect<A, E, WorkerTestServices>,
  kinds: ReadonlyArray<AnyJobKind> = [ConnectionTest],
  dataDir: string = tempDataDir()
): Promise<A> =>
  runWithWorkers(
    Effect.gen(function*() {
      yield* (yield* TestWorkers).start
      return yield* effect
    }),
    kinds,
    dataDir
  )

// Moves the fake clock forward a step at a time until the check passes, giving
// the server, the worker and HTTP round trips time to run in between.
export const advanceUntil = <A, E, R>(
  check: Effect.Effect<A | undefined, E, R>,
  options: { readonly step?: Duration.Input; readonly maxSteps?: number } = {}
): Effect.Effect<A, E | Error, R> =>
  Effect.gen(function*() {
    const maxSteps = options.maxSteps ?? 120
    for (let i = 0; i <= maxSteps; i++) {
      yield* Effect.promise(() => Bun.sleep(2))
      const value = yield* check
      if (value !== undefined) return value
      yield* TestClock.adjust(options.step ?? "1 second")
    }
    return yield* Effect.fail(new Error("the condition was not met in time"))
  })
