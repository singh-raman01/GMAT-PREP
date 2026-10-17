import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Clock, Effect, Fiber, Layer, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Api } from "../src/api/Api.ts"
import { DefaultBlueprint } from "../src/api/blueprint.ts"
import { InstallExportPath } from "../src/api/Exports.ts"
import type { PracticeView } from "../src/api/Practice.ts"
import { AppConfig } from "../src/server/AppConfig.ts"
import { Db, makeDatabaseLive, SnapshotBeforeUpdateFailed } from "../src/server/db/Database.ts"
import { bundledMigrations } from "../src/server/db/migrations/index.gen.ts"
import { dailyNotes, jobs, parts, profiles, questions, reviewItems, sessions, snapshots } from "../src/server/db/schema.ts"
import { hashFile, migrateDatabase } from "../src/server/snapshots/files.ts"
import { snapshotFileName } from "../src/server/snapshots/names.ts"
import { Snapshots } from "../src/server/snapshots/Snapshots.ts"
import { readTar } from "../src/server/snapshots/tar.ts"
import { AllJobKinds } from "../src/server/jobs/kinds/index.ts"
import { explainStartupFailure } from "../src/server/main.ts"
import { blockedText, sizeText, takenTexts } from "../web/src/curator/dataText.ts"
import { dayAndTime } from "../web/src/format.ts"
import { byNumber, configure, confirmAndExtract, curatorBrowser, passphrase, proposedBook, rangesOf } from "./bookFlow.ts"
import { numbered, seedBook } from "./fixtures/bank.ts"
import { CopierFaults, runWithWorker, runWithWorkers, tempDataDir, type WorkerTestServices } from "./harness.ts"

// The fixes from the review of snapshots, restore, export and deletion
// (decisions 109 to 118). The tests drive the real routes and services with
// the copy work in process; some send a request at a chosen moment of it, as
// one arriving while a real copy process works would be.

// Noon UTC on Monday 2 November 2026.
const Start = Date.UTC(2026, 10, 2, 12)
const run = <A, E>(effect: Effect.Effect<A, E, WorkerTestServices>, dataDir = tempDataDir()) =>
  runWithWorkers(effect, undefined, dataDir, Start)

const learner = (name: string, pin?: string) =>
  Effect.gen(function*() {
    const jar = yield* Ref.make(Cookies.empty)
    const tab = yield* HttpApiClient.make(Api, {
      transformClient: (client) =>
        client.pipe(HttpClient.withCookiesRef(jar), HttpClient.mapRequest(HttpClientRequest.setHeader("x-gp-device", `tab-${name}`)))
    })
    const profile = yield* tab.profiles.create({ payload: { name, timeZone: "UTC", ...(pin === undefined ? {} : { pin }) } })
    return Object.assign(tab, { profileId: profile.id })
  })
type Tab = Effect.Success<ReturnType<typeof learner>>

const folderOf = Effect.gen(function*() {
  const folder = join((yield* AppConfig).dataDir, "snapshots")
  mkdirSync(folder, { recursive: true })
  return folder
})

const fileOf = (id: string) =>
  Effect.gen(function*() {
    const [row] = yield* (yield* Db).select().from(snapshots).where(eq(snapshots.id, id))
    return join(yield* folderOf, row!.file!)
  })

const notesIn = (file: string) => {
  const db = new Database(file, { readonly: true })
  try {
    return (db.query("SELECT note FROM daily_notes ORDER BY note").values() as Array<[string]>).map((row) => row[0])
  } finally {
    db.close()
  }
}

const liveNotes = Effect.gen(function*() {
  return (yield* (yield* Db).select({ note: dailyNotes.note }).from(dailyNotes)).map((row) => row.note).toSorted()
})

const writeNote = (tab: Tab, note: string) => tab.plan.writeNote({ params: { day: "2026-11-02" }, payload: { note } })

const timedSet = (tab: Tab) => tab.practice.start({ payload: { choice: { kind: "filters", status: "any", size: 2, timed: true } } })

const restore = (curator: Effect.Success<typeof curatorBrowser>, id: string) =>
  curator.api.snapshots.restore({ params: { id: id as never }, payload: { passphrase } })

// Lets fibers run that the fake clock woke, as a real second would.
const tick = (times = 1) =>
  Effect.gen(function*() {
    for (let index = 0; index < times; index++) {
      yield* TestClock.adjust("1 second")
      yield* Effect.promise(() => Bun.sleep(5))
    }
  })

