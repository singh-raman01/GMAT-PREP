import { BunHttpServer } from "@effect/platform-bun"
import { Effect, Layer, Ref } from "effect"
import { Cookies, HttpClient, HttpRouter } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Api } from "../src/api/Api.ts"
import { AppConfig } from "../src/server/AppConfig.ts"
import { AppRoutes, AppServices } from "../src/server/app.ts"
import { WorkerSupervisor } from "../src/server/worker/WorkerSupervisor.ts"

export const tempDataDir = () => mkdtempSync(join(tmpdir(), "gmat-prep-test-"))

// One browser: a typed API client with its own cookie jar.
export const openBrowser = Effect.gen(function*() {
  const jar = yield* Ref.make(Cookies.empty)
  return yield* HttpApiClient.make(Api, { transformClient: HttpClient.withCookiesRef(jar) })
})

// The real routes and services on an ephemeral port, with a fake clock and no
// worker process.
export const appLayer = (dataDir: string) =>
  HttpRouter.serve(AppRoutes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provide(AppServices),
    Layer.provide(WorkerSupervisor.layerIdle),
    Layer.provide(AppConfig.layer({ dataDir, preferredPort: 0 })),
    Layer.provideMerge(BunHttpServer.layerTest),
    Layer.provideMerge(TestClock.layer())
  )

export const runWithApp = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  dataDir: string = tempDataDir()
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(appLayer(dataDir))))
