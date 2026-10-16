import { SqliteClient } from "@effect/sql-sqlite-bun"
import * as SQLiteBunDrizzle from "drizzle-orm/effect-sqlite-bun"
import { migrate } from "drizzle-orm/effect-sqlite-bun/migrator"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AppConfig } from "../AppConfig.ts"
import { bundledMigrations } from "./migrations/index.gen.ts"

export class DatabaseCorrupt extends Schema.TaggedError<DatabaseCorrupt>()("DatabaseCorrupt", {
  detail: Schema.String
}) {}

export class NewerDatabase extends Schema.TaggedError<NewerDatabase>()("NewerDatabase", {
  unknownMigrations: Schema.Array(Schema.String)
}) {}

export class Db extends Context.Service<Db, SQLiteBunDrizzle.EffectSQLiteBunDatabase>()("gmat-prep/server/Db") {}

const databaseFile = (dataDir: string) => join(dataDir, "gmat-prep.sqlite")

const SqliteLive = Layer.unwrap(
  Effect.gen(function*() {
    const { dataDir } = yield* AppConfig
    yield* Effect.sync(() => mkdirSync(dataDir, { recursive: true }))
    return SqliteClient.layer({ filename: databaseFile(dataDir) })
  })
)

// Copies a consistent image of the live database into the snapshots folder.
export const takeSnapshot = Effect.fn("takeSnapshot")(function*(kind: string) {
  const { dataDir } = yield* AppConfig
  const sql = yield* SqlClient.SqlClient
  const now = yield* Clock.currentTimeMillis
  const folder = join(dataDir, "snapshots")
  yield* Effect.sync(() => mkdirSync(folder, { recursive: true }))
  const file = join(folder, `${kind}-${new Date(now).toISOString().replace(/[:.]/g, "-")}.sqlite`)
  yield* sql`VACUUM INTO ${file}`
  return file
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

// Applies migrations. An upgrade of an existing database is preceded by a
// snapshot, and a database that holds migrations this build does not know was
// written by a newer version, so it is left untouched.
const applyMigrations = (bundled: ReadonlyArray<Migration>) => Effect.gen(function*() {
  const { dataDir } = yield* AppConfig
  const sql = yield* SqlClient.SqlClient
  const db = yield* Db

  const tracking = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'
  `
  const applied = tracking.length === 0
    ? []
    : (yield* sql<{ readonly name: string }>`SELECT name FROM __drizzle_migrations`).map((row) => row.name)

  const known = new Set(bundled.map((migration) => migration.name))
  const unknownMigrations = applied.filter((name) => !known.has(name))
  if (unknownMigrations.length > 0) {
    return yield* new NewerDatabase({ unknownMigrations })
  }

  const pending = bundled.filter((migration) => !applied.includes(migration.name))
  if (pending.length === 0) {
    return
  }
  if (applied.length > 0) {
    const file = yield* takeSnapshot("pre-migration")
    yield* Effect.logInfo(`Snapshot taken before migrating: ${file}`)
  }

  // Drizzle's migrator reads a folder, so the bundled files are written out first.
  const folder = join(dataDir, ".migrations")
  yield* Effect.sync(() => {
    rmSync(folder, { recursive: true, force: true })
    for (const migration of bundled) {
      mkdirSync(join(folder, migration.name), { recursive: true })
      writeFileSync(join(folder, migration.name, "migration.sql"), migration.sql)
    }
  })
  yield* migrate(db, { migrationsFolder: folder })
  yield* Effect.logInfo(`Applied ${pending.length} migration(s)`)
})

const DbLive = Layer.effect(Db, SQLiteBunDrizzle.makeWithDefaults())

// Opens the database, checks it, and brings its schema up to date.
export const makeDatabaseLive = (migrations: ReadonlyArray<Migration>) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`PRAGMA foreign_keys = ON`
      yield* checkIntegrity
      yield* applyMigrations(migrations)
    })
  ).pipe(
    Layer.provideMerge(DbLive),
    Layer.provideMerge(SqliteLive)
  )

export const DatabaseLive = makeDatabaseLive(bundledMigrations)
