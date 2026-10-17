import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Api } from "../src/api/Api.ts"
import { InstallExportPath } from "../src/api/Exports.ts"
import type { PracticeView } from "../src/api/Practice.ts"
import { AppConfig } from "../src/server/AppConfig.ts"
import { Db } from "../src/server/db/Database.ts"
import { bundledMigrations } from "../src/server/db/migrations/index.gen.ts"
import { dailyNotes, profiles, sessions, snapshots } from "../src/server/db/schema.ts"
import { migrateDatabase } from "../src/server/snapshots/files.ts"
import { readTar } from "../src/server/snapshots/tar.ts"
import { curatorBrowser } from "./bookFlow.ts"
import { numbered, seedBook } from "./fixtures/bank.ts"
import { CopierFaults, runWithWorkers, tempDataDir } from "./harness.ts"

// Exports, deleting a Profile, resetting a PIN, and the snapshots taken
// before a Key Override or a new Taxonomy (decisions 113 to 118).

// Noon UTC on Monday 2 November 2026.
const Start = Date.UTC(2026, 10, 2, 12)
const run = <A, E>(effect: Parameters<typeof runWithWorkers<A, E>>[0], dataDir = tempDataDir()) =>
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

// An untimed set, every answer B.
const practise = (tab: Tab, size: number) =>
  Effect.gen(function*() {
    let view: PracticeView = yield* tab.practice.start({ payload: { choice: { kind: "filters", status: "unseen", size } } })
    while (view.current !== null && view.status === "active") {
      const current = view.current
      view = yield* tab.practice.answer({
        params: { id: view.id },
        payload: { seq: view.nextSeq, questionId: current.question.id, selection: [{ part: 0, choice: "B" }], guessed: false }
      })
      view = current.position + 1 >= view.total
        ? yield* tab.practice.finish({ params: { id: view.id } })
        : yield* tab.practice.next({ params: { id: view.id }, payload: { position: current.position + 1 } })
    }
    return view
  })

describe("Deleting a Profile", () => {
  test("a Learner deletes their own with its PIN, after a snapshot, and only their rows go", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Algebra", numbered(6))
      const asha = yield* learner("Asha", "4321")
      const ben = yield* learner("Ben")
      yield* practise(asha, 2)
      yield* practise(ben, 2)
      yield* asha.plan.writeNote({ params: { day: "2026-11-02" }, payload: { note: "Mine." } })
      expect((yield* asha.sessionData.remove({ payload: {} }).pipe(Effect.flip))._tag).toBe("PinRequired")
      expect(yield* asha.sessionData.remove({ payload: { pin: "1111" } }).pipe(Effect.flip)).toMatchObject({ _tag: "WrongPin", attemptsLeft: 4 })
      yield* asha.sessionData.remove({ payload: { pin: "4321" } })
      const db = yield* Db
      expect((yield* db.select({ name: profiles.name }).from(profiles)).map((row) => row.name)).toEqual(["Ben"])
      expect((yield* db.select({ profileId: sessions.profileId }).from(sessions)).every((row) => row.profileId === ben.profileId)).toBe(true)
      expect(yield* db.select().from(dailyNotes)).toEqual([])
      expect((yield* db.select({ kind: snapshots.kind }).from(snapshots)).map((row) => row.kind)).toEqual(["pre-deletion"])
      // Asha's tab is signed out; Ben's goes on.
      expect((yield* asha.session.me().pipe(Effect.flip))._tag).toBe("NotUnlocked")
      expect((yield* ben.session.me()).name).toBe("Ben")
    })))

  test("the Curator deletes one with the passphrase entered again", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      const asha = yield* learner("Asha")
      const wrong = yield* curator.api.curatorData.removeProfile({ params: { id: asha.profileId }, payload: { passphrase: "not it at all" } })
        .pipe(Effect.flip)
      expect(wrong._tag).toBe("WrongPassphrase")
      yield* curator.api.curatorData.removeProfile({ params: { id: asha.profileId }, payload: { passphrase: "correct horse battery" } })
      expect(yield* curator.api.curatorData.profiles()).toEqual([])
    })))

  test("nothing is deleted when the snapshot before it cannot be taken", () =>
    run(Effect.gen(function*() {
      const asha = yield* learner("Asha")
      yield* (yield* CopierFaults).failNext("database or disk is full")
      const refused = yield* asha.sessionData.remove({ payload: {} }).pipe(Effect.flip)
      expect(refused).toMatchObject({ _tag: "SnapshotFailed", diskFull: true })
      expect((yield* asha.session.me()).name).toBe("Asha")
    })))
})

