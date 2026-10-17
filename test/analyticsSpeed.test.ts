import { describe, expect, test } from "bun:test"
import { Effect, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { Api } from "../src/api/Api.ts"
import { Db } from "../src/server/db/Database.ts"
import { difficulty, mistakeLabels, responses, scoreEstimates, servedQuestions, sessions } from "../src/server/db/schema.ts"
import { numbered, seedBook } from "./fixtures/bank.ts"
import { runWithWorkers, tempDataDir, type WorkerTestServices } from "./harness.ts"

// The speed target (docs/design.md, "Speed targets", decision 80): each
// analytics view within 300 ms with 50,000 Responses, read right after a
// write. It seeds for about a minute, so it runs only when asked:
//
//   PERF=1 bun test test/analyticsSpeed.test.ts
//
// PERF_LIMIT_MS sets the limit for a slower machine than the install's.

const Start = Date.UTC(2026, 9, 1, 12)
const run = <A, E>(effect: Effect.Effect<A, E, WorkerTestServices>) => runWithWorkers(effect, undefined, tempDataDir(), Start)

const Sessions = 2500
const PerSession = 20
const HourMs = 60 * 60 * 1000

const Limit = Number(process.env["PERF_LIMIT_MS"] ?? 300)

describe("Analytics speed", () => {
  test.skipIf(process.env["PERF"] !== "1")("each view answers within the limit with 50,000 Responses, after a write too", () =>
    run(Effect.gen(function*() {
      const t0 = performance.now()
      const quant = yield* seedBook("Quant Bank", numbered(1000, { seed: 0 }))
      const verbal = yield* seedBook("Verbal Bank", numbered(1000, { questionType: "verbal.cr-weaken", primarySkill: "verbal.arguments.causal", seed: 0 }))
      const di = yield* seedBook("DI Bank", numbered(1000, { questionType: "di.ds", primarySkill: "quant.algebra.linear-equations", secondarySkills: ["di.sufficiency.value"], seed: 0 }))
      const ids = [...quant.ids.values(), ...verbal.ids.values(), ...di.ids.values()]
      console.log(`bank seeded in ${Math.round(performance.now() - t0)} ms`)
      const jar = yield* Ref.make(Cookies.empty)
      const tab = yield* HttpApiClient.make(Api, {
        transformClient: (client) =>
          client.pipe(HttpClient.withCookiesRef(jar), HttpClient.mapRequest(HttpClientRequest.setHeader("x-gp-device", "tab-1")))
      })
      yield* tab.profiles.create({ payload: { name: "Asha", timeZone: "America/New_York" } })
      const profileId = (yield* tab.session.me()).id
      const db = yield* Db
      const t1 = performance.now()
      const sessionRows: Array<typeof sessions.$inferInsert> = []
      const servedRows: Array<typeof servedQuestions.$inferInsert> = []
      const responseRows: Array<typeof responses.$inferInsert> = []
      const estimateRows: Array<typeof scoreEstimates.$inferInsert> = []
      const labels = ["A", "B", "C", "D", "E"]
      let n = 0
      for (let s = 0; s < Sessions; s++) {
        const id = crypto.randomUUID()
        const at = Start - (Sessions - s) * HourMs
        // Each set keeps to one Section, as a filtered set would.
        const section = s % 3
        sessionRows.push({
          id,
          profileId,
          kind: "practice",
          timed: true,
          config: "{}",
          status: "finished",
          timeLimitMs: PerSession * 129_000,
          elapsedMs: PerSession * 100_000,
          endedBy: "finished",
          createdAt: at,
          finishedAt: at + PerSession * 100_000
        })
        for (let p = 0; p < PerSession; p++) {
          const questionId = ids[section * 1000 + ((Math.floor(s / 3) * PerSession + p) % 1000)]!
          const spent = 40_000 + ((n * 7919) % 160_000)
          servedRows.push({ sessionId: id, position: p, questionId, servedAt: at + p * 100_000, servedElapsedMs: p * 100_000 })
          responseRows.push({
            id: crypto.randomUUID(),
            profileId,
            sessionId: id,
            questionId,
            seq: p + 1,
            selection: JSON.stringify([{ part: 0, choice: labels[(n * 31) % 5] }]),
            timeSpentMs: spent,
            guessed: false,
            kind: "first",
            supersedes: null,
            createdAt: at + p * 100_000 + spent
          })
          n++
        }
        estimateRows.push({
          id: crypto.randomUUID(),
          profileId,
          section: ["quant", "verbal", "di"][section]!,
          at: at + PerSession * 100_000,
          ability: Math.sin(s / 50),
          standardError: 0.3,
          score: 75,
          low: 72,
          high: 78,
          calibrated: false,
          ratedResponses: s
        })
      }
      const chunked = <A>(rows: ReadonlyArray<A>, size: number, write: (chunk: Array<A>) => Effect.Effect<unknown, unknown>) =>
        Effect.gen(function*() {
          for (let i = 0; i < rows.length; i += size) yield* write(rows.slice(i, i + size)).pipe(Effect.orDie)
        })
      yield* chunked(sessionRows, 500, (chunk) => db.insert(sessions).values(chunk))
      yield* chunked(servedRows, 1000, (chunk) => db.insert(servedQuestions).values(chunk))
      yield* chunked(responseRows, 1000, (chunk) => db.insert(responses).values(chunk))
      yield* chunked(estimateRows, 1000, (chunk) => db.insert(scoreEstimates).values(chunk))
      yield* chunked(ids.map((questionId, i) => ({ questionId, value: ((i % 7) - 3) / 3, ratedResponses: 1 })), 1000, (chunk) => db.insert(difficulty).values(chunk))
      console.log(`history seeded in ${Math.round(performance.now() - t1)} ms: ${responseRows.length} Responses`)

      const time = <A, E>(name: string, effect: Effect.Effect<A, E>) =>
        Effect.gen(function*() {
          const began = performance.now()
          const result = yield* effect
          const ms = Math.round(performance.now() - began)
          console.log(`${name}: ${ms} ms`)
          return { result, ms }
        })
      const views = [
        ["weak areas", tab.analytics.weakAreas()],
        ["skill map", tab.analytics.skillMap()],
        ["timing", tab.analytics.timing()],
        ["mistakes", tab.analytics.mistakes()],
        ["study", tab.analytics.study()],
        ["score trend", tab.scores.trend()]
      ] as const
      const measured: Record<string, Array<number>> = {}
      for (const round of ["cold", "warm", "warm again"]) {
        console.log(`-- ${round}`)
        for (const [name, effect] of views) (measured[name] ??= []).push((yield* time(name, effect as Effect.Effect<unknown, unknown>)).ms)
      }
      // After a write: each view right after a label is written, as a Learner would after labelling a miss.
      const [someResponse] = responseRows
      console.log("-- after a write, each view")
      for (const [name, effect] of views) {
        yield* db.insert(mistakeLabels).values({
          id: crypto.randomUUID(),
          profileId,
          responseId: someResponse!.id!,
          part: 0,
          mistakeType: "misread",
          createdAt: Start
        }).pipe(Effect.orDie)
        ;(measured[name] ??= []).push((yield* time(`${name} after a write`, effect as Effect.Effect<unknown, unknown>)).ms)
      }
      const weak = (yield* tab.analytics.weakAreas())
      console.log(JSON.stringify(measured))
      expect(weak.ratedResponses).toBeGreaterThan(0)
      // Every read but the first, which waits for the app's read-ahead.
      for (const [name, times] of Object.entries(measured)) {
        for (const ms of times.slice(1)) expect({ name, ms }).toEqual({ name, ms: Math.min(ms, Limit) })
      }
    })), 600_000)
})