describe("A restore holds the write lock from the pre-restore snapshot to the swap", () => {
  test("requests sent while the pre-restore snapshot is copied wait, and land in the restored database", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Algebra", numbered(6))
      const curator = yield* curatorBrowser
      const asha = yield* learner("Asha")
      yield* writeNote(asha, "Before.")
      const before = (yield* curator.api.snapshots.take()).snapshots[0]!
      yield* TestClock.adjust("1 minute")
      // A note and a timed set, sent once the restore holds the lock.
      const sent = yield* Ref.make<ReadonlyArray<Fiber.Fiber<unknown, unknown>>>([])
      yield* (yield* CopierFaults).onCopy(/pre-restore-.*\.part$/, Effect.gen(function*() {
        const note = yield* Effect.forkDetach(writeNote(asha, "Written during the restore."))
        const set = yield* Effect.forkDetach(timedSet(asha))
        yield* Ref.set(sent, [note, set])
        // Time for both to reach the server and wait for the database.
        yield* Effect.promise(() => Bun.sleep(100))
      }))
      const done = yield* restore(curator, before.id)
      const [note, set] = yield* Ref.get(sent)
      yield* Fiber.join(note!)
      const started = (yield* Fiber.join(set!)) as PracticeView
      // Both went through after the swap: the note is in the restored
      // database, not in the one it replaced, and the timed set runs.
      expect(yield* liveNotes).toEqual(["Before.", "Written during the restore."])
      expect(notesIn(yield* fileOf(done.replaced.id))).toEqual(["Before."])
      const [row] = yield* (yield* Db).select({ status: sessions.status }).from(sessions).where(eq(sessions.id, started.id))
      expect(row?.status).toBe("active")
    })))

  test("a write made before the lock is taken is kept in the pre-restore snapshot", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      const asha = yield* learner("Asha")
      yield* writeNote(asha, "Before.")
      const before = (yield* curator.api.snapshots.take()).snapshots[0]!
      yield* TestClock.adjust("1 minute")
      // Sent while the chosen snapshot is copied, before the lock.
      yield* (yield* CopierFaults).onCopy(/restore-[0-9a-f-]{36}\.sqlite$/, writeNote(asha, "Written while it was copied.").pipe(Effect.orDie))
      const done = yield* restore(curator, before.id)
      expect(yield* liveNotes).toEqual(["Before."])
      expect(notesIn(yield* fileOf(done.replaced.id))).toEqual(["Before.", "Written while it was copied."])
    })))

  test("a timed set started while the snapshot is copied holds the restore back, and is kept", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Algebra", numbered(6))
      const curator = yield* curatorBrowser
      const asha = yield* learner("Asha")
      const before = (yield* curator.api.snapshots.take()).snapshots[0]!
      yield* TestClock.adjust("1 minute")
      const started = yield* Ref.make<string | undefined>(undefined)
      yield* (yield* CopierFaults).onCopy(
        /restore-[0-9a-f-]{36}\.sqlite$/,
        timedSet(asha).pipe(Effect.flatMap((view) => Ref.set(started, view.id)), Effect.orDie)
      )
      const refused = yield* restore(curator, before.id).pipe(Effect.flip)
      expect(refused).toMatchObject({ _tag: "RestoreBlocked", reason: "session-running", learner: "Asha", session: "timed-set", paused: false })
      const id = (yield* Ref.get(started))!
      expect((yield* asha.practice.get({ params: { id: id as never } })).status).toBe("active")
      // Nothing was replaced, and no pre-restore snapshot was taken.
      const kinds = (yield* (yield* Db).select({ kind: snapshots.kind }).from(snapshots)).map((row) => row.kind)
      expect(kinds).toEqual(["manual"])
      expect(readdirSync(yield* folderOf).filter((name) => !name.startsWith("manual-"))).toEqual([])
    })))

  test("a job waiting to run holds the restore back, and so does one the worker claims while the snapshot is copied", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      const before = (yield* curator.api.snapshots.take()).snapshots[0]!
      const db = yield* Db
      const job = (id: string, status: string) =>
        db.insert(jobs).values({ id, kind: "connection-test", params: "{}", status, spendCap: 1, revision: 1, createdAt: Start, updatedAt: Start })
      yield* job("queued-1", "queued")
      expect(yield* restore(curator, before.id).pipe(Effect.flip)).toMatchObject({ _tag: "RestoreBlocked", reason: "job-running" })
      yield* db.update(jobs).set({ status: "done" }).where(eq(jobs.id, "queued-1"))
      yield* (yield* CopierFaults).onCopy(/restore-[0-9a-f-]{36}\.sqlite$/, job("claimed-1", "running").pipe(Effect.asVoid, Effect.orDie))
      expect(yield* restore(curator, before.id).pipe(Effect.flip)).toMatchObject({ _tag: "RestoreBlocked", reason: "job-running" })
      expect((yield* db.select({ id: jobs.id }).from(jobs)).map((row) => row.id).toSorted()).toEqual(["claimed-1", "queued-1"])
    })))

  test("a paused timed set holds the restore back, naming its Learner", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Algebra", numbered(6))
      const curator = yield* curatorBrowser
      const asha = yield* learner("Asha")
      const before = (yield* curator.api.snapshots.take()).snapshots[0]!
      yield* TestClock.adjust("1 minute")
      const set = yield* timedSet(asha)
      yield* asha.practice.pause({ params: { id: set.id } })
      const refused = yield* restore(curator, before.id).pipe(Effect.flip)
      expect(refused).toMatchObject({ _tag: "RestoreBlocked", reason: "session-running", learner: "Asha", session: "timed-set", paused: true })
      expect((yield* asha.practice.resume({ params: { id: set.id } })).status).toBe("active")
    })))

  test("a restore needs the Curator passphrase again, and a wrong one counts as an unlock attempt", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      const asha = yield* learner("Asha")
      yield* writeNote(asha, "Before.")
      const before = (yield* curator.api.snapshots.take()).snapshots[0]!
      yield* writeNote(asha, "After.")
      const wrong = yield* curator.api.snapshots.restore({ params: { id: before.id }, payload: { passphrase: "not it at all" } })
        .pipe(Effect.flip)
      expect(wrong).toMatchObject({ _tag: "WrongPassphrase", attemptsLeft: 4 })
      expect(yield* liveNotes).toEqual(["After.", "Before."])
      yield* restore(curator, before.id)
      expect(yield* liveNotes).toEqual(["Before."])
    })))
})

