import { Database } from "bun:sqlite"
import { Effect, Layer, Schema } from "effect"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AppConfig } from "./AppConfig.ts"

// One server per data folder. The lock is an exclusive SQLite lock on a small
// file of its own, which the operating system releases when the process ends
// in any way, so a crash never leaves the folder locked. The process id is
// written beside it only to name the holder in the error message.

export class AlreadyRunning extends Schema.TaggedError<AlreadyRunning>()("AlreadyRunning", {
  pid: Schema.NullOr(Schema.Int),
  dataDir: Schema.String
}) {}

const readPid = (file: string): number | null => {
  try {
    const pid = Number.parseInt(readFileSync(file, "utf8"), 10)
    return Number.isInteger(pid) ? pid : null
  } catch {
    return null
  }
}

export const InstanceLockLive = Layer.effectDiscard(
  Effect.gen(function*() {
    const { dataDir } = yield* AppConfig
    const lockFile = join(dataDir, "instance.lock")
    const pidFile = join(dataDir, "instance.pid")
    yield* Effect.acquireRelease(
      Effect.gen(function*() {
        yield* Effect.sync(() => mkdirSync(dataDir, { recursive: true }))
        const lock = yield* Effect.sync(() => {
          const db = new Database(lockFile, { create: true })
          try {
            // In exclusive mode the lock taken by the first write is kept until
            // the connection closes.
            db.run("PRAGMA locking_mode = EXCLUSIVE")
            db.run("BEGIN EXCLUSIVE")
            db.run("COMMIT")
            return db
          } catch {
            db.close()
            return null
          }
        })
        if (lock === null) {
          return yield* new AlreadyRunning({ pid: readPid(pidFile), dataDir })
        }
        yield* Effect.sync(() => writeFileSync(pidFile, String(process.pid)))
        return lock
      }),
      (lock) =>
        Effect.sync(() => {
          if (readPid(pidFile) === process.pid) rmSync(pidFile, { force: true })
          lock.close()
        })
    )
  })
)
