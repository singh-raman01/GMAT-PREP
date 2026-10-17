import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Database } from "bun:sqlite"
import * as SQLiteBunDrizzle from "drizzle-orm/effect-sqlite-bun"
import { Clock, Context, Effect, Layer, Schedule, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs"
import { join } from "node:path"
import { AppConfig } from "../AppConfig.ts"
import { SnapshotFolder, snapshotFileName } from "../snapshots/names.ts"
import { inRollbackMode, moveIntoPlace, PartSuffix, removeWorkFile, syncFile } from "../snapshots/workFiles.ts"
import { bundledMigrations } from "./migrations/index.gen.ts"

export class DatabaseCorrupt extends Schema.TaggedError<DatabaseCorrupt>()("DatabaseCorrupt", {
  detail: Schema.String
}) {}

export class NewerDatabase extends Schema.TaggedError<NewerDatabase>()("NewerDatabase", {
  unknownMigrations: Schema.Array(Schema.String)
}) {}

export class Db extends Context.Service<Db, SQLiteBunDrizzle.EffectSQLiteBunDatabase>()("gmat-prep/server/Db") {}

export const databaseFile = (dataDir: string) => join(dataDir, "gmat-prep.sqlite")

// A database file in rollback-journal mode, as one unpacked from an archive
// or copied from a snapshot is, has no write-ahead log of its own. A log
// beside it was left by the database that stood there before, and SQLite
// would replay it onto this one, so it is set aside, with its index, under a
// name that says when.
const setAsideForeignLog = (file: string) =>
  Effect.gen(function*() {
    const log = `${file}-wal`
    if (!existsSync(log) || statSync(log).size === 0 || !inRollbackMode(file)) return
    const stamp = new Date(yield* Clock.currentTimeMillis).toISOString().replace(/[:.]/g, "-")
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${file}${suffix}`)) renameSync(`${file}${suffix}`, `${file}${suffix}-set-aside-${stamp}`)
    }
    yield* Effect.logWarning(
      `The write-ahead log beside the database belongs to another database, so it was set aside as ${log}-set-aside-${stamp}.`
    )
  })

const SqliteLive = Layer.unwrap(
  Effect.gen(function*() {
    const { dataDir } = yield* AppConfig
    yield* Effect.sync(() => mkdirSync(dataDir, { recursive: true }))
    yield* setAsideForeignLog(databaseFile(dataDir))
    return SqliteClient.layer({ filename: databaseFile(dataDir) })
  })
)

export class SnapshotBeforeUpdateFailed extends Schema.TaggedError<SnapshotBeforeUpdateFailed>()(
  "SnapshotBeforeUpdateFailed",
  { detail: Schema.String, diskFull: Schema.Boolean }
) {}

// The messages and codes along an error's causes, as SQLite's own text sits
// below the SQL client's.
export const causeText = (error: unknown) => {
  const parts: Array<string> = []
  let current: unknown = error
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth++) {
    const { message, code } = current as { readonly message?: unknown; readonly code?: unknown }
    if (typeof message === "string") parts.push(message)
    if (typeof code === "string") parts.push(code)
    current = (current as { readonly cause?: unknown }).cause
  }
  return parts.join(": ")
}

export const isDiskFull = (detail: string) => /database or disk is full|no space left on device|ENOSPC|SQLITE_FULL/i.test(detail)

// Copies a consistent image of the live database into the snapshots folder:
// under a temporary name until SQLite's check passes and it is on the disk,
// then under its own. Nothing is left behind when it fails.
export const takeSnapshot = Effect.fn("takeSnapshot")(function*(kind: string) {
  const { dataDir } = yield* AppConfig
  const sql = yield* SqlClient.SqlClient
  const now = yield* Clock.currentTimeMillis
  const folder = join(dataDir, SnapshotFolder)
  const name = snapshotFileName(kind, now, crypto.randomUUID().slice(0, 8))
  const part = join(folder, `${name}${PartSuffix}`)
  return yield* Effect.gen(function*() {
    yield* Effect.try({ try: () => mkdirSync(folder, { recursive: true }), catch: (cause) => cause })
    yield* sql`VACUUM INTO ${part}`
    yield* Effect.try({
      try: () => {
        const copy = new Database(part, { readonly: true })
        let verdict: string
        try {
          verdict = (copy.query("PRAGMA quick_check").values() as Array<[string]>).map((row) => row[0]).join("; ")
        } finally {
          copy.close()
        }
        if (verdict !== "ok") throw new Error(`The copy failed SQLite's check: ${verdict}`)
        syncFile(part)
        moveIntoPlace(part, join(folder, name))
      },
      catch: (cause) => cause
    })
    return name
  }).pipe(
    Effect.onError(() => Effect.sync(() => removeWorkFile(part))),
    Effect.mapError((cause) => {
      const detail = causeText(cause)
      return new SnapshotBeforeUpdateFailed({ detail, diskFull: isDiskFull(detail) })
    })
  )
})

const checkIntegrity = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ readonly quick_check: string }>`PRAGMA quick_check`
  const verdict = rows.map((row) => row.quick_check).join("; ")
  if (verdict !== "ok") {
    return yield* new DatabaseCorrupt({ detail: verdict })
  }
})