describe("Timed Sessions a snapshot holds", () => {
  test("a timed set under way comes back paused; until its Learner finishes it the undo waits, naming them", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Algebra", numbered(6))
      const curator = yield* curatorBrowser
      const asha = yield* learner("Asha")
      const set = yield* timedSet(asha)
      // Taken while Asha is in the set, as a daily or pre-deletion one may be.
      const during = (yield* curator.api.snapshots.take()).snapshots[0]!
      yield* asha.practice.finish({ params: { id: set.id } })
      yield* tick(2)
      yield* TestClock.adjust("1 hour")
      const done = yield* restore(curator, during.id)
      const db = yield* Db
      const [row] = yield* db.select().from(sessions).where(eq(sessions.id, set.id))
      expect(row).toMatchObject({ status: "paused", interrupted: true })
      const undo = yield* restore(curator, done.replaced.id).pipe(Effect.flip)
      expect(undo).toMatchObject({ _tag: "RestoreBlocked", learner: "Asha", session: "timed-set", paused: true })
      // Asha resumes the set, its clock goes on, and she finishes it.
      expect((yield* asha.practice.resume({ params: { id: set.id } })).status).toBe("active")
      yield* tick(6)
      const [running] = yield* db.select().from(sessions).where(eq(sessions.id, set.id))
      expect(running!.elapsedMs).toBeGreaterThan(row!.elapsedMs)
      yield* asha.practice.finish({ params: { id: set.id } })
      yield* restore(curator, done.replaced.id)
      expect((yield* db.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, set.id)))[0]!.status).toBe("finished")
    })))

  test("a Sectional under way comes back marked interrupted, with its clock running again", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      yield* curator.api.settings.saveBlueprint({ payload: { blueprint: { ...DefaultBlueprint, ps: 4 } } })
      yield* seedBook("Quant Review", numbered(8, { reserve: true }))
      const asha = yield* learner("Asha")
      const sectional = yield* asha.sectionals.start({ payload: { section: "quant" } })
      const during = (yield* curator.api.snapshots.take()).snapshots[0]!
      yield* asha.sectionals.finish({ params: { id: sectional.id } })
      yield* tick(2)
      yield* TestClock.adjust("1 hour")
      const done = yield* restore(curator, during.id)
      const restoredAt = yield* Clock.currentTimeMillis
      const db = yield* Db
      const [back] = yield* db.select().from(sessions).where(eq(sessions.id, sectional.id))
      expect(back).toMatchObject({ status: "active", interrupted: true })
      // The hour between is not counted; the clock counts again from now.
      yield* tick(7)
      const [later] = yield* db.select().from(sessions).where(eq(sessions.id, sectional.id))
      expect(later!.clockSavedAt).toBeGreaterThan(restoredAt)
      expect(later!.elapsedMs - back!.elapsedMs).toBeGreaterThanOrEqual(5_000)
      expect(later!.elapsedMs - back!.elapsedMs).toBeLessThan(10_000)
      const undo = yield* restore(curator, done.replaced.id).pipe(Effect.flip)
      expect(undo).toMatchObject({ _tag: "RestoreBlocked", learner: "Asha", session: "sectional", paused: false })
    })))
})

// A copy of the live database, as VACUUM INTO makes one.
const copyOfLive = (to: string) =>
  Effect.gen(function*() {
    const live = new Database(join((yield* AppConfig).dataDir, "gmat-prep.sqlite"), { readonly: true })
    live.run("VACUUM INTO ?", [to])
    live.close()
  })

