import { and, desc, eq, inArray, sql as raw } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schedule, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  IntegrityView,
  RestoreBlocked,
  RestoreDone,
  SnapshotFailed,
  SnapshotFailureView,
  SnapshotId,
  type SnapshotKind,
  SnapshotNotFound,
  SnapshotsView,
  SnapshotUnusable,
  SnapshotView
} from "../../api/Snapshots.ts"
import { studyDayOf } from "../../api/studyDay.ts"
import { AppConfig } from "../AppConfig.ts"
import { databaseFile, Db } from "../db/Database.ts"
import { jobs, sessions, settings, snapshots } from "../db/schema.ts"
import { SnapshotCopier } from "./copier.ts"
import { parseSnapshotName, SnapshotFolder, snapshotFileName } from "./names.ts"
import { keptSnapshots } from "./retention.ts"

// Snapshots of the database (docs/design.md, "Data safety and operations",
// decisions 109 to 112): taken daily and before risky changes, kept by the
// retention rule, and restored from the Curator's screen.

const DayMs = 86_400_000
// The full integrity check runs once a week.
const IntegrityEveryMs = 7 * DayMs
const IntegrityKey = "integrity-check"

// Tables a restore leaves as they are: the migration log and the snapshots,
// which describe this database and its folder, and who is signed in now and
// with which passphrase.
const KeptOnRestore = new Set(["__drizzle_migrations", "snapshots", "profile_unlocks", "curator_unlocks", "curator_access"])

const hostZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
// The host's calendar date of a moment, as a day number and as YYYY-MM-DD.
const hostDayOf = (at: number) => studyDayOf(at, hostZone(), 0)
const dayText = (day: number) => new Date(day * DayMs).toISOString().slice(0, 10)
const dayNumber = (text: string) => Math.round(Date.parse(`${text}T00:00:00Z`) / DayMs)

const isDiskFull = (detail: string) => /database or disk is full|no space left on device|ENOSPC|SQLITE_FULL/i.test(detail)

type SnapshotRow = typeof snapshots.$inferSelect

const viewOf = (row: SnapshotRow) =>
  new SnapshotView({ id: SnapshotId.make(row.id), kind: row.kind as SnapshotKind, takenAt: row.takenAt, size: row.size })

