import { SqliteClient } from "@effect/sql-sqlite-bun"
import * as SQLiteBunDrizzle from "drizzle-orm/effect-sqlite-bun"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { mkdirSync } from "node:fs"
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

export class MigrationBrokeReferences extends Schema.TaggedError<MigrationBrokeReferences>()(
  "MigrationBrokeReferences",
  { migration: Schema.String, brokenReferences: Schema.Int }
) {}

// drizzle-kit separates the statements of a migration with this marker.
const StatementBreak = "--> statement-breakpoint"

// The migration's timestamp, from the start of its folder name.
const migrationTime = (name: string) => {
  const stamp = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
  return stamp === null ? 0 : Date.UTC(+stamp[1]!, +stamp[2]! - 1, +stamp[3]!, +stamp[4]!, +stamp[5]!, +stamp[6]!)
}

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")

// Applies migrations, each in its own transaction, recorded in drizzle's
// table. Foreign keys are off while they run: SQLite ignores a foreign_keys
// pragma inside a transaction, and a table rebuild that drops a table with
// them on would cascade-delete every row that refers to it. Each migration
// then checks every reference and rolls back if any is broken.
//
// An upgrade of an existing database is preceded by a snapshot, and a
// database that holds migrations this build does not know was written by a
// newer version, so it is left untouched.
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
    return
  }
  if (applied.length > 0) {
    const file = yield* takeSnapshot("pre-migration")
    yield* Effect.logInfo(`Snapshot taken before migrating: ${file}`)
  }

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
