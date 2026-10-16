import { Context, Effect, Layer, Ref } from "effect"
import { WorkerStatus } from "../../api/Api.ts"
import { AppConfig } from "../AppConfig.ts"

// The job worker is this same executable started with the "worker" argument.
export const workerCommand = (): ReadonlyArray<string> =>
  Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/")
    ? [process.execPath, "worker"]
    : [process.execPath, Bun.main, "worker"]

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
  static readonly layer = Layer.effect(
    WorkerSupervisor,
    Effect.gen(function*() {
      const { dataDir } = yield* AppConfig
      const state = yield* Ref.make<State>({ running: false, pid: null, restarts: 0 })
      const command = [...workerCommand()]

      const runOnce = Effect.gen(function*() {
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.spawn(command, {
              env: { ...process.env, GMAT_PREP_DATA_DIR: dataDir, GMAT_PREP_PARENT_PID: String(process.pid) },
              // Never written; the worker exits when this pipe closes.
              stdin: "pipe",
              stdout: "inherit",
              stderr: "inherit"
            })
          ),
          (spawned) => Effect.sync(() => spawned.kill())
        )
        yield* Ref.update(state, (s) => ({ ...s, running: true, pid: child.pid }))
        const code = yield* Effect.promise(() => child.exited)
        yield* Ref.update(state, (s) => ({ ...s, running: false, pid: null, restarts: s.restarts + 1 }))
        yield* Effect.logWarning(`Job worker exited with code ${code}; restarting`)
      }).pipe(Effect.scoped)

      yield* Effect.forkScoped(
        runOnce.pipe(Effect.andThen(Effect.sleep("1 second")), Effect.forever)
      )

      return WorkerSupervisor.of({
        status: Ref.get(state).pipe(Effect.map((s) => new WorkerStatus(s)))
      })
    })
  )
}
