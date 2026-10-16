import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { AppConfig } from "../src/server/AppConfig.ts"
import { type SpawnWorker, WorkerSupervisor } from "../src/server/worker/WorkerSupervisor.ts"
import { tempDataDir } from "./harness.ts"

// The supervisor with a stand-in for spawning, on a fake clock.
const supervise = <A>(spawn: SpawnWorker, test: Effect.Effect<A, never, WorkerSupervisor>) =>
  Effect.runPromise(
    test.pipe(
      Effect.provide(
        WorkerSupervisor.layerWith(spawn).pipe(
          Layer.provide(AppConfig.layer({ dataDir: tempDataDir(), preferredPort: 0 })),
          Layer.provideMerge(TestClock.layer())
        )
      )
    )
  )

// Lets forked fibers and promise callbacks run.
const settle = Effect.promise(() => Bun.sleep(5))

const at = (seconds: number) => TestClock.setTime(seconds * 1000).pipe(Effect.andThen(settle))

describe("Worker supervision", () => {
  test("a worker that could not be started is tried again", async () => {
    let calls = 0
    const spawn: SpawnWorker = () => {
      calls += 1
      if (calls === 1) throw new Error("EAGAIN: resource temporarily unavailable")
      return { pid: 4242, exited: new Promise<number>(() => {}), kill: () => {} }
    }
    const status = await supervise(spawn, Effect.gen(function*() {
      const supervisor = yield* WorkerSupervisor
      yield* settle
      const afterFailure = yield* supervisor.status
      yield* at(10)
      return { afterFailure, later: yield* supervisor.status }
    }))
    expect(status.afterFailure.running).toBe(false)
    expect(status.later).toMatchObject({ running: true, pid: 4242 })
    expect(calls).toBe(2)
  })

  test("a worker that keeps crashing at start is restarted less and less often", async () => {
    let spawns = 0
    const spawn: SpawnWorker = () => {
      spawns += 1
      return { pid: 1, exited: Promise.resolve(1), kill: () => {} }
    }
    const spawnsBy = await supervise(spawn, Effect.gen(function*() {
      const counts: Array<number> = []
      for (const second of [0, 1.9, 2, 5.9, 6, 13.9, 14]) {
        yield* at(second)
        counts.push(spawns)
      }
      return counts
    }))
    // Waits of 2, 4 and 8 seconds after each quick crash.
    expect(spawnsBy).toEqual([1, 1, 2, 2, 3, 3, 4])
  })
})
