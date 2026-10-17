import { Database } from "bun:sqlite"
import { statSync } from "node:fs"
import { type Migration, migrationTime, sha256, StatementBreak } from "../db/Database.ts"
import { syncFile } from "./workFiles.ts"

// Work on database files that runs on a connection of its own: in a short
// process the server starts, so a large database never holds up its
// requests, or in process in tests (src/server/snapshots/copier.ts).

export interface CopiedFile {
  readonly size: number
  readonly sha256: string
}

// The SHA-256 of a file, read in pieces.
export const hashFile = async (file: string) => {
  const hasher = new Bun.CryptoHasher("sha256")
  for await (const piece of Bun.file(file).stream()) hasher.update(piece)
  return hasher.digest("hex")
}

// SQLite's check of a database, full or quick: "ok", or the problems found.
export const checkDatabase = (file: string, quick = false) => {
  const db = new Database(file, { readonly: true })
  try {
    const rows = db.query(quick ? "PRAGMA quick_check" : "PRAGMA integrity_check").values() as Array<[string]>
    return rows.map((row) => row[0]).join("; ")
  } finally {
    db.close()
  }
}

// A consistent copy of a database, as it stood when the copy began, written
// to a new file. The source is opened read-only, so a running app's writes go
// on meanwhile. The copy is checked and written to the disk before it is
// handed back; one that fails its check is an error.
export const copyDatabase = async (from: string, to: string): Promise<CopiedFile> => {
  const db = new Database(from, { readonly: true })
  try {
    db.run("VACUUM INTO ?", [to])
  } finally {
    db.close()
  }
  const verdict = checkDatabase(to, true)
  if (verdict !== "ok") throw new Error(`The copy failed SQLite's check: ${verdict}`)
  syncFile(to)
  return { size: statSync(to).size, sha256: await hashFile(to) }
}

// The migrations a database file records as applied: none when it has no
// migration log, as another program's database has none.
const appliedIn = (db: Database) => {
  const log = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get()
  return log === null ? [] : (db.query("SELECT name FROM __drizzle_migrations").values() as Array<[string]>).map((row) => row[0])
}

export interface InspectedFile extends CopiedFile {
  // SQLite's quick check: "ok", or the problems found.
  readonly verdict: string
  // How many migrations its log records; none for another program's file.
  readonly migrations: number
}

// What a database file found in the snapshots folder holds, before it is
// listed as a snapshot.
export const inspectDatabase = async (file: string): Promise<InspectedFile> => {
  const verdict = checkDatabase(file, true)
  const db = new Database(file, { readonly: true })
  let migrations: number
  try {
    migrations = appliedIn(db).length
  } finally {
    db.close()
  }
  return { size: statSync(file).size, sha256: await hashFile(file), verdict, migrations }
}

export type MigrateOutcome =
  | { readonly _tag: "migrated"; readonly applied: number }
  // The file holds migrations this build does not know: a newer app wrote it.
  | { readonly _tag: "newer"; readonly unknown: ReadonlyArray<string> }
  // The file records no migration at all, so it is not this app's database.
  | { readonly _tag: "foreign" }

// Brings a database file to this build's schema, as the server does at
// startup (src/server/db/Database.ts): each migration in a transaction with
// foreign keys off, rolled back if it leaves a broken reference. A file with
// no migration log gets one, so this also makes a new database.
export const migrateDatabase = (file: string, migrations: ReadonlyArray<Migration>, now: number): MigrateOutcome => {
  const db = new Database(file)
  try {
    db.run(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric,
      name text,
      applied_at TEXT
    )`)
    const applied = appliedIn(db)
    const known = new Set(migrations.map((migration) => migration.name))
    const unknown = applied.filter((name) => !known.has(name))
    if (unknown.length > 0) return { _tag: "newer", unknown }
    const pending = migrations.filter((migration) => !applied.includes(migration.name))
    db.run("PRAGMA foreign_keys = OFF")
    for (const migration of pending) {
      db.transaction(() => {
        for (const statement of migration.sql.split(StatementBreak)) {
          if (statement.trim() !== "") db.run(statement)
        }
        db.run("INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES (?, ?, ?, ?)", [
          sha256(migration.sql),
          migrationTime(migration.name),
          migration.name,
          new Date(now).toISOString()
        ])
        const broken = db.query("PRAGMA foreign_key_check").all()
        if (broken.length > 0) throw new Error(`Migration ${migration.name} left ${broken.length} broken references.`)
      })()
    }
    return { _tag: "migrated", applied: pending.length }
  } finally {
    db.close()
  }
}

// Brings a copy of a snapshot to this build's schema, as migrateDatabase
// does. A copy that records no migration is not this app's database, and is
// left as it is.
export const migrateCopy = (file: string, migrations: ReadonlyArray<Migration>, now: number): MigrateOutcome => {
  const db = new Database(file, { readonly: true })
  let applied: ReadonlyArray<string>
  try {
    applied = appliedIn(db)
  } finally {
    db.close()
  }
  return applied.length === 0 ? { _tag: "foreign" } : migrateDatabase(file, migrations, now)
}