describe("Resetting a PIN", () => {
  test("the Curator sets a new PIN or none; locks and every unlock end", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      const asha = yield* learner("Asha", "4321")
      const other = yield* learner("Other")
      for (let attempt = 0; attempt < 5; attempt += 1) {
        yield* other.profiles.unlock({ params: { id: asha.profileId }, payload: { pin: "0000" } }).pipe(Effect.ignore)
      }
      expect((yield* curator.api.curatorData.profiles()).find((each) => each.profile.id === asha.profileId)!.lockedUntil).not.toBeNull()
      const reset = yield* curator.api.curatorData.resetPin({ params: { id: asha.profileId }, payload: { pin: "2468" } })
      expect(reset.hasPin).toBe(true)
      expect((yield* curator.api.curatorData.profiles()).find((each) => each.profile.id === asha.profileId)!.lockedUntil).toBeNull()
      // The old unlock ended; the new PIN opens it.
      expect((yield* asha.session.me().pipe(Effect.flip))._tag).toBe("NotUnlocked")
      expect((yield* other.profiles.unlock({ params: { id: asha.profileId }, payload: { pin: "4321" } }).pipe(Effect.flip))._tag).toBe("WrongPin")
      expect((yield* other.profiles.unlock({ params: { id: asha.profileId }, payload: { pin: "2468" } })).name).toBe("Asha")
      const none = yield* curator.api.curatorData.resetPin({ params: { id: asha.profileId }, payload: { pin: null } })
      expect(none.hasPin).toBe(false)
      expect((yield* other.profiles.unlock({ params: { id: asha.profileId }, payload: {} })).name).toBe("Asha")
    })))
})

