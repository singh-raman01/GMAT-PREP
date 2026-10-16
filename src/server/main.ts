import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Config, Effect, Layer, Option } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AppConfig } from "./AppConfig.ts"
import { AppRoutes, AppServices } from "./app.ts"
import { InstanceLockLive } from "./instanceLock.ts"
import { WorkerMain } from "./worker/main.ts"
import { WorkerSupervisor } from "./worker/WorkerSupervisor.ts"

const Host = "127.0.0.1"

// The preferred port, or the next free one within 20 tries.
const findFreePort = (preferred: number) =>
  Effect.sync(() => {
    for (let port = preferred; port < preferred + 20; port++) {
      try {
        Bun.serve({ hostname: Host, port, fetch: () => new Response() }).stop(true)
        return port
      } catch {
        continue
      }
    }
    return 0
  })

const ServerLive = Layer.unwrap(
  Effect.gen(function*() {
    const { preferredPort } = yield* AppConfig
    const port = yield* findFreePort(preferredPort)
    if (port !== preferredPort) {
      yield* Effect.logWarning(`Port ${preferredPort} is taken; using ${port === 0 ? "a free port" : port}`)
    }
    return HttpRouter.serve(AppRoutes, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provideMerge(BunHttpServer.layer({ hostname: Host, port }))
    )
  })
)

// Writes server.json so tools and tests can find the running server.
const AnnounceLive = Layer.effectDiscard(
  Effect.gen(function*() {
    const { dataDir } = yield* AppConfig
    const server = yield* HttpServer.HttpServer
    const address = server.address
    const port = address._tag === "UnixPathAddress" ? 0 : address.port
    const url = `http://${Host}:${port}`
    const file = join(dataDir, "server.json")
    // runId lets the script that started this server tell its server.json
    // from one left by an earlier run.
    const runId = Option.getOrNull(yield* Config.String("GMAT_PREP_RUN_ID").pipe(Config.option))
    yield* Effect.acquireRelease(
      Effect.sync(() => writeFileSync(file, JSON.stringify({ pid: process.pid, port, url, runId }))),
      () => Effect.sync(() => rmSync(file, { force: true }))
    )
    yield* Effect.logInfo(`GMAT prep is running at ${url}`)
  })
)

const MainLive = AnnounceLive.pipe(
  Layer.provideMerge(ServerLive),
  Layer.provide(WorkerSupervisor.layer),
  Layer.provide(AppServices),
  Layer.provide(InstanceLockLive),
  Layer.provide(AppConfig.layerFromEnv)
)

// Messages along an error's cause chain, outermost first.
const causeMessages = (error: unknown): ReadonlyArray<string> => {
  const messages: Array<string> = []
  let current: unknown = error
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth++) {
    const message = (current as { readonly message?: unknown }).message
    if (typeof message === "string") messages.push(message)
    current = (current as { readonly cause?: unknown }).cause
  }
  return messages
}

// Plain-language reasons for the startup failures a Learner can meet.
const explainStartupFailure = (error: unknown): string | undefined => {
  const tagged = error as { readonly _tag?: string; readonly message?: string }
  switch (tagged._tag) {
    case "AlreadyRunning": {
      const { pid, dataDir } = error as { pid: number | null; dataDir: string }
      return `GMAT prep is already running${pid === null ? "" : ` (process ${pid})`} on the data folder ${dataDir}.`
    }
    case "MigrationBrokeReferences": {
      const { migration } = error as { migration: string }
      return `Updating the database stopped at ${migration}, which would have broken links between records. Nothing was changed; report this, and keep using the previous version of GMAT prep.`
    }
    case "NewerDatabase":
      return "This data folder was written by a newer version of GMAT prep. Install that version, or restore a snapshot."
    case "DatabaseCorrupt":
      return "The database file is damaged. Restore a snapshot from the data folder's snapshots folder."
    case "SqlError": {
      const messages = causeMessages(error)
      // SQLite says "file is not a database" for a file that is something else,
      // and "database disk image is malformed" for one with a damaged page.
      return messages.some((message) => message.includes("not a database") || message.includes("malformed"))
        ? "The database file is damaged or is not a GMAT prep database. Restore a snapshot from the data folder's snapshots folder."
        : `The database could not be opened: ${messages.at(-1) ?? "unknown error"}`
    }
    default:
      return undefined
  }
}

const runServer = Layer.launch(MainLive).pipe(
  Effect.tapError((error) => {
    const reason = explainStartupFailure(error)
    return reason === undefined ? Effect.void : Effect.logError(reason)
  })
)

// Everything the app writes (database, snapshots, Books) is private to the
// user who runs it; the worker inherits this.
const keepFilesPrivate = () => {
  if (process.platform !== "win32") process.umask(0o077)
}

export const main = () => {
  keepFilesPrivate()
  const isWorker = process.argv.slice(2).includes("worker")
  if (isWorker) {
    BunRuntime.runMain(WorkerMain)
  } else {
    BunRuntime.runMain(runServer)
  }
}

if (import.meta.main) {
  main()
}
