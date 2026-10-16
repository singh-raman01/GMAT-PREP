import { Clock, Context, Effect, Layer, Ref } from "effect"
import { WorkerStatus } from "../../api/Api.ts"
import { AppConfig } from "../AppConfig.ts"

// The job worker is this same executable started with the "worker" argument.
export const workerCommand = (): ReadonlyArray<string> =>
  Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/")
    ? [process.execPath, "worker"]
    : [process.execPath, Bun.main, "worker"]

export interface SpawnedWorker {
  readonly pid: number
  readonly exited: Promise<number>
  kill(): void
}

// Starts a worker process; throws when the process cannot be started.
export type SpawnWorker = (command: ReadonlyArray<string>, env: Record<string, string | undefined>) => SpawnedWorker

const spawnWithBun: SpawnWorker = (command, env) =>
  Bun.spawn([...command], {
    env,
    // Never written; the worker exits when this pipe closes.
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit"
  })

// A worker that ran this long was healthy, so a crash after it restarts at once.
const HealthyRunMs = 30_000
const MaxRestartDelayMs = 60_000

// After a quick crash, or a failure to start, each wait is twice the last.
export const restartDelayMs = (quickFailures: number) =>
  quickFailures === 0 ? 1000 : Math.min(MaxRestartDelayMs, 1000 * 2 ** quickFailures)

interface State {
  readonly running: boolean
  readonly pid: number | null
  readonly restarts: number
}

export class WorkerSupervisor extends Context.Service<WorkerSupervisor, {
  readonly status: Effect.Effect<WorkerStatus>
}>()("gmat-prep/server/WorkerSupervisor") {
  // For tests that exercise the API without a worker process.
  static readonly layerIdle = Layer.succeed(
    WorkerSupervisor,
    WorkerSupervisor.of({ status: Effect.succeed(new WorkerStatus({ running: false, pid: null, restarts: 0 })) })
  )

  // Starts the worker and restarts it whenever it exits. Closing the scope
  // (server shutdown) stops the worker.
  static readonly layerWith = (spawn: SpawnWorker) =>
    Layer.effect(
      WorkerSupervisor,
      Effect.gen(function*() {
        const { configDir, dataDir } = yield* AppConfig
        const state = yield* Ref.make<State>({ running: false, pid: null, restarts: 0 })
        const command = workerCommand()
        const env = {
          ...process.env,
          GMAT_PREP_DATA_DIR: dataDir,
          GMAT_PREP_CONFIG_DIR: configDir,
          GMAT_PREP_PARENT_PID: String(process.pid)
        }

        // Runs one worker until it exits, and says how long it ran.
        const runOnce = Effect.gen(function*() {
          const startedAt = yield* Clock.currentTimeMillis
          const child = yield* Effect.acquireRelease(
            Effect.try({ try: () => spawn(command, env), catch: (cause) => cause }),
            (spawned) => Effect.sync(() => spawned.kill())
          )
          yield* Ref.update(state, (s) => ({ ...s, running: true, pid: child.pid }))
          const code = yield* Effect.promise(() => child.exited)
          yield* Ref.update(state, (s) => ({ ...s, running: false, pid: null, restarts: s.restarts + 1 }))
          yield* Effect.logWarning(`Job worker exited with code ${code}; restarting`)
          return (yield* Clock.currentTimeMillis) - startedAt
        }).pipe(Effect.scoped)

        const supervise = Effect.gen(function*() {
          let quickFailures = 0
          for (;;) {
            const outcome = yield* Effect.result(runOnce)
            if (outcome._tag === "Failure") {
              yield* Effect.logError(`The job worker could not be started: ${String(outcome.failure)}`)
              quickFailures += 1
            } else {
              quickFailures = outcome.success >= HealthyRunMs ? 0 : quickFailures + 1
            }
            yield* Effect.sleep(restartDelayMs(quickFailures))
          }
        })

        yield* Effect.forkScoped(supervise)

        return WorkerSupervisor.of({
          status: Ref.get(state).pipe(Effect.map((s) => new WorkerStatus(s)))
        })
      })
    )

  static readonly layer = WorkerSupervisor.layerWith(spawnWithBun)
}