describe("Files in the snapshots folder", () => {
  test("an empty, short, foreign or damaged file is never listed or restored, and is shown while it is there", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      yield* learner("Asha")
      const folder = yield* folderOf
      const { dataDir } = yield* AppConfig
      // What a start that ran out of space left before this fix: an empty
      // snapshot before an update. A daily snapshot cut short by a crash. A
      // database of another program. A folder with a snapshot's name.
      const empty = snapshotFileName("pre-migration", Start - 60_000)
      const half = snapshotFileName("daily", Start - 120_000, "deadbeef")
      const foreign = snapshotFileName("manual", Start - 180_000)
      const folderNamed = snapshotFileName("manual", Start - 240_000)
      yield* copyOfLive(join(dataDir, "whole.sqlite"))
      yield* Effect.sync(() => {
        writeFileSync(join(folder, empty), "")
        copyFileSync(join(dataDir, "whole.sqlite"), join(folder, half))
        truncateSync(join(folder, half), Math.floor(statSync(join(folder, half)).size / 2))
        const other = new Database(join(folder, foreign))
        other.run("CREATE TABLE recipes (id INTEGER PRIMARY KEY, name TEXT)")
        other.run("INSERT INTO recipes (name) VALUES ('Dal')")
        other.close()
        mkdirSync(join(folder, folderNamed))
      })
      yield* (yield* Snapshots).tend
      const listed = yield* curator.api.snapshots.list()
      // Today's daily snapshot is taken all the same.
      expect(listed.snapshots.map((each) => [each.kind, each.takenAt])).toEqual([["daily", Start]])
      const problems = listed.failures.map((failure) => failure.error)
      expect(problems).toHaveLength(4)
      for (const [name, why] of [[empty, "it is empty"], [foreign, "it is not a database of this app"], [folderNamed, "it is not a file"]]) {
        expect(problems).toContain(
          `The file ${name} in the snapshots folder is not a snapshot the app can use: ${why}. Delete it, or move it out of the folder.`
        )
      }
      expect(problems.some((problem) => problem.startsWith(`The file ${half} in the snapshots folder is not a snapshot the app can use`)))
        .toBe(true)
      // Once they are gone, so is the notice.
      yield* Effect.sync(() => {
        for (const name of [empty, half, foreign]) rmSync(join(folder, name))
        rmSync(join(folder, folderNamed), { recursive: true })
      })
      yield* TestClock.adjust("1 hour")
      yield* (yield* Snapshots).tend
      expect((yield* curator.api.snapshots.list()).failures).toEqual([])
    })))

  test("a copy found in the folder is listed with its checksum, can be restored, and is never deleted by retention", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      const asha = yield* learner("Asha")
      yield* writeNote(asha, "Kept by hand.")
      const folder = yield* folderOf
      const mine = snapshotFileName("manual", Start - 30 * 86_400_000)
      yield* copyOfLive(join(folder, mine))
      yield* writeNote(asha, "Later.")
      const service = yield* Snapshots
      yield* service.tend
      const found = (yield* curator.api.snapshots.list()).snapshots.find((each) => each.found)!
      expect(found).toMatchObject({ kind: "manual", takenAt: Start - 30 * 86_400_000 })
      const [row] = yield* (yield* Db).select().from(snapshots).where(eq(snapshots.id, found.id))
      expect(row!.sha256).toBe(yield* Effect.promise(() => hashFile(join(folder, mine))))
      for (let index = 0; index < 10; index++) {
        yield* TestClock.adjust("1 minute")
        yield* service.take("pre-deletion")
      }
      expect(readdirSync(folder)).toContain(mine)
      expect((yield* curator.api.snapshots.list()).snapshots.filter((each) => each.kind === "pre-deletion")).toHaveLength(10)
      yield* restore(curator, found.id)
      expect(yield* liveNotes).toEqual(["Kept by hand."])
    })))

  test("the snapshot a start takes before an update is the app's own, and retention deletes it in turn", () => {
    const dataDir = tempDataDir()
    // A database one migration behind this version.
    migrateDatabase(join(dataDir, "gmat-prep.sqlite"), bundledMigrations.slice(0, -1), Start)
    return run(Effect.gen(function*() {
      const service = yield* Snapshots
      yield* service.tend
      const listed = (yield* service.list).snapshots
      const before = listed.find((each) => each.kind === "pre-migration")!
      expect(before.found).toBe(false)
      const [row] = yield* (yield* Db).select().from(snapshots).where(eq(snapshots.id, before.id))
      expect(row!.sha256).toBe(yield* Effect.promise(() => hashFile(join(dataDir, "snapshots", row!.file!))))
      for (let index = 0; index < 10; index++) {
        yield* TestClock.adjust("1 minute")
        yield* service.take("pre-deletion")
      }
      expect((yield* service.list).snapshots.some((each) => each.kind === "pre-migration")).toBe(false)
      expect(existsSync(join(dataDir, "snapshots", row!.file!))).toBe(false)
    }), dataDir)
  })

  test("work a stop cut short is removed at the next start, and nothing else", () => {
    const dataDir = tempDataDir()
    const folder = join(dataDir, "snapshots")
    const exports = join(dataDir, "exports")
    mkdirSync(folder, { recursive: true })
    mkdirSync(exports, { recursive: true })
    const part = `${snapshotFileName("manual", Start - 60_000, "aaaaaaaa")}.part`
    const restoreCopy = `restore-${crypto.randomUUID()}.sqlite`
    const archivePart = "gmat-prep-2026-11-02T11-00-00Z-bbbbbbbb.tar.part"
    const databaseCopy = `database-${crypto.randomUUID()}.sqlite`
    const leftovers = [
      join(folder, part),
      join(folder, `${part}-journal`),
      join(folder, restoreCopy),
      join(folder, `${restoreCopy}-journal`),
      join(exports, archivePart),
      join(exports, databaseCopy),
      join(exports, `${databaseCopy}-journal`)
    ]
    const others = [join(folder, "notes.txt"), join(folder, "mine.part"), join(exports, "mine.tar")]
    for (const file of [...leftovers, ...others]) writeFileSync(file, "left behind")
    return run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      expect(leftovers.filter((file) => existsSync(file))).toEqual([])
      expect(others.filter((file) => existsSync(file))).toEqual(others)
      expect(yield* curator.api.curatorData.installExport()).toBeNull()
    }), dataDir)
  })

  test("a snapshot whose file has gone is no longer listed, and restoring it says it is no longer kept", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      const service = yield* Snapshots
      yield* service.tend
      const daily = (yield* curator.api.snapshots.list()).snapshots[0]!
      yield* TestClock.adjust("1 minute")
      const manual = (yield* curator.api.snapshots.take()).snapshots.find((each) => each.kind === "manual")!
      const manualFile = yield* fileOf(manual.id)
      const dailyFile = yield* fileOf(daily.id)
      yield* Effect.sync(() => rmSync(manualFile))
      expect(yield* restore(curator, manual.id).pipe(Effect.flip)).toMatchObject({ _tag: "SnapshotNotFound" })
      expect((yield* curator.api.snapshots.list()).snapshots.map((each) => each.id)).toEqual([daily.id])
      // Today's daily snapshot deleted by hand: the next round takes another.
      yield* Effect.sync(() => rmSync(dailyFile))
      yield* TestClock.adjust("1 hour")
      yield* service.tend
      const listed = (yield* curator.api.snapshots.list()).snapshots
      expect(listed.map((each) => [each.kind, each.takenAt])).toEqual([["daily", Start + 3_660_000]])
    })))

  test("the moved install lists none of the old install's snapshots, whose files it does not have", async () => {
    const source = tempDataDir()
    const target = tempDataDir()
    await run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      yield* learner("Asha")
      yield* curator.api.snapshots.take()
      yield* TestClock.adjust("1 minute")
      yield* curator.api.snapshots.take()
      yield* curator.api.curatorData.exportInstall()
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(HttpClientRequest.get(InstallExportPath).pipe(HttpClientRequest.setHeader("cookie", curator.cookie)))
      // Unpacked into the new computer's empty data folder.
      for (const file of readTar(new Uint8Array(yield* response.arrayBuffer))) {
        mkdirSync(join(target, file.name, ".."), { recursive: true })
        writeFileSync(join(target, file.name), file.content)
      }
    }), source)
    await run(Effect.gen(function*() {
      const jar = yield* Ref.make(Cookies.empty)
      const api = yield* HttpApiClient.make(Api, { transformClient: HttpClient.withCookiesRef(jar) })
      yield* api.curatorAccess.unlock({ payload: { passphrase } })
      // At startup, as the app does.
      yield* (yield* Snapshots).tend
      const listed = yield* api.snapshots.list()
      expect(listed.snapshots.map((each) => each.kind)).toEqual(["daily"])
      expect((yield* api.profiles.list()).map((each) => each.name)).toEqual(["Asha"])
    }), target)
  })

  test("a restore refuses a file that is not this app's database, or lacks its tables", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      const folder = yield* folderOf
      const db = yield* Db
      // Recorded as ok, as an earlier version adopted files by name alone.
      const record = (name: string) =>
        Effect.gen(function*() {
          const id = crypto.randomUUID()
          yield* db.insert(snapshots).values({
            id,
            kind: "manual",
            file: name,
            takenAt: Start - 60_000,
            day: "2026-11-02",
            size: statSync(join(folder, name)).size,
            sha256: null,
            status: "ok"
          })
          return id
        })
      const foreign = snapshotFileName("manual", Start - 60_000, "00000001")
      const hollow = snapshotFileName("manual", Start - 60_000, "00000002")
      yield* Effect.sync(() => {
        const other = new Database(join(folder, foreign))
        other.run("CREATE TABLE recipes (id INTEGER PRIMARY KEY, name TEXT)")
        other.close()
        // This app's migration log, and none of its tables.
        const empty = new Database(join(folder, hollow))
        empty.run("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)")
        const insert = empty.prepare("INSERT INTO __drizzle_migrations (hash, name) VALUES ('x', ?)")
        for (const migration of bundledMigrations) insert.run(migration.name)
        empty.close()
      })
      const asha = yield* learner("Asha")
      yield* writeNote(asha, "Kept.")
      expect(yield* restore(curator, yield* record(foreign)).pipe(Effect.flip)).toMatchObject({ _tag: "SnapshotUnusable", reason: "foreign" })
      const lacking = yield* restore(curator, yield* record(hollow)).pipe(Effect.flip)
      expect(lacking).toMatchObject({ _tag: "SnapshotUnusable", reason: "damaged" })
      expect((lacking as { readonly detail: string }).detail).toStartWith("It lacks tables this version keeps")
      expect(yield* liveNotes).toEqual(["Kept."])
      expect(readdirSync(folder).filter((name) => name.startsWith("restore-") || name.startsWith("pre-restore-"))).toEqual([])
    })))
})

