import { describe, expect, test } from "bun:test"
import { and, eq, isNotNull } from "drizzle-orm"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { DefaultBlueprint, fitsSlot, groupCount, sectionCount } from "../src/api/blueprint.ts"
import { Db } from "../src/server/db/Database.ts"
import { questions } from "../src/server/db/schema.ts"
import { numbered, seedBook } from "./fixtures/bank.ts"
import { openBrowser, runWithApp, runWithWorkers } from "./harness.ts"

const passphrase = "correct horse battery"

const curatorBrowser = Effect.gen(function*() {
  const browser = yield* openBrowser
  yield* browser.curatorAccess.setPassphrase({ payload: { passphrase } })
  return browser
})

describe("The Section Blueprint's defaults", () => {
  test("give each Section the exam's count, with RC in passages of 3, 3, 3 and 4 and MSR as one set of 3", () => {
    expect(sectionCount(DefaultBlueprint, "quant")).toBe(21)
    expect(sectionCount(DefaultBlueprint, "verbal")).toBe(23)
    expect(sectionCount(DefaultBlueprint, "di")).toBe(20)
    expect([groupCount(DefaultBlueprint, "rc"), groupCount(DefaultBlueprint, "cr")]).toEqual([13, 10])
    expect(["ds", "msr", "ta", "gi", "tpa"].map((group) => groupCount(DefaultBlueprint, group as "ds"))).toEqual([7, 3, 3, 4, 3])
    expect(fitsSlot("verbal.rc-detail", 4)).toBe(true)
    expect(fitsSlot("verbal.rc-detail", 5)).toBe(false)
    expect(fitsSlot("di.msr", 3)).toBe(true)
    expect(fitsSlot("di.msr", 2)).toBe(false)
    expect(fitsSlot("verbal.rc-detail", 5, { ...DefaultBlueprint, rc: [5, 3] })).toBe(true)
  })
})

describe("Editing the Section Blueprint", () => {
  test("the Curator's Blueprint is kept, and the defaults stay on show", () =>
    runWithApp(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      const first = yield* curator.settings.blueprint()
      expect(first).toMatchObject({ blueprint: DefaultBlueprint, defaults: DefaultBlueprint, released: null })
      const saved = yield* curator.settings.saveBlueprint({
        payload: { blueprint: { ...DefaultBlueprint, ds: 8, gi: 3, msr: [3, 3] } }
      })
      expect(saved.blueprint).toMatchObject({ ds: 8, gi: 3, msr: [3, 3] })
      expect(saved.released).toBe(0)
      expect((yield* curator.settings.blueprint()).blueprint).toEqual(saved.blueprint)
    })))

  test("a passage held for Mocks that no slot fits after a change goes to Practice Sets", () =>
    runWithWorkers(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      const rc = { questionType: "verbal.rc-detail", primarySkill: "verbal.reading.detail", reserve: true }
      const seeded = yield* seedBook("Verbal Review", [
        ...numbered(4, { ...rc, passage: "A passage of four questions." }),
        ...numbered(3, { ...rc, passage: "A passage of three questions." }, 5)
      ])
      const saved = yield* curator.settings.saveBlueprint({ payload: { blueprint: { ...DefaultBlueprint, rc: [3, 3, 3, 3] } } })
      expect(saved.released).toBe(1)
      const db = yield* Db
      const released = yield* db.select({ id: questions.id }).from(questions)
        .where(and(eq(questions.reserve, true), isNotNull(questions.releasedAt))).pipe(Effect.orDie)
      expect(released.map((row) => row.id).toSorted()).toEqual([1, 2, 3, 4].map((n) => seeded.ids.get(n)!).toSorted())
    })))

  test("a group with no Questions, or a unit bigger than six, is refused", () =>
    runWithApp(Effect.gen(function*() {
      yield* curatorBrowser
      const client = yield* HttpClient.HttpClient
      const unlock = yield* client.execute(
        HttpClientRequest.post("/api/curator/unlock").pipe(HttpClientRequest.bodyJsonUnsafe({ passphrase }))
      )
      const cookie = unlock.headers["set-cookie"]?.split(";")[0] ?? ""
      const statusFor = (changes: Record<string, unknown>) =>
        client.execute(
          HttpClientRequest.put("/api/curator/settings/blueprint").pipe(
            HttpClientRequest.setHeader("cookie", cookie),
            HttpClientRequest.bodyJsonUnsafe({ blueprint: { ...DefaultBlueprint, ...changes } })
          )
        ).pipe(Effect.map((response) => response.status))
      expect(yield* statusFor({})).toBe(200)
      expect(yield* statusFor({ cr: 0 })).toBe(400)
      expect(yield* statusFor({ rc: [] })).toBe(400)
      expect(yield* statusFor({ rc: [3, 7] })).toBe(400)
      expect(yield* statusFor({ ps: 2.5 })).toBe(400)
    })))
})