export interface Migration {
  readonly name: string
  readonly sql: string
}

export class MigrationBrokeReferences extends Schema.TaggedError<MigrationBrokeReferences>()(
  "MigrationBrokeReferences",
  { migration: Schema.String, brokenReferences: Schema.Int }
) {}

// drizzle-kit separates the statements of a migration with this marker.
export const StatementBreak = "--> statement-breakpoint"

// The migration's timestamp, from the start of its folder name.
export const migrationTime = (name: string) => {
  const stamp = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
  return stamp === null ? 0 : Date.UTC(+stamp[1]!, +stamp[2]! - 1, +stamp[3]!, +stamp[4]!, +stamp[5]!, +stamp[6]!)
}

export const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")

// Applies migrations, each in its own transaction, recorded in drizzle's
// table. Foreign keys are off while they run: SQLite ignores a foreign_keys
// pragma inside a transaction, and a table rebuild that drops a table with
// them on would cascade-delete every row that refers to it. Each migration
// then checks every reference and rolls back if any is broken.
//
// An upgrade of an existing database is preceded by a snapshot, whose file
// name it returns, and a database that holds migrations this build does not
// know was written by a newer version, so it is left untouched.
const applyMigrations = (bundled: ReadonlyArray<Migration>) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric,
      name text,
      applied_at TEXT
    )
  `
  const applied = (yield* sql<{ readonly name: string }>`SELECT name FROM __drizzle_migrations`).map((row) => row.name)

  const known = new Set(bundled.map((migration) => migration.name))
  const unknownMigrations = applied.filter((name) => !known.has(name))
  if (unknownMigrations.length > 0) {
    return yield* new NewerDatabase({ unknownMigrations })
  }

  const pending = bundled.filter((migration) => !applied.includes(migration.name))
  if (pending.length === 0) {
    return null
  }
  const taken = applied.length > 0 ? yield* takeSnapshot("pre-migration") : null
  if (taken !== null) yield* Effect.logInfo(`Snapshot taken before migrating: ${taken}`)

  yield* sql`PRAGMA foreign_keys = OFF`
  yield* Effect.forEach(pending, (migration) =>
    Effect.gen(function*() {
      for (const statement of migration.sql.split(StatementBreak)) {
        if (statement.trim() !== "") yield* sql.unsafe(statement)
      }
      const appliedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
      yield* sql`
        INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
        VALUES (${sha256(migration.sql)}, ${migrationTime(migration.name)}, ${migration.name}, ${appliedAt})
      `
      const broken = yield* sql`PRAGMA foreign_key_check`
      if (broken.length > 0) {
        return yield* new MigrationBrokeReferences({ migration: migration.name, brokenReferences: broken.length })
      }
    }).pipe(sql.withTransaction)
  ).pipe(Effect.ensuring(sql`PRAGMA foreign_keys = ON`.pipe(Effect.orDie)))
  yield* Effect.logInfo(`Applied ${pending.length} migration(s)`)
  return taken
})

const DbLive = Layer.effect(Db, SQLiteBunDrizzle.makeWithDefaults())

// The snapshot this start took before migrating, if it took one: its file
// in the snapshots folder, which the app records as its own once its tables
// are in place.
export class StartupSnapshot extends Context.Service<StartupSnapshot, { readonly file: string | null }>()(
  "gmat-prep/server/StartupSnapshot"
) {}

// Opens the database, checks it, and brings its schema up to date.
export const makeDatabaseLive = (migrations: ReadonlyArray<Migration>) =>
  Layer.effect(
    StartupSnapshot,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`PRAGMA foreign_keys = ON`
      yield* checkIntegrity
      return StartupSnapshot.of({ file: yield* applyMigrations(migrations) })
    })
  ).pipe(
    Layer.provideMerge(DbLive),
    Layer.provideMerge(SqliteLive)
  )

export const DatabaseLive = makeDatabaseLive(bundledMigrations)

export class DatabaseNotReady extends Schema.TaggedError<DatabaseNotReady>()("DatabaseNotReady", {
  missing: Schema.Array(Schema.String)
}) {}

// For the job worker and host commands: the server owns migrations, so these
// wait, up to a minute, until the schema they were built with is in place.
export const makeReadyDatabaseLive = (migrations: ReadonlyArray<Migration>) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`PRAGMA foreign_keys = ON`
      const missingMigrations = Effect.gen(function*() {
        const tracking = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'
        `
        const applied = tracking.length === 0
          ? new Set<string>()
          : new Set((yield* sql<{ readonly name: string }>`SELECT name FROM __drizzle_migrations`).map((row) => row.name))
        return migrations.map((migration) => migration.name).filter((name) => !applied.has(name))
      })
      const missing = yield* missingMigrations.pipe(
        Effect.repeat({ schedule: Schedule.spaced("250 millis"), until: (names) => names.length === 0 }),
        Effect.timeoutOrElse({ duration: "60 seconds", orElse: () => missingMigrations })
      )
      if (missing.length > 0) {
        return yield* new DatabaseNotReady({ missing })
      }
    })
  ).pipe(
    Layer.provideMerge(DbLive),
    Layer.provideMerge(SqliteLive)
  )

export const ReadyDatabaseLive = makeReadyDatabaseLive(bundledMigrations)