describe("Taking snapshots", () => {
  test("a snapshot is copied under a temporary name, and takes its own once it is checked and recorded", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      const folder = yield* folderOf
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      yield* (yield* CopierFaults).onCopy(/manual-.*\.sqlite\.part$/, Effect.sync(() => readdirSync(folder)).pipe(Effect.flatMap((names) => Ref.set(seen, names))))
      const taken = (yield* curator.api.snapshots.take()).snapshots[0]!
      // While it was copied, nothing had a snapshot's name.
      expect(yield* Ref.get(seen)).toEqual([])
      const name = (yield* fileOf(taken.id)).split("/").at(-1)!
      expect(readdirSync(folder)).toEqual([name])
    })))

  test("a failure shows until a later snapshot succeeds, even after retention deletes that one; a daily one needs a daily snapshot", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      const service = yield* Snapshots
      const faults = yield* CopierFaults
      const kinds = Effect.map(curator.api.snapshots.list(), (listed) => listed.failures.map((failure) => failure.kind))
      yield* faults.failNext("some failure")
      yield* curator.api.snapshots.take().pipe(Effect.flip)
      expect(yield* kinds).toEqual(["manual"])
      // A later snapshot of another kind clears it: what stops one stops all.
      yield* TestClock.adjust("1 minute")
      yield* service.take("pre-deletion")
      expect(yield* kinds).toEqual([])
      yield* faults.failNext("some failure")
      yield* TestClock.adjust("1 minute")
      yield* curator.api.snapshots.take().pipe(Effect.flip)
      yield* TestClock.adjust("1 minute")
      yield* curator.api.snapshots.take()
      // Ten snapshots before other changes push the manual one out; its
      // failure stays settled.
      for (let index = 0; index < 10; index++) {
        yield* TestClock.adjust("1 minute")
        yield* service.take("pre-deletion")
      }
      expect((yield* curator.api.snapshots.list()).snapshots.some((each) => each.kind === "manual")).toBe(false)
      expect(yield* kinds).toEqual([])
      // The daily snapshot is tried each hour until it succeeds.
      yield* faults.failNext("database or disk is full")
      yield* service.tend
      expect(yield* kinds).toEqual(["daily"])
      yield* TestClock.adjust("1 minute")
      yield* curator.api.snapshots.take()
      expect(yield* kinds).toEqual(["daily"])
      yield* TestClock.adjust("1 hour")
      yield* service.tend
      expect(yield* kinds).toEqual([])
    })))

  test("a snapshot file that cannot be deleted fails no later snapshot or deletion, and the others are still deleted", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      const asha = yield* learner("Asha")
      const first = (yield* curator.api.snapshots.take()).snapshots[0]!
      // Its file replaced by a folder, which deleting a file cannot remove,
      // as on Windows a file another program holds open.
      const stuck = yield* fileOf(first.id)
      yield* Effect.sync(() => {
        rmSync(stuck)
        mkdirSync(stuck)
        writeFileSync(join(stuck, "inside"), "x")
      })
      const client = yield* HttpClient.HttpClient
      for (let index = 0; index < 11; index++) {
        yield* TestClock.adjust("1 minute")
        const response = yield* client.execute(
          HttpClientRequest.post("/api/curator/snapshots").pipe(HttpClientRequest.setHeader("cookie", curator.cookie))
        )
        expect(response.status).toBe(200)
      }
      yield* asha.sessionData.remove({ payload: {} })
      const db = yield* Db
      expect((yield* db.select().from(profiles)).length).toBe(0)
      const rows = yield* db.select().from(snapshots)
      expect(rows.find((row) => row.id === first.id)!.status).toBe("ok")
      // The other eleven past the ten kept were deleted, files and all.
      const removed = rows.filter((row) => row.status === "removed")
      expect(removed).toHaveLength(2)
      for (const row of removed) expect(existsSync(join(yield* folderOf, row.file!))).toBe(false)
      expect(rows.filter((row) => row.status === "ok")).toHaveLength(11)
    })))
})

