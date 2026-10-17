import { eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { ExportFailed, InstallExportView, ProfileExport } from "../../api/Exports.ts"
import { ProfileId } from "../../api/Profiles.ts"
import { AppConfig } from "../AppConfig.ts"
import { causeText, databaseFile, Db, isDiskFull } from "../db/Database.ts"
import { profiles } from "../db/schema.ts"
import { SnapshotCopier } from "./copier.ts"
import { type TarEntry, writeTar } from "./tar.ts"
import { moveIntoPlace, PartSuffix, removeWorkFile } from "./workFiles.ts"

// Exports (decisions 113 and 114): a Profile's rows as JSON for the
// Learner, and the whole install as one archive for the Curator to move to
// another computer.

const ExportFolder = "exports"
// An archive's name says when it was made, with a tag of its own, so two
// made in the same second never share one.
const ArchivePattern = /^gmat-prep-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(?:-[0-9a-f]{8})?\.tar$/
// The database copy an archive is made from.
const CopyPattern = /^database-[0-9a-f-]{36}\.sqlite(?:-journal)?$/

// Tables a Profile's export leaves out: who is signed in.
const NotExported = new Set(["profile_unlocks"])

export class Exports extends Context.Service<Exports, {
  profile(profileId: string): Effect.Effect<ProfileExport>
  // Writes a new archive of the install, replacing the last.
  readonly install: Effect.Effect<InstallExportView, ExportFailed>
  readonly latestInstall: Effect.Effect<InstallExportView | null>
  // The latest archive's file, to send.
  readonly installFile: Effect.Effect<{ readonly path: string; readonly name: string } | undefined>
}>()("gmat-prep/server/Exports") {
  static readonly layer = Layer.effect(
    Exports,
    Effect.gen(function*() {
      const db = yield* Db
      const sql = yield* SqlClient.SqlClient
      const copier = yield* SnapshotCopier
      const { dataDir } = yield* AppConfig
      const folder = join(dataDir, ExportFolder)
      const oneAtATime = (yield* Semaphore.make(1)).withPermits(1)

      // Work a stop cut short: archives still under their temporary names,
      // and the database copies they were made from. None is in progress yet.
      yield* Effect.sync(() => {
        let names: ReadonlyArray<string>
        try {
          names = readdirSync(folder)
        } catch {
          return
        }
        for (const name of names) {
          const part = name.endsWith(PartSuffix) && ArchivePattern.test(name.slice(0, -PartSuffix.length))
          if (part || CopyPattern.test(name)) rmSync(join(folder, name), { force: true })
        }
      })

      // Every table with a Profile's rows: those with a profile_id, and
      // those whose rows belong to one of them, such as a Session's served
      // Questions. Read from the database, so a new table joins by itself.
      const ownedTables = Effect.gen(function*() {
        const tables = (yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'
        `).map((row) => row.name)
        const columnsOf = new Map<string, ReadonlyArray<string>>()
        for (const table of tables) {
          columnsOf.set(table, (yield* sql.unsafe<{ readonly name: string }>(`PRAGMA table_info("${table}")`)).map((column) => column.name))
        }
        const direct = tables.filter((table) => columnsOf.get(table)!.includes("profile_id") && !NotExported.has(table))
        const children: Array<{ readonly table: string; readonly column: string; readonly parent: string }> = []
        for (const table of tables) {
          if (direct.includes(table) || NotExported.has(table)) continue
          const keys = yield* sql.unsafe<{ readonly table: string; readonly from: string; readonly on_delete: string }>(
            `PRAGMA foreign_key_list("${table}")`
          )
          const owner = keys.find((key) => direct.includes(key.table) && key.on_delete.toUpperCase() === "CASCADE")
          if (owner !== undefined) children.push({ table, column: owner.from, parent: owner.table })
        }
        return { direct, children }
      })

      const profile = (profileId: string) =>
        Effect.gen(function*() {
          const [row] = yield* db.select().from(profiles).where(eq(profiles.id, profileId)).pipe(Effect.orDie)
          const { direct, children } = yield* ownedTables
          const tables: Record<string, ReadonlyArray<Record<string, unknown>>> = {}
          for (const table of direct) {
            tables[table] = yield* sql.unsafe<Record<string, unknown>>(`SELECT * FROM "${table}" WHERE profile_id = ? ORDER BY rowid`, [profileId])
          }
          for (const { table, column, parent } of children) {
            tables[table] = yield* sql.unsafe<Record<string, unknown>>(
              `SELECT c.* FROM "${table}" c WHERE c."${column}" IN (SELECT id FROM "${parent}" WHERE profile_id = ?) ORDER BY c.rowid`,
              [profileId]
            )
          }
          return new ProfileExport({
            format: "gmat-prep-profile",
            version: 1,
            exportedAt: yield* Clock.currentTimeMillis,
            profile: {
              id: ProfileId.make(profileId),
              name: row?.name ?? "",
              hasPin: row?.pinHash != null,
              timeZone: row?.timeZone ?? "UTC",
              rolloverHour: row?.rolloverHour ?? 4,
              createdAt: row?.createdAt ?? 0
            },
            tables
          })
        }).pipe(Effect.orDie)

      // The archives in the folder, oldest first.
      const archives = Effect.sync(() => {
        try {
          return readdirSync(folder).filter((name) => ArchivePattern.test(name))
            .map((name) => ({ name, at: statSync(join(folder, name)).mtimeMs }))
            .toSorted((a, b) => a.at - b.at || (a.name < b.name ? -1 : 1))
            .map((archive) => archive.name)
        } catch {
          return []
        }
      })

      const viewOf = (name: string) => {
        const found = statSync(join(folder, name))
        return new InstallExportView({ name, size: found.size, at: found.mtimeMs })
      }

      const latestInstall = Effect.gen(function*() {
        const name = (yield* archives).at(-1)
        return name === undefined ? null : viewOf(name)
      })

      // The files of a folder of the data folder, as archive entries.
      const filesOf = (sub: string, pattern: RegExp): ReadonlyArray<TarEntry> => {
        try {
          return readdirSync(join(dataDir, sub)).filter((name) => pattern.test(name)).toSorted().map((name) => {
            const path = join(dataDir, sub, name)
            const found = statSync(path)
            return { name: `${sub}/${name}`, path, size: found.size, modified: found.mtimeMs }
          })
        } catch {
          return []
        }
      }

      // The archive is written under a temporary name and takes its own only
      // once it is whole, so the Data page never offers one being written or
      // cut short. A failure removes only what this attempt made.
      const install = Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        const stamp = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-")
        const name = `gmat-prep-${stamp}-${crypto.randomUUID().slice(0, 8)}.tar`
        const target = join(folder, name)
        const part = `${target}${PartSuffix}`
        const database = join(folder, `database-${crypto.randomUUID()}.sqlite`)
        const fail = (detail: string) =>
          new ExportFailed({
            detail: isDiskFull(detail) ? "The disk is full. Free some space, then export again." : detail,
            diskFull: isDiskFull(detail)
          })
        yield* Effect.sync(() => mkdirSync(folder, { recursive: true }))
        return yield* Effect.gen(function*() {
          const copied = yield* copier.copy(databaseFile(dataDir), database).pipe(Effect.mapError((failure) => fail(failure.detail)))
          const entries: ReadonlyArray<TarEntry> = [
            { name: "gmat-prep.sqlite", path: database, size: copied.size, modified: now },
            ...filesOf("books", /^[0-9a-f]{64}\.pdf$/),
            ...filesOf("figures", /^[0-9a-f]{64}\.png$/)
          ]
          yield* Effect.tryPromise({ try: () => writeTar(part, entries), catch: (cause) => fail(causeText(cause)) })
          yield* Effect.try({ try: () => moveIntoPlace(part, target), catch: (cause) => fail(causeText(cause)) })
          // Only the latest archive is kept.
          for (const old of yield* archives) {
            if (old === name) continue
            yield* Effect.sync(() => {
              try {
                rmSync(join(folder, old), { force: true })
              } catch {
                // Tried again after the next archive.
              }
            })
          }
          return viewOf(name)
        }).pipe(Effect.ensuring(Effect.sync(() => {
          removeWorkFile(part)
          removeWorkFile(database)
        })))
      }).pipe(oneAtATime)

      const installFile = Effect.gen(function*() {
        const name = (yield* archives).at(-1)
        return name === undefined ? undefined : { path: join(folder, name), name }
      })

      return Exports.of({ profile, install, latestInstall, installFile })
    })
  )
}
