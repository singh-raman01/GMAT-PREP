import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { AppConfig } from "../src/server/AppConfig.ts"
import { makeDatabaseLive, type Migration } from "../src/server/db/Database.ts"
import { tempDataDir } from "./harness.ts"

const first: Migration = { name: "20260101000000_first", sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY);" }
const second: Migration = { name: "20260201000000_second", sql: "CREATE TABLE cards (id INTEGER PRIMARY KEY);" }

const statements = (...lines: ReadonlyArray<string>) => lines.join("\n--> statement-breakpoint\n")

const parentAndChild: Migration = {
  name: "20260101000000_parent_and_child",
  sql: statements(
    "CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
    "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE);"
  )
}

// What drizzle-kit writes to add a column that needs a table rebuild.
const rebuildParent: Migration = {
  name: "20260201000000_rebuild_parent",
  sql: statements(
    "PRAGMA foreign_keys=OFF;",
    "CREATE TABLE `__new_parent` (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT);",
    "INSERT INTO `__new_parent`(id, name) SELECT id, name FROM `parent`;",
    "DROP TABLE `parent`;",
    "ALTER TABLE `__new_parent` RENAME TO `parent`;",
    "PRAGMA foreign_keys=ON;"
  )
}

const dropParentRows: Migration = {
  name: "20260201000000_drop_parent_rows",
  sql: statements("PRAGMA foreign_keys=OFF;", "DELETE FROM parent;", "PRAGMA foreign_keys=ON;")
}

// Opens the data folder's database with the given migrations, the way startup does.
const open = (dataDir: string, migrations: ReadonlyArray<Migration>) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('notes', 'cards') ORDER BY name
      `
      return tables.map((table) => table.name)
    }).pipe(
      Effect.provide(makeDatabaseLive(migrations).pipe(Layer.provide(AppConfig.layer({ dataDir, preferredPort: 0 }))))
    )
  )

const snapshots = (dataDir: string) =>
  existsSync(join(dataDir, "snapshots")) ? readdirSync(join(dataDir, "snapshots")) : []

describe("Database migrations", () => {
  test("a fresh database is created without a snapshot", async () => {
    const dataDir = tempDataDir()
    expect(await open(dataDir, [first])).toEqual(["notes"])
    expect(snapshots(dataDir)).toEqual([])
  })

  test("upgrading an existing database takes a snapshot before migrating", async () => {
    const dataDir = tempDataDir()
    await open(dataDir, [first])
    expect(await open(dataDir, [first, second])).toEqual(["cards", "notes"])
    const taken = snapshots(dataDir)
    expect(taken).toHaveLength(1)
    expect(taken[0]).toStartWith("pre-migration-")
    // The snapshot holds the database as it was before the new migration.
    const snapshot = new Database(join(dataDir, "snapshots", taken[0]!), { readonly: true })
    const tables = snapshot.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('notes', 'cards')")
      .all()
      .map((row) => (row as { name: string }).name)
    snapshot.close()
    expect(tables).toEqual(["notes"])
  })

  // drizzle-kit rebuilds a table to change a column: create a copy, move the
  // rows, drop the original. Dropping must not cascade to rows that refer to it.
  test("rebuilding a table keeps the rows that refer to it", async () => {
    const dataDir = tempDataDir()
    await open(dataDir, [parentAndChild])
    const db = new Database(join(dataDir, "gmat-prep.sqlite"))
    db.run("INSERT INTO parent (id, name) VALUES (1, 'Asha')")
    db.run("INSERT INTO child (id, parent_id) VALUES (10, 1)")
    db.close()
    await open(dataDir, [parentAndChild, rebuildParent])
    const after = new Database(join(dataDir, "gmat-prep.sqlite"), { readonly: true })
    const children = after.query("SELECT id FROM child").all()
    const columns = after.query("SELECT name FROM pragma_table_info('parent')").all().map((row) => (row as { name: string }).name)
    after.close()
    expect(children).toEqual([{ id: 10 }])
    expect(columns).toEqual(["id", "name", "note"])
  })

  test("a migration that leaves broken references is rolled back and refused", async () => {
    const dataDir = tempDataDir()
    await open(dataDir, [parentAndChild])
    const db = new Database(join(dataDir, "gmat-prep.sqlite"))
    db.run("INSERT INTO parent (id, name) VALUES (1, 'Asha')")
    db.run("INSERT INTO child (id, parent_id) VALUES (10, 1)")
    db.close()
    const error = await open(dataDir, [parentAndChild, dropParentRows]).then(
      () => undefined,
      (cause: unknown) => String(cause)
    )
    expect(error).toContain("MigrationBrokeReferences")
    const after = new Database(join(dataDir, "gmat-prep.sqlite"), { readonly: true })
    const parents = after.query("SELECT id FROM parent").all()
    const applied = after.query("SELECT name FROM __drizzle_migrations").all()
    after.close()
    expect(parents).toEqual([{ id: 1 }])
    expect(applied).toEqual([{ name: parentAndChild.name }])
  })

  test("reopening an up-to-date database changes nothing", async () => {
    const dataDir = tempDataDir()
    await open(dataDir, [first])
    expect(await open(dataDir, [first])).toEqual(["notes"])
    expect(snapshots(dataDir)).toEqual([])
  })

  test("the database runs in WAL mode", async () => {
    const dataDir = tempDataDir()
    const mode = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{ readonly journal_mode: string }>`PRAGMA journal_mode`
        return rows[0]?.journal_mode
      }).pipe(
        Effect.provide(makeDatabaseLive([first]).pipe(Layer.provide(AppConfig.layer({ dataDir, preferredPort: 0 }))))
      )
    )
    expect(mode).toBe("wal")
  })

  test("a database written by a newer version is refused and left untouched", async () => {
    const dataDir = tempDataDir()
    await open(dataDir, [first, second])
    const error = await open(dataDir, [first]).then(() => undefined, (cause: unknown) => String(cause))
    expect(error).toContain("NewerDatabase")
    expect(await open(dataDir, [first, second])).toEqual(["cards", "notes"])
  })
})