describe("Exports", () => {
  test("a Profile exports every row it holds, and nothing of another's, its PIN or its unlocks", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Algebra", numbered(6))
      const asha = yield* learner("Asha", "4321")
      const ben = yield* learner("Ben")
      yield* practise(asha, 3)
      yield* practise(ben, 2)
      yield* asha.plan.saveSettings({
        payload: { testDate: null, targetTotal: null, weeklyMinutes: 600, daysOff: [0], timeZone: "UTC", rolloverHour: 4 }
      })
      const exported = yield* asha.sessionData.export()
      expect(exported.profile).toMatchObject({ name: "Asha", hasPin: true })
      expect(exported.tables["sessions"]!.length).toBe(1)
      expect(exported.tables["responses"]!.length).toBe(3)
      expect(exported.tables["served_questions"]!.length).toBe(3)
      expect(exported.tables["plan_settings"]!.length).toBe(1)
      expect(exported.tables["plan_items"]!.length).toBeGreaterThan(0)
      expect(exported.tables["profile_unlocks"]).toBeUndefined()
      const text = JSON.stringify(exported)
      expect(text).not.toContain("argon2")
      expect(text).not.toContain(ben.profileId)
    })))

  test("the install exports as one archive of the database, the Books and the figures, for the Curator to download", () =>
    run(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      yield* learner("Asha")
      const { dataDir } = yield* AppConfig
      const book = "a".repeat(64)
      const figure = "b".repeat(64)
      yield* Effect.sync(() => {
        mkdirSync(join(dataDir, "books"), { recursive: true })
        mkdirSync(join(dataDir, "figures"), { recursive: true })
        writeFileSync(join(dataDir, "books", `${book}.pdf`), "%PDF-1.4 a Book")
        writeFileSync(join(dataDir, "figures", `${figure}.png`), "a figure")
        writeFileSync(join(dataDir, "figures", `${figure}.123.part`), "half a figure")
      })
      expect(yield* curator.api.curatorData.installExport()).toBeNull()
      const made = yield* curator.api.curatorData.exportInstall()
      expect(made.size).toBeGreaterThan(0)
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(HttpClientRequest.get(InstallExportPath).pipe(HttpClientRequest.setHeader("cookie", curator.cookie)))
      expect(response.status).toBe(200)
      expect(response.headers["content-disposition"]).toBe(`attachment; filename="${made.name}"`)
      const files = readTar(new Uint8Array(yield* response.arrayBuffer))
      expect(files.map((file) => file.name)).toEqual(["gmat-prep.sqlite", `books/${book}.pdf`, `figures/${figure}.png`])
      expect(new TextDecoder().decode(files[1]!.content)).toBe("%PDF-1.4 a Book")
      // The database in it is whole, with the Profile.
      const copy = join(dataDir, "check.sqlite")
      yield* Effect.sync(() => writeFileSync(copy, files[0]!.content))
      const opened = new Database(copy, { readonly: true })
      expect((opened.query("SELECT name FROM profiles").values() as Array<[string]>).map((row) => row[0])).toEqual(["Asha"])
      opened.close()
      // Without the Curator's unlock there is no download.
      const stranger = yield* client.execute(HttpClientRequest.get(InstallExportPath))
      expect(stranger.status).toBe(401)
      // A new export replaces the last.
      yield* TestClock.adjust("1 hour")
      const again = yield* curator.api.curatorData.exportInstall()
      expect(again.name).not.toBe(made.name)
      expect((yield* curator.api.curatorData.installExport())?.name).toBe(again.name)
    })))
})

describe("Snapshots before risky changes", () => {
  test("a Key Override takes one first, and waits when it cannot", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Algebra", numbered(3, { seed: 0 }))
      const curator = yield* curatorBrowser
      const asha = yield* learner("Asha")
      const set = yield* practise(asha, 1)
      const questionId = (yield* asha.practice.review({ params: { id: set.id, position: 0 } })).question.id
      yield* asha.tutor.report({ params: { id: questionId }, payload: { text: "The key should be B." } })
      const item = (yield* curator.api.review.list()).find((each) => each.question?.id === questionId)!
      yield* (yield* CopierFaults).failNext("database or disk is full")
      const refused = yield* curator.api.review.overrideKey({ params: { id: item.id }, payload: { key: "B", reason: "The errata say B." } })
        .pipe(Effect.flip)
      expect(refused._tag).toBe("SnapshotFailed")
      yield* curator.api.review.overrideKey({ params: { id: item.id }, payload: { key: "B", reason: "The errata say B." } })
      const db = yield* Db
      const rows = yield* db.select({ kind: snapshots.kind, status: snapshots.status }).from(snapshots)
      expect(rows).toEqual([{ kind: "pre-rescore", status: "failed" }, { kind: "pre-rescore", status: "ok" }])
    })))

  test("a Taxonomy the database has not used before takes one at startup", () => {
    const dataDir = tempDataDir()
    // A database from an earlier Taxonomy.
    migrateDatabase(join(dataDir, "gmat-prep.sqlite"), bundledMigrations, Start)
    const earlier = new Database(join(dataDir, "gmat-prep.sqlite"))
    earlier.run("INSERT INTO taxonomy_versions (version, file_hash, loaded_at) VALUES (0, 'earlier', 0)")
    earlier.close()
    return run(Effect.gen(function*() {
      const db = yield* Db
      expect((yield* db.select({ kind: snapshots.kind }).from(snapshots).where(eq(snapshots.status, "ok"))).map((row) => row.kind))
        .toEqual(["pre-taxonomy"])
    }), dataDir)
  })
})
