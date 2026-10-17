import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Api } from "../src/api/Api.ts"
import { AppConfig } from "../src/server/AppConfig.ts"
import { Db } from "../src/server/db/Database.ts"
import { bundledMigrations } from "../src/server/db/migrations/index.gen.ts"
import { dailyNotes, jobs, profiles, snapshots } from "../src/server/db/schema.ts"
import { hashFile, migrateDatabase } from "../src/server/snapshots/files.ts"
import { snapshotFileName } from "../src/server/snapshots/names.ts"
import { Snapshots } from "../src/server/snapshots/Snapshots.ts"
import { curatorBrowser, passphrase } from "./bookFlow.ts"
import { CopierFaults, runWithWorkers, tempDataDir } from "./harness.ts"

// Snapshots of the database and restoring one (decisions 109 to 112).

// Noon UTC on Monday 2 November 2026.
const Start = Date.UTC(2026, 10, 2, 12)
const run = <A, E>(effect: Parameters<typeof runWithWorkers<A, E>>[0]) => runWithWorkers(effect, undefined, tempDataDir(), Start)

// The snapshots folder, made if no snapshot has made it yet.
const folderOf = Effect.gen(function*() {
  const folder = join((yield* AppConfig).dataDir, "snapshots")
  mkdirSync(folder, { recursive: true })
  return folder
})

const learner = (name: string) =>
  Effect.gen(function*() {
    const jar = yield* Ref.make(Cookies.empty)
    const tab = yield* HttpApiClient.make(Api, {
      transformClient: (client) =>
        client.pipe(HttpClient.withCookiesRef(jar), HttpClient.mapRequest(HttpClientRequest.setHeader("x-gp-device", `tab-${name}`)))
    })
    const profile = yield* tab.profiles.create({ payload: { name, timeZone: "UTC" } })
    return Object.assign(tab, { profileId: profile.id })
  })

describe("Taking snapshots", () => {
  test("a snapshot is a consistent copy, recorded with its size and checksum, and listed", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      yield* learner("Asha")
      const listed = yield* curator.api.snapshots.take()
      expect(listed.snapshots.map((each) => each.kind)).toEqual(["manual"])
      const db = yield* Db
      const [row] = yield* db.select().from(snapshots)
      const file = join(yield* folderOf, row!.file!)
      expect(row).toMatchObject({ kind: "manual", status: "ok", day: "2026-11-02" })
      expect(row!.size).toBeGreaterThan(0)
      expect(yield* Effect.promise(() => hashFile(file))).toBe(row!.sha256!)
      // The copy holds the Profile, and is a database of its own.
      const copy = new Database(file, { readonly: true })
      expect((copy.query("SELECT name FROM profiles").values() as Array<[string]>).map((each) => each[0])).toEqual(["Asha"])
      copy.close()
    })))

  test("the day's snapshot is taken once a day, and the integrity check once a week", () =>
    run(Effect.gen(function*() {
      const snapshotsService = yield* Snapshots
      yield* snapshotsService.tend
      yield* snapshotsService.tend
      const db = yield* Db
      expect((yield* db.select().from(snapshots)).map((row) => [row.kind, row.day])).toEqual([["daily", "2026-11-02"]])
      const first = (yield* snapshotsService.list).integrity!
      expect(first).toMatchObject({ outcome: "ok", detail: "ok", at: Start, afterRestore: false })
      yield* TestClock.adjust("1 day")
      yield* snapshotsService.tend
      expect((yield* db.select().from(snapshots)).map((row) => row.day).toSorted()).toEqual(["2026-11-02", "2026-11-03"])
      expect((yield* snapshotsService.list).integrity!.at).toBe(Start)
      yield* TestClock.adjust("7 days")
      yield* snapshotsService.tend
      expect((yield* snapshotsService.list).integrity!.at).toBe(Start + 8 * 86_400_000)
    })))

  test("old snapshots are deleted by the retention rule: 7 daily, 4 weekly", () =>
    run(Effect.gen(function*() {
      const snapshotsService = yield* Snapshots
      for (let day = 0; day < 40; day += 1) {
        yield* snapshotsService.tend
        yield* TestClock.adjust("1 day")
      }
      const db = yield* Db
      const rows = yield* db.select().from(snapshots)
      const kept = rows.filter((row) => row.status === "ok")
      expect(kept.length).toBe(11)
      expect(rows.filter((row) => row.status === "removed").length).toBe(29)
      const files = readdirSync(yield* folderOf).filter((name) => name.endsWith(".sqlite"))
      expect(files.toSorted()).toEqual(kept.map((row) => row.file!).toSorted())
    })), 60_000)

  test("a snapshot file found without a record, such as one taken before a migration, is recorded", () =>
    run(Effect.gen(function*() {
      const folder = yield* folderOf
      const { dataDir } = yield* AppConfig
      const name = snapshotFileName("pre-migration", Start - 3_600_000)
      yield* Effect.sync(() => {
        const live = new Database(join(dataDir, "gmat-prep.sqlite"), { readonly: true })
        live.run("VACUUM INTO ?", [join(folder, name)])
        live.close()
        writeFileSync(join(folder, "notes.txt"), "not a snapshot")
      })
      yield* (yield* Snapshots).tend
      const listed = yield* (yield* Snapshots).list
      expect(listed.snapshots.map((each) => [each.kind, each.takenAt])).toEqual([["daily", Start], ["pre-migration", Start - 3_600_000]])
    })))

  test("a snapshot that fails is recorded and reported until one of its kind succeeds", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      yield* (yield* CopierFaults).failNext("database or disk is full")
      const refused = yield* curator.api.snapshots.take().pipe(Effect.flip)
      expect(refused).toMatchObject({ _tag: "SnapshotFailed", diskFull: true })
      const listed = yield* curator.api.snapshots.list()
      expect(listed.snapshots).toEqual([])
      expect(listed.failures.map((each) => [each.kind, each.error])).toEqual([
        ["manual", "The disk is full. Free some space, and the next snapshot will be taken."]
      ])
      expect(readdirSync(yield* folderOf).filter((name) => name.endsWith(".sqlite"))).toEqual([])
      yield* TestClock.adjust("1 minute")
      yield* curator.api.snapshots.take()
      expect((yield* curator.api.snapshots.list()).failures).toEqual([])
    })))
})