export class Snapshots extends Context.Service<Snapshots, {
  // Takes a snapshot now and records it, then deletes those the retention
  // rule no longer keeps. A failure is recorded and reported, never
  // skipped.
  take(kind: SnapshotKind): Effect.Effect<SnapshotView, SnapshotFailed>
  readonly list: Effect.Effect<SnapshotsView>
  // At startup and each hour: records snapshot files found without a
  // record, takes the day's snapshot when none was taken, and runs the
  // weekly integrity check when it is due.
  readonly tend: Effect.Effect<void>
  restore(id: SnapshotId): Effect.Effect<RestoreDone, SnapshotNotFound | RestoreBlocked | SnapshotUnusable | SnapshotFailed>
}>()("gmat-prep/server/Snapshots") {
  static readonly layer = Layer.effect(
    Snapshots,
    Effect.gen(function*() {
      const db = yield* Db
      const sql = yield* SqlClient.SqlClient
      const copier = yield* SnapshotCopier
      const { dataDir } = yield* AppConfig
      const folder = join(dataDir, SnapshotFolder)
      const live = databaseFile(dataDir)
      // One snapshot or restore at a time.
      const oneAtATime = (yield* Semaphore.make(1)).withPermits(1)

      const rowsOf = (status: string) =>
        db.select().from(snapshots).where(eq(snapshots.status, status)).orderBy(desc(snapshots.takenAt)).pipe(Effect.orDie)

      // Deletes the files of the snapshots the rule no longer keeps.
      const applyRetention = Effect.gen(function*() {
        const kept = yield* rowsOf("ok")
        const keep = keptSnapshots(kept.map((row) => ({ id: row.id, kind: row.kind as SnapshotKind, at: row.takenAt, day: dayNumber(row.day) })))
        const gone = kept.filter((row) => !keep.has(row.id))
        if (gone.length === 0) return
        const now = yield* Clock.currentTimeMillis
        for (const row of gone) {
          yield* Effect.sync(() => {
            if (row.file !== null) rmSync(join(folder, row.file), { force: true })
          })
        }
        yield* db.update(snapshots).set({ status: "removed", removedAt: now }).where(inArray(snapshots.id, gone.map((row) => row.id)))
          .pipe(Effect.orDie)
      })

      const takeNow = (kind: SnapshotKind) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const id = crypto.randomUUID()
          const name = snapshotFileName(kind, now, id.slice(0, 8))
          const file = join(folder, name)
          yield* Effect.sync(() => mkdirSync(folder, { recursive: true }))
          const copied = yield* Effect.result(copier.copy(live, file))
          const day = dayText(hostDayOf(now))
          if (copied._tag === "Failure") {
            // A copy that stopped part way leaves nothing behind.
            yield* Effect.sync(() => rmSync(file, { force: true }))
            const detail = copied.failure.detail
            const diskFull = isDiskFull(detail)
            const error = diskFull ? "The disk is full. Free some space, and the next snapshot will be taken." : detail
            yield* db.insert(snapshots).values({ id, kind, file: null, takenAt: now, day, size: null, sha256: null, status: "failed", error })
              .pipe(Effect.orDie)
            yield* Effect.logError(`Snapshot ${kind} failed: ${detail}`)
            return yield* new SnapshotFailed({ detail: error, diskFull })
          }
          const row: SnapshotRow = {
            id,
            kind,
            file: name,
            takenAt: now,
            day,
            size: copied.success.size,
            sha256: copied.success.sha256,
            status: "ok",
            error: null,
            removedAt: null
          }
          yield* db.insert(snapshots).values(row).pipe(Effect.orDie)
          return row
        })

      const take = (kind: SnapshotKind) =>
        takeNow(kind).pipe(
          Effect.tap(() => applyRetention),
          Effect.map(viewOf),
          oneAtATime
        )

      const integrityOf = Effect.gen(function*() {
        const [row] = yield* db.select().from(settings).where(eq(settings.key, IntegrityKey)).pipe(Effect.orDie)
        if (row === undefined) return null
        const value = JSON.parse(row.value) as { readonly ok: boolean; readonly detail: string }
        return new IntegrityView({ at: row.updatedAt, ok: value.ok, detail: value.detail })
      })

      const list = Effect.gen(function*() {
        const kept = yield* rowsOf("ok")
        const failed = yield* rowsOf("failed")
        // A kind's latest failure, while no later snapshot of it succeeded.
        const failures = [...Map.groupBy(failed, (row) => row.kind)].flatMap(([kind, rows]) => {
          const latest = rows[0]!
          const succeeded = kept.find((row) => row.kind === kind)
          return succeeded !== undefined && succeeded.takenAt > latest.takenAt
            ? []
            : [new SnapshotFailureView({ kind: kind as SnapshotKind, at: latest.takenAt, error: latest.error ?? "" })]
        })
        return new SnapshotsView({ snapshots: kept.map(viewOf), failures, integrity: yield* integrityOf })
      })

      // Snapshot files in the folder with no record, such as those taken
      // before a migration, before the table existed.
      const recordFound = Effect.gen(function*() {
        const names = yield* Effect.sync(() => {
          try {
            return readdirSync(folder)
          } catch {
            return []
          }
        })
        const known = new Set((yield* db.select({ file: snapshots.file }).from(snapshots).pipe(Effect.orDie)).map((row) => row.file))
        for (const name of names) {
          const parsed = parseSnapshotName(name)
          if (parsed === undefined || known.has(name)) continue
          const size = yield* Effect.sync(() => statSync(join(folder, name)).size)
          yield* db.insert(snapshots).values({
            id: crypto.randomUUID(),
            kind: parsed.kind,
            file: name,
            takenAt: parsed.at,
            day: dayText(hostDayOf(parsed.at)),
            size,
            sha256: null,
            status: "ok",
            error: null,
            removedAt: null
          }).pipe(Effect.orDie)
        }
      })

      const checkIntegrity = Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        const last = yield* integrityOf
        if (last !== null && now - last.at < IntegrityEveryMs) return
        const checked = yield* Effect.result(copier.check(live, false))
        const detail = checked._tag === "Success" ? checked.success : `The check could not run: ${checked.failure.detail}`
        const ok = checked._tag === "Success" && checked.success === "ok"
        if (!ok) yield* Effect.logError(`The weekly integrity check found: ${detail}`)
        yield* db.insert(settings).values({ key: IntegrityKey, value: JSON.stringify({ ok, detail }), updatedAt: now })
          .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify({ ok, detail }), updatedAt: now } })
          .pipe(Effect.orDie)
      })

      const tend = Effect.gen(function*() {
        yield* recordFound.pipe(oneAtATime)
        const today = dayText(hostDayOf(yield* Clock.currentTimeMillis))
        const [taken] = yield* db.select({ id: snapshots.id }).from(snapshots)
          .where(and(eq(snapshots.kind, "daily"), eq(snapshots.day, today), inArray(snapshots.status, ["ok", "removed"])))
          .limit(1).pipe(Effect.orDie)
        if (taken === undefined) yield* take("daily").pipe(Effect.ignore)
        yield* checkIntegrity
      })

      // Restore (decision 112): the chosen snapshot is copied, checked and
      // brought to this build's schema on the side; the database as it
      // stands is kept as a snapshot; then every table but those kept is
      // filled from the copy in one transaction.
      const restore = (id: SnapshotId) =>
        Effect.gen(function*() {
          const [row] = yield* db.select().from(snapshots).where(and(eq(snapshots.id, id), eq(snapshots.status, "ok")))
            .pipe(Effect.orDie)
          if (row === undefined || row.file === null) return yield* new SnapshotNotFound()
          const [running] = yield* db.select({ id: jobs.id }).from(jobs).where(eq(jobs.status, "running")).limit(1).pipe(Effect.orDie)
          if (running !== undefined) return yield* new RestoreBlocked({ reason: "job-running" })
          const [session] = yield* db.select({ id: sessions.id }).from(sessions)
            .where(and(
              eq(sessions.status, "active"),
              raw`(${sessions.timed} = 1 or ${sessions.kind} in ('mock', 'mock-section', 'sectional'))`
            )).limit(1).pipe(Effect.orDie)
          if (session !== undefined) return yield* new RestoreBlocked({ reason: "session-running" })
          const file = join(folder, row.file)
          const unusable = (reason: "changed" | "damaged" | "newer") => (detail: string) => new SnapshotUnusable({ reason, detail })
          if (row.sha256 !== null) {
            const hash = yield* copier.hash(file).pipe(Effect.mapError((failure) => unusable("damaged")(failure.detail)))
            if (hash !== row.sha256) return yield* unusable("changed")("The snapshot's file has changed since it was taken.")
          }
          const now = yield* Clock.currentTimeMillis
          const copy = join(folder, `restore-${id}.sqlite`)
          yield* Effect.sync(() => rmSync(copy, { force: true }))
          return yield* Effect.gen(function*() {
            yield* copier.copy(file, copy).pipe(Effect.mapError((failure) =>
              isDiskFull(failure.detail)
                ? new SnapshotFailed({ detail: "The disk is full. Free some space, then restore again.", diskFull: true })
                : unusable("damaged")(failure.detail)
            ))
            const quick = yield* copier.check(copy, true).pipe(Effect.mapError((failure) => unusable("damaged")(failure.detail)))
            if (quick !== "ok") return yield* unusable("damaged")(quick)
            const migrated = yield* copier.migrate(copy, now).pipe(Effect.mapError((failure) => unusable("damaged")(failure.detail)))
            if (migrated._tag === "newer") {
              return yield* unusable("newer")(`A newer version of the app wrote it: ${migrated.unknown.join(", ")}.`)
            }
            const replaced = yield* takeNow("pre-restore")
            yield* replaceTables(copy)
            yield* applyRetention
            const restored = (yield* db.select().from(snapshots).where(eq(snapshots.id, id)).pipe(Effect.orDie))[0] ?? row
            yield* Effect.logInfo(`Restored the snapshot taken ${new Date(row.takenAt).toISOString()}`)
            return new RestoreDone({ restored: viewOf(restored), replaced: viewOf(replaced) })
          }).pipe(Effect.ensuring(Effect.sync(() => rmSync(copy, { force: true }))))
        }).pipe(oneAtATime)

      // Fills every table but those kept from the copy, in one transaction
      // with foreign keys off, as SQLite allows only outside one; references
      // are checked before it commits.
      const replaceTables = (copy: string) =>
        Effect.gen(function*() {
          const tables = (yield* sql<{ readonly name: string }>`
            SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          `).map((table) => table.name).filter((name) => !KeptOnRestore.has(name))
          const [jobsBefore] = yield* sql<{ readonly revision: number }>`SELECT coalesce(max(revision), 0) AS revision FROM jobs`
          yield* sql`ATTACH DATABASE ${copy} AS restored`
          yield* sql`PRAGMA foreign_keys = OFF`
          yield* Effect.gen(function*() {
            for (const table of tables) {
              const columns = (yield* sql.unsafe<{ readonly name: string }>(`PRAGMA main.table_info("${table}")`))
                .map((column) => `"${column.name}"`).join(", ")
              yield* sql.unsafe(`DELETE FROM main."${table}"`)
              yield* sql.unsafe(`INSERT INTO main."${table}" (${columns}) SELECT ${columns} FROM restored."${table}"`)
            }
            // Unlocks of Profiles the snapshot does not hold end.
            yield* sql`DELETE FROM profile_unlocks WHERE profile_id NOT IN (SELECT id FROM profiles)`
            // Jobs that were under way when the snapshot was taken wait for
            // the Curator, and every job's revision moves past those already
            // sent, so open pages hear of them.
            yield* sql`
              UPDATE jobs SET status = 'paused', note = ${"Paused by the restore. Resume it when you are ready."},
                claimant = NULL, heartbeat_at = NULL, requested = NULL, resume_at = NULL
              WHERE status IN ('queued', 'running')
            `
            yield* sql`UPDATE jobs SET revision = revision + ${jobsBefore?.revision ?? 0}`
            const broken = yield* sql`PRAGMA foreign_key_check`
            if (broken.length > 0) {
              return yield* new SnapshotUnusable({ reason: "damaged", detail: `It holds ${broken.length} broken references.` })
            }
          }).pipe(
            sql.withTransaction,
            Effect.ensuring(sql`PRAGMA foreign_keys = ON`.pipe(Effect.orDie)),
            Effect.ensuring(sql`DETACH DATABASE restored`.pipe(Effect.orDie))
          )
        }).pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)))

      return Snapshots.of({ take, list, tend, restore })
    })
  )

  // The hourly round of `tend`, for the running server; tests call `tend`.
  static readonly schedule = Layer.effectDiscard(
    Effect.gen(function*() {
      const snapshots = yield* Snapshots
      yield* Effect.forkScoped(snapshots.tend.pipe(Effect.repeat(Schedule.spaced("1 hour"))))
    })
  )
}
