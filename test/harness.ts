import { BunHttpServer } from "@effect/platform-bun"
import { Context, type Duration, Effect, type Fiber, Layer, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest, HttpRouter, type HttpServer } from "effect/http"
import type { SqlClient } from "effect/sql"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Api } from "../src/api/Api.ts"
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

export const tempDataDir = () => mkdtempSync(join(tmpdir(), "gmat-prep-test-"))

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

// The real routes and services on an ephemeral port, with a fake clock and no
// worker process.
export const appLayer = (dataDir: string) =>
  HttpRouter.serve(AppRoutes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provide(AppServices),
    Layer.provide(WorkerSupervisor.layerIdle),
    Layer.provide(AppConfig.layer({ dataDir, preferredPort: 0 })),
    Layer.provide(LlmTransportFake),
    Layer.provide(SnapshotCopierTest),
    Layer.provideMerge(BunHttpServer.layerTest),
    Layer.provideMerge(TestClock.layer())
  )

export const runWithApp = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient | HttpServer.HttpServer>,
  dataDir: string = tempDataDir()
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(appLayer(dataDir))))

// Snapshot copies in this process, the next ones failing with the details a
// test queues, as a full disk would make them. A test can also fail the next
// checks, as a check that cannot start would, and run an effect at the
// moment a copy to a given file starts, as a request arriving while a real
// copy process works would.
export class CopierFaults extends Context.Service<CopierFaults, {
  failNext(...details: ReadonlyArray<string>): Effect.Effect<void>
  failNextCheck(...details: ReadonlyArray<string>): Effect.Effect<void>
  // Once, before the copy to the first file whose path matches.
  onCopy(to: RegExp, effect: Effect.Effect<void>): Effect.Effect<void>
}>()("gmat-prep/test/CopierFaults") {}

const SnapshotCopierTest = Layer.unwrap(
  Effect.gen(function*() {
    const faults = yield* Ref.make<ReadonlyArray<string>>([])
    const checkFaults = yield* Ref.make<ReadonlyArray<string>>([])
    const hooks = yield* Ref.make<ReadonlyArray<{ readonly to: RegExp; readonly effect: Effect.Effect<void> }>>([])
    const real = yield* SnapshotCopier.pipe(Effect.provide(SnapshotCopierInProcess))
    const next = (queue: Ref.Ref<ReadonlyArray<string>>) => Ref.modify(queue, (queued) => [queued[0], queued.slice(1)] as const)
    const hookFor = (to: string) =>
      Ref.modify(hooks, (queued) => {
        const index = queued.findIndex((hook) => hook.to.test(to))
        return index === -1 ? [Effect.void, queued] as const : [queued[index]!.effect, queued.toSpliced(index, 1)] as const
      })
    return Layer.mergeAll(
      Layer.succeed(
        SnapshotCopier,
        SnapshotCopier.of({
          ...real,
          copy: (from, to) =>
            Effect.gen(function*() {
              yield* Effect.flatten(hookFor(to))
              const detail = yield* next(faults)
              return detail === undefined ? yield* real.copy(from, to) : yield* new SnapshotWorkFailed({ detail })
            }),
          check: (file, quick) =>
            next(checkFaults).pipe(
              Effect.flatMap((detail) => detail === undefined ? real.check(file, quick) : Effect.fail(new SnapshotWorkFailed({ detail })))
            )
        })
      ),
      Layer.succeed(
        CopierFaults,
        CopierFaults.of({
          failNext: (...details) => Ref.update(faults, (queued) => [...queued, ...details]),
          failNextCheck: (...details) => Ref.update(checkFaults, (queued) => [...queued, ...details]),
          onCopy: (to, effect) => Ref.update(hooks, (queued) => [...queued, { to, effect }])
        })
      )
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
  | SqlClient.SqlClient

// Sets the fake clock before the app starts, as a start later in the day.
const clockStartsAt = (millis: number | undefined) =>
  millis === undefined ? Layer.empty : Layer.effectDiscard(TestClock.setTime(millis))

export const appWithWorkersLayer = (dataDir: string, kinds: ReadonlyArray<AnyJobKind>, startAt?: number) => {
  const server = HttpRouter.serve(AppRoutes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provideMerge(makeAppServices(JobKinds.layer(kinds))),
    Layer.provide(WorkerSupervisor.layerIdle),
    Layer.provideMerge(SnapshotCopierTest),
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
