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
