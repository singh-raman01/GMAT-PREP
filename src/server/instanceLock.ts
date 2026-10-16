import { Effect, Layer, Schema } from "effect"
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AppConfig } from "./AppConfig.ts"

export class AlreadyRunning extends Schema.TaggedError<AlreadyRunning>()("AlreadyRunning", {
  pid: Schema.Int,
  dataDir: Schema.String
}) {}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const readPid = (file: string): number | undefined => {
  try {
    const pid = Number.parseInt(readFileSync(file, "utf8"), 10)
    return Number.isInteger(pid) ? pid : undefined
  } catch {
    return undefined
  }
}

// Holds the data folder for this process. A lock left by a process that no
// longer exists is taken over.
export const InstanceLockLive = Layer.effectDiscard(
  Effect.gen(function*() {
    const { dataDir } = yield* AppConfig
    const file = join(dataDir, "gmat-prep.lock")
    yield* Effect.acquireRelease(
      Effect.gen(function*() {
        yield* Effect.sync(() => mkdirSync(dataDir, { recursive: true }))
        const created = yield* Effect.sync(() => {
          try {
            writeFileSync(file, String(process.pid), { flag: "wx" })
            return true
          } catch {
            return false
          }
        })
        if (created) return
        const holder = readPid(file)
        if (holder !== undefined && holder !== process.pid && isAlive(holder)) {
          return yield* new AlreadyRunning({ pid: holder, dataDir })
        }
        yield* Effect.sync(() => writeFileSync(file, String(process.pid)))
      }),
      () =>
        Effect.sync(() => {
          if (readPid(file) === process.pid) unlinkSync(file)
        })
    )
  })
)
