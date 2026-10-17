import { and, desc, eq, inArray, sql as raw } from "drizzle-orm"
import { Clock, Context, Effect, Exit, Layer, Schedule, Schema, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
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
import { causeText, databaseFile, Db, isDiskFull, StartupSnapshot } from "../db/Database.ts"
import { jobs, profiles, sessions, snapshots } from "../db/schema.ts"
import { SnapshotCopier, SnapshotWorkFailed } from "./copier.ts"
import { parseSnapshotName, SnapshotFolder, snapshotFileName } from "./names.ts"
import { keptSnapshots } from "./retention.ts"
import { moveIntoPlace, notADatabase, PartSuffix, removeWorkFile } from "./workFiles.ts"

// Snapshots of the database (docs/design.md, "Data safety and operations",
// decisions 109 to 112 and 117): taken daily and before risky changes, kept
// by the retention rule, and restored from the Curator's screen.

const DayMs = 86_400_000
// The full integrity check runs once a week. Its outcome is a file in the
// snapshots folder, as it is about the database file itself, so a restore
// does not take it back.
const IntegrityEveryMs = 7 * DayMs
const IntegrityFile = "integrity-check.json"

// Tables a restore leaves as they are: the migration log and the snapshots,
// which describe this database and its folder, who is signed in now and with
// which passphrase, and who may reach this computer (LAN mode and the paired
// devices, so a restore never brings back a revoked one).
const KeptOnRestore = new Set([
  "__drizzle_migrations",
  "snapshots",
  "profile_unlocks",
  "curator_unlocks",
  "curator_access",
  "lan_mode",
  "devices"
])

// The working copy a restore makes of the snapshot it restores.
const restoreCopyName = (id: string) => `restore-${id}.sqlite`
const RestoreCopyPattern = /^restore-[0-9a-f-]{36}\.sqlite(?:-journal)?$/

// Statuses of snapshots the app took that succeeded, kept or not since.
const Succeeded: ReadonlySet<string> = new Set(["ok", "removed", "missing"])

const DiskFullForRestore = "The disk is full. Free some space, then restore again."

const hostZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
// The host's calendar date of a moment, as a day number and as YYYY-MM-DD.
const hostDayOf = (at: number) => studyDayOf(at, hostZone(), 0)
const dayText = (day: number) => new Date(day * DayMs).toISOString().slice(0, 10)
const dayNumber = (text: string) => Math.round(Date.parse(`${text}T00:00:00Z`) / DayMs)

// What SQLite says when the file it opens is not a database it can read,
// rather than when the check could not run at all.
const fileComplaint = (detail: string) =>
  /not a database|malformed|corrupt|encrypted|SQLITE_NOTADB|SQLITE_CORRUPT|unable to open database file/i.test(detail)

const decodeIntegrity = Schema.decodeUnknownOption(IntegrityView)

// The names in a folder, or none when it cannot be read.
const namesIn = (folder: string) => {
  try {
    return readdirSync(folder)
  } catch {
    return []
  }
}

type SnapshotRow = typeof snapshots.$inferSelect

const viewOf = (row: SnapshotRow) =>
  new SnapshotView({ id: SnapshotId.make(row.id), kind: row.kind as SnapshotKind, takenAt: row.takenAt, size: row.size, found: row.found })

export class Snapshots extends Context.Service<Snapshots, {
  // Takes a snapshot now and records it, then deletes those the retention
  // rule no longer keeps. A failure is recorded and reported, never
  // skipped.
  take(kind: SnapshotKind): Effect.Effect<SnapshotView, SnapshotFailed>
  readonly list: Effect.Effect<SnapshotsView>
  // At startup and each hour: brings the records in line with the folder,
  // takes the day's snapshot when none was taken, and runs the integrity
  // check when it is due.
  readonly tend: Effect.Effect<void>
  restore(id: SnapshotId): Effect.Effect<RestoreDone, SnapshotNotFound | RestoreBlocked | SnapshotUnusable | SnapshotFailed>
  // Runs the effect after each restore that went through, such as waking a
  // clock that ticks the Sessions the snapshot brought back.
  afterRestore(effect: Effect.Effect<void>): Effect.Effect<void>
}>()("gmat-prep/server/Snapshots") {
  static readonly layer = Layer.effect(
    Snapshots,
    Effect.gen(function*() {
      const db = yield* Db
      const sql = yield* SqlClient.SqlClient
      const copier = yield* SnapshotCopier
      const startup = yield* StartupSnapshot
      const { dataDir } = yield* AppConfig
      const folder = join(dataDir, SnapshotFolder)
      const live = databaseFile(dataDir)
      // One snapshot, restore or check at a time.
      const oneAtATime = (yield* Semaphore.make(1)).withPermits(1)
      const restored: Array<Effect.Effect<void>> = []

      // Work a stop cut short: copies still under their temporary names,
      // and the working copies of restores. None is in progress yet.
      yield* Effect.sync(() => {
        for (const name of namesIn(folder)) {
          const stem = name.replace(/-journal$/, "")
          const part = stem.endsWith(PartSuffix) && parseSnapshotName(stem.slice(0, -PartSuffix.length)) !== undefined
          if (part || RestoreCopyPattern.test(name)) rmSync(join(folder, name), { force: true })
        }
      })

      const rowsOf = (status: string) =>
        db.select().from(snapshots).where(eq(snapshots.status, status)).orderBy(desc(snapshots.takenAt)).pipe(Effect.orDie)

      // Deletes the files of the snapshots the rule no longer keeps; those
      // found in the folder are never deleted. A file that cannot be deleted
      // stays listed and is tried again after the next snapshot, and never
      // fails the snapshot that came before it.
      const applyRetention = Effect.gen(function*() {
        const taken = (yield* rowsOf("ok")).filter((row) => !row.found)
        const keep = keptSnapshots(taken.map((row) => ({ id: row.id, kind: row.kind as SnapshotKind, at: row.takenAt, day: dayNumber(row.day) })))
        const removed: Array<string> = []
        for (const row of taken) {
          if (keep.has(row.id) || row.file === null) continue
          const file = join(folder, row.file)
          const problem = yield* Effect.sync(() => {
            try {
              rmSync(file, { force: true })
              return undefined
            } catch (error) {
              return error instanceof Error ? error.message : String(error)
            }
          })
          if (problem === undefined) removed.push(row.id)
          else yield* Effect.logWarning(`The snapshot ${row.file} could not be deleted, and is tried again later: ${problem}`)
        }
        if (removed.length === 0) return
        const now = yield* Clock.currentTimeMillis
        yield* db.update(snapshots).set({ status: "removed", removedAt: now }).where(inArray(snapshots.id, removed)).pipe(Effect.orDie)
      }).pipe(Effect.catchCause((cause) => Effect.logError("Old snapshots could not be deleted", cause)))

      // Copies the live database into a new snapshot file and records it.
      // The copy is written under a temporary name and takes its own once it
      // is checked and recorded, so a file under a snapshot's name is always
      // whole and has its record. Every attempt is recorded; one that fails
      // leaves no file.
      const takeNow = (kind: SnapshotKind) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const id = crypto.randomUUID()
          const name = snapshotFileName(kind, now, id.slice(0, 8))
          const file = join(folder, name)
          const part = `${file}${PartSuffix}`
          const day = dayText(hostDayOf(now))
          const failed = (detail: string) =>
            Effect.gen(function*() {
              const diskFull = isDiskFull(detail)
              const error = diskFull ? "The disk is full. Free some space, and the next snapshot will be taken." : detail
              yield* Effect.logError(`Snapshot ${kind} failed: ${detail}`)
              return { diskFull, error }
            })
          return yield* Effect.gen(function*() {
            const copied = yield* Effect.result(
              Effect.try({
                try: () => {
                  mkdirSync(folder, { recursive: true })
                  removeWorkFile(part)
                },
                catch: (cause) => new SnapshotWorkFailed({ detail: causeText(cause) })
              }).pipe(Effect.andThen(copier.copy(live, part)))
            )
            if (copied._tag === "Failure") {
              const { diskFull, error } = yield* failed(copied.failure.detail)
              yield* db.insert(snapshots).values({ id, kind, file: null, takenAt: now, day, size: null, sha256: null, status: "failed", error })
                .pipe(Effect.orDie)
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
              removedAt: null,
              found: false
            }
            yield* db.insert(snapshots).values(row).pipe(Effect.orDie)
            const placed = yield* Effect.result(Effect.try({ try: () => moveIntoPlace(part, file), catch: causeText }))
            if (placed._tag === "Failure") {
              const { diskFull, error } = yield* failed(placed.failure)
              yield* db.update(snapshots).set({ file: null, size: null, sha256: null, status: "failed", error }).where(eq(snapshots.id, id))
                .pipe(Effect.orDie)
              return yield* new SnapshotFailed({ detail: error, diskFull })
            }
            return row
          }).pipe(Effect.ensuring(Effect.sync(() => removeWorkFile(part))))
        })

      const take = (kind: SnapshotKind) =>
        takeNow(kind).pipe(
          Effect.tap(() => applyRetention),
          Effect.map(viewOf),
          oneAtATime
        )

      const integrityOf = Effect.sync(() => {
        try {
          const found = decodeIntegrity(JSON.parse(readFileSync(join(folder, IntegrityFile), "utf8")))
          return found._tag === "Some" ? found.value : null
        } catch {
          return null
        }
      })

      // Runs the full check on the live database and keeps its outcome. A
      // check that could not run says so, and is not taken for damage.
      const runCheck = (afterRestore: boolean) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const checked = yield* Effect.result(copier.check(live, false))
          const view = checked._tag === "Failure"
            ? new IntegrityView({ at: now, outcome: "not-run", detail: checked.failure.detail, afterRestore })
            : new IntegrityView({ at: now, outcome: checked.success === "ok" ? "ok" : "damaged", detail: checked.success, afterRestore })
          if (view.outcome === "damaged") yield* Effect.logError(`The integrity check found: ${view.detail}`)
          if (view.outcome === "not-run") yield* Effect.logWarning(`The integrity check could not run: ${view.detail}`)
          // Kept beside the snapshots; when it cannot be written, as on a full
          // disk, the outcome before it stands and the caller goes on.
          yield* Effect.try({
            try: () => {
              mkdirSync(folder, { recursive: true })
              const file = join(folder, IntegrityFile)
              writeFileSync(`${file}${PartSuffix}`, JSON.stringify(view), { mode: 0o600 })
              renameSync(`${file}${PartSuffix}`, file)
            },
            catch: causeText
          }).pipe(Effect.catch((detail) => Effect.logWarning(`The integrity check's outcome could not be kept: ${detail}`)))
        })

      // The weekly check; sooner when the last could not run or found
      // damage, so a check that failed to start, or damage set right, does
      // not stand for a week.
      const checkIntegrity = Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        const last = yield* integrityOf
        if (last !== null && last.outcome === "ok" && now - last.at < IntegrityEveryMs) return
        yield* runCheck(false)
      })

      const list = Effect.gen(function*() {
        const rows = yield* db.select().from(snapshots).orderBy(desc(snapshots.takenAt)).pipe(Effect.orDie)
        const succeeded = rows.filter((row) => !row.found && Succeeded.has(row.status))
        const failed = rows.filter((row) => row.status === "failed")
        // A file in the folder that is no snapshot, while it is there.
        const files = failed.filter((row) => row.file !== null)
        // The latest attempt of a kind that failed, until a later snapshot
        // succeeds: a daily one for the daily snapshot, which is tried again
        // each hour; any one for the others, as what stops one, such as a
        // full disk, stops them all.
        const attempts = [...Map.groupBy(failed.filter((row) => row.file === null), (row) => row.kind)].flatMap(([kind, ofKind]) => {
          const latest = ofKind[0]!
          const later = succeeded.some((row) => row.takenAt > latest.takenAt && (kind !== "daily" || row.kind === "daily"))
          return later ? [] : [latest]
        })
        const failures = [...files, ...attempts].toSorted((a, b) => b.takenAt - a.takenAt).map((row) =>
          new SnapshotFailureView({ kind: row.kind as SnapshotKind, at: row.takenAt, error: row.error ?? "" })
        )
        return new SnapshotsView({
          snapshots: rows.filter((row) => row.status === "ok").map(viewOf),
          failures,
          integrity: yield* integrityOf
        })
      })

      // Brings the records in line with the folder (decision 109). A file
      // with a snapshot's name and no record, such as the one this start
      // took before migrating, is checked and recorded with its checksum: as
      // the app's own when this start took it, otherwise as found, which
      // retention never deletes. One that is no usable snapshot is recorded
      // as such, and shown while it is there. A kept snapshot whose file has
      // gone is marked missing.
      const reconcile = Effect.gen(function*() {
        const names = yield* Effect.sync(() => namesIn(folder))
        const rows = yield* db.select().from(snapshots).pipe(Effect.orDie)
        const known = new Set(rows.flatMap((row) => (row.file === null ? [] : [row.file])))
        for (const name of names) {
          const parsed = parseSnapshotName(name)
          if (parsed === undefined || known.has(name)) continue
          const path = join(folder, name)
          const notOne = yield* Effect.sync(() => notADatabase(path))
          const inspected = notOne === undefined ? yield* Effect.result(copier.inspect(path)) : undefined
          if (inspected?._tag === "Failure" && !fileComplaint(inspected.failure.detail)) {
            yield* Effect.logWarning(`The snapshot file ${name} could not be checked, and is tried again later: ${inspected.failure.detail}`)
            continue
          }
          const report = inspected?._tag === "Success" ? inspected.success : undefined
          const why = notOne ??
            (report === undefined
              ? `SQLite cannot read it (${inspected?._tag === "Failure" ? inspected.failure.detail : "unknown"})`
              : report.verdict !== "ok"
              ? `SQLite's check found damage (${report.verdict})`
              : report.migrations === 0
              ? "it is not a database of this app"
              : undefined)
          yield* db.insert(snapshots).values({
            id: crypto.randomUUID(),
            kind: parsed.kind,
            file: name,
            takenAt: parsed.at,
            day: dayText(hostDayOf(parsed.at)),
            size: report?.size ?? (yield* Effect.sync(() => statSync(path, { throwIfNoEntry: false })?.size ?? null)),
            sha256: report?.sha256 ?? null,
            status: why === undefined ? "ok" : "failed",
            error: why === undefined
              ? null
              : `The file ${name} in the snapshots folder is not a snapshot the app can use: ${why}. Delete it, or move it out of the folder.`,
            removedAt: null,
            found: name !== startup.file
          }).pipe(Effect.orDie)
        }
        const present = new Set(names)
        const now = yield* Clock.currentTimeMillis
        const missing = rows.filter((row) => row.status === "ok" && row.file !== null && !present.has(row.file)).map((row) => row.id)
        if (missing.length > 0) {
          yield* db.update(snapshots).set({ status: "missing", removedAt: now }).where(inArray(snapshots.id, missing)).pipe(Effect.orDie)
        }
        // A found file that was no snapshot, gone now: nothing is left to show.
        const gone = rows.filter((row) => row.status === "failed" && row.file !== null && !present.has(row.file)).map((row) => row.id)
        if (gone.length > 0) yield* db.delete(snapshots).where(inArray(snapshots.id, gone)).pipe(Effect.orDie)
      })

      const tend = Effect.gen(function*() {
        yield* reconcile.pipe(oneAtATime)
        const today = dayText(hostDayOf(yield* Clock.currentTimeMillis))
        const [taken] = yield* db.select({ id: snapshots.id }).from(snapshots)
          .where(and(
            eq(snapshots.kind, "daily"),
            eq(snapshots.day, today),
            eq(snapshots.found, false),
            inArray(snapshots.status, ["ok", "removed"])
          ))
          .limit(1).pipe(Effect.orDie)
        if (taken === undefined) yield* take("daily").pipe(Effect.ignore)
        yield* checkIntegrity.pipe(oneAtATime)
      })

      // What a restore would cut short (decision 112): a job running or
      // waiting to run, or a Learner's Mock, Sectional or timed set, paused
      // or not, named with the Learner's Profile.
      const underWay = Effect.gen(function*() {
        const [job] = yield* db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.status, ["queued", "running"])).limit(1)
          .pipe(Effect.orDie)
        if (job !== undefined) return new RestoreBlocked({ reason: "job-running", learner: null, session: null, paused: false })
        const [session] = yield* db.select({ kind: sessions.kind, status: sessions.status, learner: profiles.name })
          .from(sessions)
          .innerJoin(profiles, eq(profiles.id, sessions.profileId))
          .where(and(
            inArray(sessions.status, ["active", "paused"]),
            raw`(${sessions.timed} = 1 or ${sessions.kind} in ('mock', 'mock-section', 'sectional'))`
          ))
          .orderBy(sessions.createdAt).limit(1).pipe(Effect.orDie)
        if (session === undefined) return undefined
        return new RestoreBlocked({
          reason: "session-running",
          learner: session.learner,
          session: session.kind === "practice" ? "timed-set" : session.kind === "sectional" ? "sectional" : "mock",
          paused: session.status === "paused"
        })
      })

      // Empties every table but those kept and fills it from the attached
      // copy. Runs inside the restore's transaction, with foreign keys off;
      // references are checked before it commits.
      const swapTables = Effect.gen(function*() {
        const tablesIn = (schema: "main" | "restored") =>
          sql.unsafe<{ readonly name: string }>(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
            .pipe(Effect.map((rows) => rows.map((row) => row.name)))
        const tables = (yield* tablesIn("main")).filter((name) => !KeptOnRestore.has(name))
        const held = new Set(yield* tablesIn("restored"))
        const lacking = tables.filter((name) => !held.has(name))
        if (lacking.length > 0) {
          return yield* new SnapshotUnusable({ reason: "damaged", detail: `It lacks tables this version keeps: ${lacking.join(", ")}.` })
        }
        const [jobsBefore] = yield* sql<{ readonly revision: number }>`SELECT coalesce(max(revision), 0) AS revision FROM jobs`
        for (const table of tables) {
          const columns = (yield* sql.unsafe<{ readonly name: string }>(`PRAGMA main.table_info("${table}")`))
            .map((column) => `"${column.name}"`).join(", ")
          yield* sql.unsafe(`DELETE FROM main."${table}"`)
          yield* sql.unsafe(`INSERT INTO main."${table}" (${columns}) SELECT ${columns} FROM restored."${table}"`)
        }
        // Unlocks of Profiles the snapshot does not hold end.
        yield* sql`DELETE FROM profile_unlocks WHERE profile_id NOT IN (SELECT id FROM profiles)`
        // Jobs that were under way when the snapshot was taken, or waiting to
        // resume on their own, wait for the Curator, and every job's revision
        // moves past those already sent, so open pages hear of them.
        yield* sql`
          UPDATE jobs SET status = 'paused', note = ${"Paused by the restore. Resume it when you are ready."},
            claimant = NULL, heartbeat_at = NULL, requested = NULL, resume_at = NULL
          WHERE status IN ('queued', 'running') OR (status = 'paused' AND resume_at IS NOT NULL)
        `
        yield* sql`UPDATE jobs SET revision = revision + ${jobsBefore?.revision ?? 0}`
        // Timed sets under way when the snapshot was taken wait, paused, for
        // their Learners to resume them. Mocks, Sectionals and their
        // Sections cannot pause: they go on from their last saved time, the
        // time since not counted, as after the app stops and starts again.
        yield* sql`UPDATE sessions SET status = 'paused', interrupted = 1 WHERE kind = 'practice' AND timed = 1 AND status = 'active'`
        yield* sql`UPDATE sessions SET interrupted = 1 WHERE kind IN ('sectional', 'mock-section') AND status = 'active'`
        const broken = yield* sql`PRAGMA foreign_key_check`
        if (broken.length > 0) {
          return yield* new SnapshotUnusable({ reason: "damaged", detail: `It holds ${broken.length} broken references.` })
        }
      })

      // The restore's own change, holding SQLite's write lock from before
      // the pre-restore snapshot until the swap commits (decision 112). The
      // server's connection is reserved throughout, so its other requests
      // wait their turn instead of writing meanwhile or running with foreign
      // keys off, and the job worker cannot write. The copy process can
      // still read, as WAL mode lets readers be, so the pre-restore snapshot
      // is the database exactly as it stands when the tables are swapped.
      const swapUnderLock = (copy: string) =>
        Effect.scoped(Effect.gen(function*() {
          const conn = yield* sql.reserve
          const run = (statement: string, params: ReadonlyArray<unknown> = []) => conn.executeRaw(statement, params)
          const rollback = run("ROLLBACK").pipe(
            Effect.catch((error) => (/no transaction is active/i.test(causeText(error)) ? Effect.void : Effect.fail(error))),
            Effect.orDie
          )
          // SQLite takes the foreign_keys pragma only outside a transaction.
          yield* run("PRAGMA foreign_keys = OFF")
          yield* Effect.addFinalizer(() => run("PRAGMA foreign_keys = ON").pipe(Effect.orDie))
          yield* run("ATTACH DATABASE ? AS restored", [copy])
          yield* Effect.addFinalizer(() => run("DETACH DATABASE restored").pipe(Effect.orDie))
          yield* run("BEGIN IMMEDIATE")
          let replaced: SnapshotRow | undefined
          const work = Effect.gen(function*() {
            // Checked again now that nothing new can start.
            const blocked = yield* underWay
            if (blocked !== undefined) return yield* blocked
            const taken = yield* Effect.result(takeNow("pre-restore"))
            // Nothing is swapped, and the failed attempt's record commits.
            if (taken._tag === "Failure") return { _tag: "NotTaken", error: taken.failure } as const
            replaced = taken.success
            yield* swapTables
            return { _tag: "Restored", replaced: taken.success } as const
          })
          // When it does not commit, the database stands as it was, the same
          // as the pre-restore copy, which goes.
          const undo = Effect.gen(function*() {
            yield* rollback
            if (replaced?.file != null) yield* Effect.sync(() => removeWorkFile(join(folder, replaced!.file!)))
          })
          const outcome = yield* Effect.exit(Effect.provideService(work, sql.transactionService, [conn, 0] as const))
          if (Exit.isFailure(outcome)) {
            yield* undo
            return yield* Effect.failCause(outcome.cause)
          }
          const committed = yield* Effect.exit(run("COMMIT"))
          if (Exit.isFailure(committed)) {
            yield* undo
            return yield* Effect.failCause(committed.cause)
          }
          return outcome.value
        }))

      // A full disk is named as such; any other failure of the database
      // stays a fault of the app.
      const diskFull = new SnapshotFailed({ detail: DiskFullForRestore, diskFull: true })
      const swapOrDiskFull = (copy: string) =>
        swapUnderLock(copy).pipe(
          Effect.catchTag("SqlError", (error) => (isDiskFull(causeText(error)) ? Effect.fail(diskFull) : Effect.die(error))),
          Effect.catchDefect((defect) => (isDiskFull(causeText(defect)) ? Effect.fail(diskFull) : Effect.die(defect)))
        )

      // Restore (decision 112): the chosen snapshot is copied, checked and
      // brought to this build's schema on the side; then, under the write
      // lock, the database as it stands is kept as a snapshot and every
      // table but those kept is filled from the copy, in one transaction.
      // It runs to its end once begun, as a stop half way would leave the
      // timed Sessions it brought back without their clocks.
      const restore = (id: SnapshotId) =>
        Effect.gen(function*() {
          const [row] = yield* db.select().from(snapshots).where(and(eq(snapshots.id, id), eq(snapshots.status, "ok")))
            .pipe(Effect.orDie)
          if (row === undefined || row.file === null) return yield* new SnapshotNotFound()
          // Refused at once, before any copy is made; checked again under
          // the lock.
          const blocked = yield* underWay
          if (blocked !== undefined) return yield* blocked
          const file = join(folder, row.file)
          if (!existsSync(file)) {
            const now = yield* Clock.currentTimeMillis
            yield* db.update(snapshots).set({ status: "missing", removedAt: now }).where(eq(snapshots.id, id)).pipe(Effect.orDie)
            return yield* new SnapshotNotFound()
          }
          const unusable = (reason: "changed" | "damaged" | "newer" | "foreign") => (detail: string) => new SnapshotUnusable({ reason, detail })
          if (row.sha256 !== null) {
            const hash = yield* copier.hash(file).pipe(Effect.mapError((failure) => unusable("damaged")(failure.detail)))
            if (hash !== row.sha256) return yield* unusable("changed")("The snapshot's file has changed since it was taken.")
          }
          const now = yield* Clock.currentTimeMillis
          const copy = join(folder, restoreCopyName(id))
          return yield* Effect.gen(function*() {
            yield* Effect.sync(() => removeWorkFile(copy))
            yield* copier.copy(file, copy).pipe(Effect.mapError((failure) =>
              isDiskFull(failure.detail)
                ? new SnapshotFailed({ detail: DiskFullForRestore, diskFull: true })
                : unusable("damaged")(failure.detail)
            ))
            const migrated = yield* copier.migrate(copy, now).pipe(Effect.mapError((failure) => unusable("damaged")(failure.detail)))
            if (migrated._tag === "newer") {
              return yield* unusable("newer")(`A newer version of the app wrote it: ${migrated.unknown.join(", ")}.`)
            }
            if (migrated._tag === "foreign") return yield* unusable("foreign")("It records none of this app's migrations.")
            const outcome = yield* swapOrDiskFull(copy)
            if (outcome._tag === "NotTaken") return yield* (outcome.error.diskFull ? diskFull : outcome.error)
            yield* applyRetention
            for (const wake of restored) yield* wake
            yield* Effect.logInfo(`Restored the snapshot taken ${new Date(row.takenAt).toISOString()}`)
            // Damage only the full check finds may be gone with the rows
            // that held it; damage in the file itself is not.
            yield* runCheck(true)
            const current = (yield* db.select().from(snapshots).where(eq(snapshots.id, id)).pipe(Effect.orDie))[0] ?? row
            return new RestoreDone({ restored: viewOf(current), replaced: viewOf(outcome.replaced) })
          }).pipe(Effect.ensuring(Effect.sync(() => removeWorkFile(copy))))
        }).pipe(Effect.uninterruptible, oneAtATime)

      const afterRestore = (effect: Effect.Effect<void>) => Effect.sync(() => void restored.push(effect))

      return Snapshots.of({ take, list, tend, restore, afterRestore })
    })
  )

  // The hourly round of `tend`, for the running server; tests call `tend`.
  static readonly schedule = Layer.effectDiscard(
    Effect.gen(function*() {
      const snapshots = yield* Snapshots
      // A round that stops on something unforeseen is logged, and the next
      // one comes an hour later all the same.
      const round = snapshots.tend.pipe(
        Effect.catchCause((cause) => Effect.logError("The snapshot round stopped", cause))
      )
      yield* Effect.forkScoped(round.pipe(Effect.repeat(Schedule.spaced("1 hour"))))
    })
  )
}
