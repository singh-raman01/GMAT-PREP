import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { OfficialScoreInput } from "../src/api/Scores.ts"
import { Db } from "../src/server/db/Database.ts"
import { scoreEstimates } from "../src/server/db/schema.ts"
import { scoreLinesOf } from "../src/server/ratings/OfficialScores.ts"
import { lineScore, UncalibratedLine } from "../src/server/ratings/scale.ts"
import { openBrowser, runWithWorkers, tempDataDir, type WorkerTestServices } from "./harness.ts"

// Noon UTC on 16 October 2026: already 17 October in Auckland (UTC+13).
const Noon = Date.UTC(2026, 9, 16, 12)

const score = (takenOn: string, changes: Partial<OfficialScoreInput> = {}): OfficialScoreInput => ({
  takenOn,
  kind: "practice-exam",
  total: 655,
  quant: 81,
  verbal: 84,
  di: 82,
  ...changes
})

const run = <A, E>(effect: Effect.Effect<A, E, WorkerTestServices>) => runWithWorkers(effect, undefined, tempDataDir(), Noon)

describe("Official Scores", () => {
  test("are listed latest first and can be removed, each Profile seeing only its own", () =>
    run(Effect.gen(function*() {
      const asha = yield* openBrowser
      yield* asha.profiles.create({ payload: { name: "Asha" } })
      yield* asha.scores.addOfficial({ payload: score("2026-08-01") })
      const both = yield* asha.scores.addOfficial({ payload: score("2026-10-02", { kind: "exam", total: 685, quant: 84, verbal: 87, di: 81 }) })
      expect(both.map((each) => [each.takenOn, each.kind, each.total])).toEqual([
        ["2026-10-02", "exam", 685],
        ["2026-08-01", "practice-exam", 655]
      ])

      const ben = yield* openBrowser
      yield* ben.profiles.create({ payload: { name: "Ben" } })
      expect(yield* ben.scores.official()).toEqual([])
      const notHis = yield* ben.scores.removeOfficial({ params: { id: both[0]!.id } }).pipe(Effect.flip)
      expect(notHis._tag).toBe("OfficialScoreNotFound")

      const left = yield* asha.scores.removeOfficial({ params: { id: both[0]!.id } })
      expect(left.map((each) => each.takenOn)).toEqual(["2026-08-01"])
      const again = yield* asha.scores.removeOfficial({ params: { id: both[0]!.id } }).pipe(Effect.flip)
      expect(again._tag).toBe("OfficialScoreNotFound")
    })))

  test("a day still to come in the Profile's time zone is refused", () =>
    run(Effect.gen(function*() {
      const london = yield* openBrowser
      yield* london.profiles.create({ payload: { name: "Asha", timeZone: "UTC" } })
      const tomorrow = yield* london.scores.addOfficial({ payload: score("2026-10-17") }).pipe(Effect.flip)
      expect(tomorrow._tag).toBe("OfficialScoreInFuture")
      expect(yield* london.scores.addOfficial({ payload: score("2026-10-16") })).toHaveLength(1)

      const auckland = yield* openBrowser
      yield* auckland.profiles.create({ payload: { name: "Ben", timeZone: "Pacific/Auckland" } })
      expect(yield* auckland.scores.addOfficial({ payload: score("2026-10-17") })).toHaveLength(1)
      const ahead = yield* auckland.scores.addOfficial({ payload: score("2026-10-18") }).pipe(Effect.flip)
      expect(ahead._tag).toBe("OfficialScoreInFuture")
    })))

  test("the server refuses a Total that does not end in 5, a Section score off the scale, and a date that is not one", () =>
    run(Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const created = yield* client.execute(
        HttpClientRequest.post("/api/profiles").pipe(HttpClientRequest.bodyJsonUnsafe({ name: "Asha" }))
      )
      const cookie = created.headers["set-cookie"]?.split(";")[0] ?? ""
      const statusFor = (body: unknown) =>
        client.execute(
          HttpClientRequest.post("/api/scores/official").pipe(
            HttpClientRequest.setHeader("cookie", cookie),
            HttpClientRequest.bodyJsonUnsafe(body)
          )
        ).pipe(Effect.map((response) => response.status))
      expect(yield* statusFor(score("2026-10-01"))).toBe(200)
      expect(yield* statusFor(score("2026-10-01", { total: 650 }))).toBe(400)
      expect(yield* statusFor(score("2026-10-01", { total: 815 }))).toBe(400)
      expect(yield* statusFor(score("2026-10-01", { quant: 59 }))).toBe(400)
      expect(yield* statusFor(score("2026-10-01", { di: 91 }))).toBe(400)
      expect(yield* statusFor(score("2026-02-30"))).toBe(400)
      expect(yield* statusFor(score("1 October 2026"))).toBe(400)
      expect(yield* statusFor({ ...score("2026-10-01"), kind: "mock" })).toBe(400)
    })))
})

describe("Score lines", () => {
  const estimate = (profileId: string, section: string, at: number, ability: number) => ({
    id: crypto.randomUUID(),
    profileId,
    section,
    at,
    ability,
    standardError: 0.4,
    score: 75,
    low: 71,
    high: 79,
    calibrated: false,
    ratedResponses: 10
  })

  test("pair each Official Score with the Section Ability at the end of its day, in the Profile's time zone", () =>
    run(Effect.gen(function*() {
      const db = yield* Db
      const lines = (timeZone: string, name: string) =>
        Effect.gen(function*() {
          const browser = yield* openBrowser
          const profile = yield* browser.profiles.create({ payload: { name, timeZone } })
          yield* db.insert(scoreEstimates).values([
            estimate(profile.id, "quant", Date.UTC(2026, 9, 1, 10), 0.2),
            // 23:30 on 10 October in UTC, but 11 October in Auckland.
            estimate(profile.id, "quant", Date.UTC(2026, 9, 10, 23, 30), 0.6)
          ]).pipe(Effect.orDie)
          // Taken before any Score Estimate: left out of the fit.
          yield* browser.scores.addOfficial({ payload: score("2026-09-20", { quant: 70 }) })
          yield* browser.scores.addOfficial({ payload: score("2026-10-10", { quant: 81 }) })
          return yield* scoreLinesOf(profile.id)
        })

      const utc = yield* lines("UTC", "Asha")
      expect(utc.quant).toMatchObject({ slope: 5, calibrated: true })
      expect(lineScore(utc.quant, 0.6)).toBe(81)
      expect(utc.quant.offset).toBeCloseTo(78, 10)
      // No Score Estimate yet for Verbal or Data Insights.
      expect(utc.verbal).toEqual(UncalibratedLine)
      expect(utc.di).toEqual(UncalibratedLine)

      const auckland = yield* lines("Pacific/Auckland", "Ben")
      expect(lineScore(auckland.quant, 0.2)).toBe(81)
      expect(auckland.quant.offset).toBeCloseTo(80, 10)
    })))

  test("are uncalibrated with no Official Scores", () =>
    run(Effect.gen(function*() {
      const browser = yield* openBrowser
      const profile = yield* browser.profiles.create({ payload: { name: "Asha" } })
      const db = yield* Db
      yield* db.insert(scoreEstimates).values(estimate(profile.id, "verbal", Date.UTC(2026, 9, 1), 0.3)).pipe(Effect.orDie)
      expect(yield* scoreLinesOf(profile.id)).toEqual({ quant: UncalibratedLine, verbal: UncalibratedLine, di: UncalibratedLine })
    })))
})