describe("Restoring a snapshot", () => {
  test("puts the database back as it was, keeps the one it replaced, and keeps the Curator signed in", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      const asha = yield* learner("Asha")
      yield* asha.plan.writeNote({ params: { day: "2026-11-02" }, payload: { note: "Before." } })
      const before = (yield* curator.api.snapshots.take()).snapshots[0]!
      yield* TestClock.adjust("1 minute")
      yield* asha.plan.writeNote({ params: { day: "2026-11-02" }, payload: { note: "After." } })
      const ben = yield* learner("Ben")
      const done = yield* curator.api.snapshots.restore({ params: { id: before.id }, payload: { passphrase } })
      expect(done.restored.id).toBe(before.id)
      expect(done.replaced.kind).toBe("pre-restore")
      const db = yield* Db
      expect((yield* db.select({ name: profiles.name }).from(profiles)).map((row) => row.name)).toEqual(["Asha"])
      expect((yield* db.select({ note: dailyNotes.note }).from(dailyNotes)).map((row) => row.note)).toEqual(["Before."])
      // Asha's tab still works; Ben, not in the snapshot, is signed out.
      expect((yield* asha.session.me()).name).toBe("Asha")
      expect((yield* ben.session.me().pipe(Effect.flip))._tag).toBe("NotUnlocked")
      // The Curator is still signed in, and both snapshots are listed.
      const listed = yield* curator.api.snapshots.list()
      expect(listed.snapshots.map((each) => each.kind)).toEqual(["pre-restore", "manual"])
      // The replaced database is the pre-restore snapshot: it holds Ben.
      const [kept] = yield* db.select().from(snapshots).where(eq(snapshots.id, done.replaced.id))
      const copy = new Database(join(yield* folderOf, kept!.file!), { readonly: true })
      expect((copy.query("SELECT name FROM profiles ORDER BY name").values() as Array<[string]>).map((each) => each[0])).toEqual(["Asha", "Ben"])
      copy.close()
      expect(readdirSync(yield* folderOf).some((name) => name.startsWith("restore-"))).toBe(false)
    })))

  test("runs the full check right after, as a restore cannot repair damage in the file itself", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      const first = (yield* curator.api.snapshots.take()).snapshots[0]!
      yield* TestClock.adjust("1 minute")
      yield* (yield* Snapshots).tend
      expect((yield* curator.api.snapshots.list()).integrity).toMatchObject({ outcome: "ok", afterRestore: false, at: Start + 60_000 })
      yield* TestClock.adjust("1 minute")
      yield* curator.api.snapshots.restore({ params: { id: first.id }, payload: { passphrase } })
      expect((yield* curator.api.snapshots.list()).integrity).toMatchObject({ outcome: "ok", afterRestore: true, at: Start + 120_000 })
    })))

  test("brings an older snapshot to this version's tables first", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      yield* learner("Asha")
      const folder = yield* folderOf
      // A database from before the last migrations, with a Profile in it.
      const name = snapshotFileName("pre-migration", Start - 86_400_000)
      yield* Effect.sync(() => {
        const file = join(folder, name)
        migrateDatabase(file, bundledMigrations.slice(0, -2), Start)
        const old = new Database(file)
        old.run("INSERT INTO profiles (id, name, name_key, time_zone, created_at) VALUES ('p-old', 'Old', 'old', 'UTC', 0)")
        old.close()
      })
      yield* (yield* Snapshots).tend
      const found = (yield* curator.api.snapshots.list()).snapshots.find((each) => each.kind === "pre-migration")!
      yield* curator.api.snapshots.restore({ params: { id: found.id }, payload: { passphrase } })
      const db = yield* Db
      expect((yield* db.select({ name: profiles.name }).from(profiles)).map((row) => row.name)).toEqual(["Old"])
    })))

  test("refuses a snapshot changed since it was taken, or written by a newer version", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      const first = (yield* curator.api.snapshots.take()).snapshots[0]!
      const db = yield* Db
      const folder = yield* folderOf
      const [row] = yield* db.select().from(snapshots).where(eq(snapshots.id, first.id))
      yield* Effect.sync(() => {
        const file = new Database(join(folder, row!.file!))
        file.run("INSERT INTO __drizzle_migrations (hash, name) VALUES ('x', '29990101000000_from_the_future')")
        file.close()
      })
      const changed = yield* curator.api.snapshots.restore({ params: { id: first.id }, payload: { passphrase } }).pipe(Effect.flip)
      expect(changed).toMatchObject({ _tag: "SnapshotUnusable", reason: "changed" })
      // Recorded without a checksum, as an earlier version recorded a file it found.
      yield* db.update(snapshots).set({ sha256: null }).where(eq(snapshots.id, first.id))
      const newer = yield* curator.api.snapshots.restore({ params: { id: first.id }, payload: { passphrase } }).pipe(Effect.flip)
      expect(newer).toMatchObject({ _tag: "SnapshotUnusable", reason: "newer" })
    })))

  test("waits while a job runs or a timed Session is under way", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      const first = (yield* curator.api.snapshots.take()).snapshots[0]!
      const db = yield* Db
      yield* db.insert(jobs).values({
        id: "job-1",
        kind: "connection-test",
        params: "{}",
        status: "running",
        spendCap: 1,
        revision: 1,
        createdAt: Start,
        updatedAt: Start
      })
      const busy = yield* curator.api.snapshots.restore({ params: { id: first.id }, payload: { passphrase } }).pipe(Effect.flip)
      expect(busy).toMatchObject({ _tag: "RestoreBlocked", reason: "job-running" })
      yield* db.update(jobs).set({ status: "done" }).where(eq(jobs.id, "job-1"))
      const restored = yield* curator.api.snapshots.restore({ params: { id: first.id }, payload: { passphrase } })
      expect(restored.restored.id).toBe(first.id)
      // The job the snapshot did not hold is gone with the rest.
      expect(yield* db.select().from(jobs)).toEqual([])
    })))
})

describe("Snapshots found in the folder", () => {
  test("a snapshot copied by hand into the folder is listed like any other", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      const first = (yield* curator.api.snapshots.take()).snapshots[0]!
      const db = yield* Db
      const folder = yield* folderOf
      const [row] = yield* db.select().from(snapshots).where(eq(snapshots.id, first.id))
      const name = snapshotFileName("manual", Start - 60_000)
      yield* Effect.sync(() => copyFileSync(join(folder, row!.file!), join(folder, name)))
      yield* (yield* Snapshots).tend
      const listed = yield* curator.api.snapshots.list()
      expect(listed.snapshots.length).toBe(3)
    })))
})