describe("The integrity check", () => {
  test("a check that could not run says so, is not taken for damage, and runs again within the hour", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      const service = yield* Snapshots
      yield* (yield* CopierFaults).failNextCheck("spawn bun ENOENT")
      yield* service.tend
      expect((yield* curator.api.snapshots.list()).integrity).toMatchObject({ outcome: "not-run", detail: "spawn bun ENOENT", at: Start })
      yield* TestClock.adjust("1 hour")
      yield* service.tend
      expect((yield* curator.api.snapshots.list()).integrity).toMatchObject({ outcome: "ok", at: Start + 3_600_000 })
    })))
})

describe("A full disk during a restore", () => {
  test("is the disk-full message while the tables are swapped, and leaves the data and the folder as they were", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      const asha = yield* learner("Asha")
      const folder = yield* folderOf
      const { dataDir } = yield* AppConfig
      // A snapshot larger than the live database: one kept by hand.
      const big = join(dataDir, "big.sqlite")
      yield* copyOfLive(big)
      yield* Effect.sync(() => {
        const file = new Database(big)
        const insert = file.prepare("INSERT INTO daily_notes (id, profile_id, day, note, written_at) VALUES (?, (SELECT id FROM profiles LIMIT 1), ?, ?, 0)")
        for (let index = 0; index < 400; index++) insert.run(`n${index}`, `2026-01-${index}`, "x".repeat(4000))
        file.close()
        copyFileSync(big, join(folder, snapshotFileName("manual", Start - 60_000)))
      })
      yield* writeNote(asha, "Live.")
      yield* (yield* Snapshots).tend
      const found = (yield* curator.api.snapshots.list()).snapshots.find((each) => each.found)!
      // The live database may not grow, as when the disk is full.
      const sql = yield* SqlClient.SqlClient
      const [pages] = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`
      yield* sql.unsafe(`PRAGMA max_page_count = ${pages!.page_count + 8}`)
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(
        HttpClientRequest.post(`/api/curator/snapshots/${found.id}/restore`).pipe(
          HttpClientRequest.setHeader("cookie", curator.cookie),
          HttpClientRequest.bodyJsonUnsafe({ passphrase })
        )
      )
      const body = yield* response.text
      yield* sql.unsafe("PRAGMA max_page_count = 1073741823")
      expect(response.status).toBe(503)
      expect(JSON.parse(body)).toMatchObject({ _tag: "SnapshotFailed", diskFull: true, detail: "The disk is full. Free some space, then restore again." })
      expect(yield* liveNotes).toEqual(["Live."])
      expect(readdirSync(folder).filter((name) => name.startsWith("restore-") || name.startsWith("pre-restore-"))).toEqual([])
      expect((yield* curator.api.snapshots.list()).snapshots.some((each) => each.kind === "pre-restore")).toBe(false)
      // With room again, it goes through.
      yield* restore(curator, found.id)
      expect((yield* liveNotes).length).toBe(400)
    })), 30_000)
})

describe("The install's archive", () => {
  test("two archives made in the same second both go through, and the latest is kept", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      yield* learner("Asha")
      const { dataDir } = yield* AppConfig
      const first = yield* curator.api.curatorData.exportInstall()
      const second = yield* curator.api.curatorData.exportInstall()
      expect(second.name).not.toBe(first.name)
      expect(readdirSync(join(dataDir, "exports"))).toEqual([second.name])
      expect((yield* curator.api.curatorData.installExport())?.name).toBe(second.name)
    })))

  test("an archive is offered only once it is whole", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      const { dataDir } = yield* AppConfig
      // A Book large enough that writing the archive takes a moment.
      const book = "c".repeat(64)
      yield* Effect.sync(() => {
        mkdirSync(join(dataDir, "books"), { recursive: true })
        const path = join(dataDir, "books", `${book}.pdf`)
        writeFileSync(path, "%PDF-1.4 ")
        truncateSync(path, 160 * 1024 * 1024)
      })
      const making = yield* Effect.forkChild(curator.api.curatorData.exportInstall())
      let offered: ReadonlyArray<string> = []
      let sawPart = false
      while (making.pollUnsafe() === undefined) {
        yield* Effect.promise(() => Bun.sleep(1))
        const latest = yield* curator.api.curatorData.installExport()
        if (latest !== null) offered = [...offered, latest.name]
        sawPart ||= readdirSync(join(dataDir, "exports")).some((name) => name.endsWith(".tar.part"))
      }
      const made = yield* Fiber.join(making)
      expect(sawPart).toBe(true)
      expect(offered.filter((name) => name !== made.name)).toEqual([])
      const latest = (yield* curator.api.curatorData.installExport())!
      expect(latest).toMatchObject({ name: made.name, size: made.size })
      expect(latest.size).toBeGreaterThan(160 * 1024 * 1024)
    })), 60_000)
})

// An untimed set of the given choice, each answer B.
const practise = (tab: Tab, choice: Parameters<Tab["practice"]["start"]>[0]["payload"]["choice"]) =>
  Effect.gen(function*() {
    let view: PracticeView = yield* tab.practice.start({ payload: { choice } })
    const served: Array<string> = []
    while (view.current !== null && view.status === "active") {
      const current = view.current
      served.push(current.question.id)
      view = yield* tab.practice.answer({
        params: { id: view.id },
        payload: { seq: view.nextSeq, questionId: current.question.id, selection: [{ part: 0, choice: "B" }], guessed: false }
      })
      view = current.position + 1 >= view.total
        ? yield* tab.practice.finish({ params: { id: view.id } })
        : yield* tab.practice.next({ params: { id: view.id }, payload: { position: current.position + 1 } })
    }
    return served
  })

const snapshotRows = Effect.gen(function*() {
  return (yield* (yield* Db).select({ kind: snapshots.kind, status: snapshots.status }).from(snapshots))
})

describe("Snapshots before a re-score", () => {
  test("a Key Override that is refused takes no snapshot", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Algebra", numbered(3, { seed: 0 }))
      const curator = yield* curatorBrowser
      const asha = yield* learner("Asha")
      const [questionId] = yield* practise(asha, { kind: "filters", status: "unseen", size: 1 })
      yield* asha.tutor.report({ params: { id: questionId! as never }, payload: { text: "The key should be B." } })
      const item = (yield* curator.api.review.list()).find((each) => each.question?.id === questionId)!
      const refused = yield* curator.api.review.overrideKey({ params: { id: item.id }, payload: { key: "H", reason: "Typo." } })
        .pipe(Effect.flip)
      expect(refused._tag).toBe("KeyNotAnOption")
      expect(yield* snapshotRows).toEqual([])
      yield* curator.api.review.overrideKey({ params: { id: item.id }, payload: { key: "B", reason: "The errata say B." } })
      expect(yield* snapshotRows).toEqual([{ kind: "pre-rescore", status: "ok" }])
    })))

  test("merging an answered Question into one with another key takes a snapshot first; an unanswered one does not", () =>
    run(Effect.gen(function*() {
      const book = yield* seedBook("Algebra", [
        ...numbered(1, { key: "B" }),
        ...numbered(1, { key: "C" }, 2),
        ...numbered(1, { key: "D" }, 3),
        ...numbered(1, { key: "E" }, 4)
      ])
      const curator = yield* curatorBrowser
      const asha = yield* learner("Asha")
      const answered = book.ids.get(1)!
      const unanswered = book.ids.get(3)!
      const served = yield* practise(asha, { kind: "book", bookId: book.bookId as never, set: "Problem Solving", from: 1, to: 1 })
      expect(served).toEqual([answered])
      const db = yield* Db
      // Held as a near match of another, as dedupe holds one.
      const nearMatch = (questionId: string, into: string) =>
        Effect.gen(function*() {
          yield* db.update(questions).set({ status: "held" }).where(eq(questions.id, questionId))
          const id = crypto.randomUUID()
          yield* db.insert(reviewItems).values({
            id,
            questionId,
            reasons: JSON.stringify([{ code: "near-match", detail: "It nearly matches another Question." }]),
            relatedQuestionId: into,
            status: "open",
            createdAt: Start
          })
          return id
        })
      yield* curator.api.review.merge({ params: { id: (yield* nearMatch(unanswered, book.ids.get(2)!)) as never } })
      expect(yield* snapshotRows).toEqual([])
      yield* curator.api.review.merge({ params: { id: (yield* nearMatch(answered, book.ids.get(4)!)) as never } })
      expect(yield* snapshotRows).toEqual([{ kind: "pre-rescore", status: "ok" }])
    })))

  test("a Book Map fixed after its Questions were answered takes a snapshot before the Book is extracted again", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        const full = rangesOf(proposed)
        const withoutKey = full.filter((range) => !(range.role === "answer-key" && range.group === "ps"))
        yield* confirmAndExtract(curator, proposed.book.id, withoutKey)
        const sixth = byNumber(yield* curator.api.review.list(), 6)
        expect(sixth.question?.key).toBe("D")
        yield* curator.api.review.publish({ params: { id: sixth.id } })
        // A map fixed before anyone answered takes none: nothing is judged again.
        yield* confirmAndExtract(curator, proposed.book.id, withoutKey)
        expect(yield* snapshotRows).toEqual([])
        yield* curator.api.bank.releaseReserve({ payload: { section: "quant", count: 100 } })
        const asha = yield* learner("Asha")
        const set = full.find((range) => range.role === "questions" && range.group === "ps")!.set
        expect(yield* practise(asha, { kind: "book", bookId: proposed.book.id, set, from: 6, to: 6 })).toEqual([sixth.question!.id])
        // The fixed map brings the Book's key, C, which judges Asha's answer again.
        yield* confirmAndExtract(curator, proposed.book.id, full)
        const db = yield* Db
        const [part] = yield* db.select({ key: parts.key }).from(parts).where(eq(parts.questionId, sixth.question!.id))
        expect(part?.key).toBe("C")
        const [taken] = yield* db.select().from(snapshots)
        expect(taken).toMatchObject({ kind: "pre-rescore", status: "ok" })
        // The snapshot holds the key as it was before.
        const copy = new Database(yield* fileOf(taken!.id), { readonly: true })
        const before = copy.query("SELECT key FROM parts WHERE question_id = ?").get(sixth.question!.id) as { readonly key: string }
        copy.close()
        expect(before.key).toBe("D")
      }),
      AllJobKinds
    ), 120_000)
})

describe("Starting the app", () => {
  const open = (dataDir: string) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        return (yield* sql<{ readonly name: string }>`SELECT name FROM profiles ORDER BY name`).map((row) => row.name)
      }).pipe(Effect.provide(makeDatabaseLive(bundledMigrations).pipe(Layer.provide(AppConfig.layer({ dataDir, preferredPort: 0 })))))
    )

  test("a start whose snapshot before an update cannot be written changes nothing, leaves no file, and says why", async () => {
    const dataDir = tempDataDir()
    const file = join(dataDir, "gmat-prep.sqlite")
    migrateDatabase(file, bundledMigrations.slice(0, -1), Start)
    // Where the snapshots folder goes, a file, so nothing can be written there.
    writeFileSync(join(dataDir, "snapshots"), "not a folder")
    const failure = await open(dataDir).then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({ _tag: "SnapshotBeforeUpdateFailed", diskFull: false })
    expect(explainStartupFailure(failure)).toStartWith("The snapshot taken before updating the database could not be written, so nothing was changed")
    expect(readdirSync(dataDir).filter((name) => !name.startsWith("gmat-prep.sqlite")).toSorted()).toEqual(["snapshots"])
    const db = new Database(file, { readonly: true })
    const applied = (db.query("SELECT name FROM __drizzle_migrations").values() as Array<[string]>).length
    db.close()
    expect(applied).toBe(bundledMigrations.length - 1)
    expect(explainStartupFailure(new SnapshotBeforeUpdateFailed({ detail: "database or disk is full", diskFull: true })))
      .toBe("There is not enough space on the disk for the snapshot taken before updating the database, so nothing was changed. Free some space, then start GMAT prep again.")
  })

  test("a write-ahead log left beside a database copied into place is set aside, not replayed onto it", async () => {
    const elsewhere = tempDataDir()
    const dataDir = tempDataDir()
    // The database that stood there before, stopped with its log in place.
    const old = join(elsewhere, "gmat-prep.sqlite")
    migrateDatabase(old, bundledMigrations, Start)
    const before = new Database(old)
    before.run("PRAGMA journal_mode = WAL")
    before.run("PRAGMA wal_autocheckpoint = 0")
    before.run("INSERT INTO profiles (id, name, name_key, time_zone, created_at) VALUES ('p-old', 'Old', 'old', 'UTC', 0)")
    const file = join(dataDir, "gmat-prep.sqlite")
    copyFileSync(`${old}-wal`, `${file}-wal`)
    copyFileSync(`${old}-shm`, `${file}-shm`)
    before.close()
    // The archive's database, unpacked over it.
    const moved = join(elsewhere, "moved.sqlite")
    migrateDatabase(moved, bundledMigrations, Start)
    const archived = new Database(moved)
    archived.run("INSERT INTO profiles (id, name, name_key, time_zone, created_at) VALUES ('p-moved', 'Moved', 'moved', 'UTC', 0)")
    archived.run("VACUUM INTO ?", [join(elsewhere, "archived.sqlite")])
    archived.close()
    copyFileSync(join(elsewhere, "archived.sqlite"), file)
    expect(await open(dataDir)).toEqual(["Moved"])
    expect(readdirSync(dataDir).some((name) => name.startsWith("gmat-prep.sqlite-wal-set-aside-"))).toBe(true)
  })
})

describe("How the Data page words snapshots", () => {
  test("an empty file reads as empty, and two snapshots in one minute read apart", () => {
    expect(sizeText(0)).toBe("empty")
    expect(sizeText(1)).toBe("1 KB")
    const texts = takenTexts([
      { id: "a" as never, takenAt: Start + 5_000 },
      { id: "b" as never, takenAt: Start + 50_000 },
      { id: "c" as never, takenAt: Start + 3_600_000 }
    ])
    const text = (id: string) => texts.get(id as never)
    expect(text("a")).not.toBe(text("b"))
    expect(text("c")).toBe(dayAndTime(Start + 3_600_000))
  })

  test("a restore that waits names the Learner and what they are in", () => {
    expect(blockedText({ reason: "session-running", learner: "Asha", session: "mock", paused: false }))
      .toBe("Asha is in a Mock. Restore once it has ended.")
    expect(blockedText({ reason: "session-running", learner: "Asha", session: "timed-set", paused: true }))
      .toBe("Asha has paused a timed set. Restore once they have finished it.")
    expect(blockedText({ reason: "job-running", learner: null, session: null, paused: false }))
      .toBe("A job is running or waiting to run. Pause it on the Jobs page, or let it finish, then restore.")
  })
})
