import { Context, Effect, Layer, Schema } from "effect"
import { bundledMigrations } from "../db/migrations/index.gen.ts"
import {
  checkDatabase,
  copyDatabase,
  type CopiedFile,
  hashFile,
  inspectDatabase,
  type InspectedFile,
  migrateCopy,
  type MigrateOutcome
} from "./files.ts"

// Work on database files away from the server's requests (decision 111): a
// snapshot of a large database takes seconds, which the server must not
// spend blocked, so production runs it in a short process of this same
// executable; tests run it in process.

export class SnapshotWorkFailed extends Schema.TaggedError<SnapshotWorkFailed>()("SnapshotWorkFailed", {
  detail: Schema.String
}) {}

export class SnapshotCopier extends Context.Service<SnapshotCopier, {
  // A consistent copy of a database file in a new file, checked and written
  // to the disk, with its size and SHA-256.
  copy(from: string, to: string): Effect.Effect<CopiedFile, SnapshotWorkFailed>
  // SQLite's integrity check, full or quick: "ok" or the problems found.
  check(file: string, quick: boolean): Effect.Effect<string, SnapshotWorkFailed>
  // What a file found in the snapshots folder holds: its size and SHA-256,
  // SQLite's quick check, and how many migrations it records.
  inspect(file: string): Effect.Effect<InspectedFile, SnapshotWorkFailed>
  // Brings a copy of a snapshot to this build's schema.
  migrate(file: string, now: number): Effect.Effect<MigrateOutcome, SnapshotWorkFailed>
  hash(file: string): Effect.Effect<string, SnapshotWorkFailed>
}>()("gmat-prep/server/SnapshotCopier") {}

const failed = (cause: unknown) => new SnapshotWorkFailed({ detail: cause instanceof Error ? cause.message : String(cause) })

export const SnapshotCopierInProcess = Layer.succeed(
  SnapshotCopier,
  SnapshotCopier.of({
    copy: (from, to) => Effect.tryPromise({ try: () => copyDatabase(from, to), catch: failed }),
    check: (file, quick) => Effect.try({ try: () => checkDatabase(file, quick), catch: failed }),
    inspect: (file) => Effect.tryPromise({ try: () => inspectDatabase(file), catch: failed }),
    migrate: (file, now) => Effect.try({ try: () => migrateCopy(file, bundledMigrations, now), catch: failed }),
    hash: (file) => Effect.tryPromise({ try: () => hashFile(file), catch: failed })
  })
)

// This executable with a command: compiled, or run as a script by bun.
export const commandOf = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/")
    ? [process.execPath, ...args]
    : [process.execPath, Bun.main, ...args]

// Runs one of the commands in `fileCommand` and reads its answer as JSON.
// Interrupted, as when the app stops, it ends the process too, so no copy
// or check outlives the app; a copy cut short leaves only a temporary file,
// which the next start removes.
const runCommand = <A>(args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: async (signal) => {
      const child = Bun.spawn([...commandOf(args)], { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal })
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      if (code !== 0) throw new Error(err.trim() === "" ? `The ${args[0]} step stopped with code ${code}.` : err.trim())
      return JSON.parse(out) as A
    },
    catch: failed
  })

export const SnapshotCopierProcess = Layer.succeed(
  SnapshotCopier,
  SnapshotCopier.of({
    copy: (from, to) => runCommand<CopiedFile>(["snapshot-copy", from, to]),
    check: (file, quick) => runCommand<string>(["snapshot-check", file, quick ? "quick" : "full"]),
    inspect: (file) => runCommand<InspectedFile>(["snapshot-inspect", file]),
    migrate: (file, now) => runCommand<MigrateOutcome>(["snapshot-migrate", file, String(now)]),
    hash: (file) => runCommand<string>(["snapshot-hash", file])
  })
)

// The commands themselves, in the short process: each prints its answer as
// JSON, or its error, and exits.
export const fileCommand = async (args: ReadonlyArray<string>) => {
  const [command, first, second] = args
  try {
    const answer = command === "snapshot-copy"
      ? await copyDatabase(first!, second!)
      : command === "snapshot-check"
      ? checkDatabase(first!, second === "quick")
      : command === "snapshot-inspect"
      ? await inspectDatabase(first!)
      : command === "snapshot-migrate"
      ? migrateCopy(first!, bundledMigrations, Number(second))
      : await hashFile(first!)
    process.stdout.write(JSON.stringify(answer))
    process.exit(0)
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
