import { Database } from "bun:sqlite"
import { statSync } from "node:fs"
import { type Migration, migrationTime, sha256, StatementBreak } from "../db/Database.ts"

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

// A consistent copy of a database, as it stood when the copy began. The
// source is opened read-only, so a running app's writes go on meanwhile.
export const copyDatabase = async (from: string, to: string): Promise<CopiedFile> => {
  const db = new Database(from, { readonly: true })
  try {
    db.run("VACUUM INTO ?", [to])
  } finally {
    db.close()
  }
  return { size: statSync(to).size, sha256: await hashFile(to) }
}

// SQLite's full check of a database: "ok", or the problems it found.
export const checkDatabase = (file: string, quick = false) => {
  const db = new Database(file, { readonly: true })
  try {
    const rows = db.query(quick ? "PRAGMA quick_check" : "PRAGMA integrity_check").values() as Array<[string]>
    return rows.map((row) => row[0]).join("; ")
  } finally {
    db.close()
  }
}

export type MigrateOutcome =
  | { readonly _tag: "migrated"; readonly applied: number }
  // The file holds migrations this build does not know: a newer app wrote it.
  | { readonly _tag: "newer"; readonly unknown: ReadonlyArray<string> }

// Brings a database file to this build's schema, as the server does at
// startup (src/server/db/Database.ts): each migration in a transaction with
// foreign keys off, rolled back if it leaves a broken reference.
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
    const applied = (db.query("SELECT name FROM __drizzle_migrations").values() as Array<[string]>).map((row) => row[0])
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
