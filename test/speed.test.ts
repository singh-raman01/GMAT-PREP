import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, type Layer, ManagedRuntime, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Api } from "../src/api/Api.ts"
import type { PracticePart } from "../src/api/Practice.ts"
import { Db } from "../src/server/db/Database.ts"
import { mistakeLabels } from "../src/server/db/schema.ts"
import { ConnectionTest } from "../src/server/jobs/kinds/connectionTest.ts"
import { seedFullExamBank } from "./fixtures/fullExamBank.ts"
import { seedHistory, seedHistoryBank } from "./fixtures/history.ts"
import { appWithWorkersLayer, tempDataDir, type WorkerTestServices } from "./harness.ts"

// The speed targets (docs/design.md, "Speed targets", decision 127), each to
// hold 95% of the time, measured over HTTP on the real routes with one
// Profile's 50,000 Responses. Seeding takes about a minute, so they run only
// when asked:
//
//   bun run test:speed        (bun run build && PERF=1 bun test test/speed.test.ts)
//
// The start is timed on the executable `bun run build` makes, as Learners run
// it.
// PERF_SLACK multiplies every limit, for a machine slower than the install's.

const Enabled = process.env["PERF"] === "1"
const Slack = Number(process.env["PERF_SLACK"] ?? 1)
const Limits = { submitMs: 100 * Slack, startMs: 300 * Slack, analyticsMs: 300 * Slack, appStartMs: 2000 * Slack }

const Start = Date.UTC(2026, 9, 1, 12)
const HistorySessions = 2500
const PerSession = 20

// The 95th percentile, by nearest rank.
const p95 = (samples: ReadonlyArray<number>) => {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!
}

const report = (name: string, samples: ReadonlyArray<number>) => {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number) => Math.round(sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]!)
  console.log(`${name}: ${samples.length} samples, median ${at(0.5)} ms, p95 ${at(0.95)} ms, max ${at(1)} ms`)
}

const makeTab = Effect.gen(function*() {
  const jar = yield* Ref.make(Cookies.empty)
  return yield* HttpApiClient.make(Api, {
    transformClient: (client) =>
      client.pipe(HttpClient.withCookiesRef(jar), HttpClient.mapRequest(HttpClientRequest.setHeader("x-gp-device", "speed-tab")))
  })
})
type Tab = Effect.Success<typeof makeTab>

// The first option of each part: a valid answer whatever the Question.
const firstPicks = (parts: ReadonlyArray<PracticePart>) => parts.map((part) => ({ part: part.position, choice: part.options[0]!.label }))

describe.skipIf(!Enabled)("Speed targets", () => {
  let runtime: ManagedRuntime.ManagedRuntime<WorkerTestServices, never>
  let tab: Tab
  let dataDir: string
  let responseIds: ReadonlyArray<string> = []
  const run = <A, E>(effect: Effect.Effect<A, E, WorkerTestServices>) => runtime.runPromise(effect)
  const time = async <A>(effect: Effect.Effect<A, unknown, WorkerTestServices>) => {
    const began = performance.now()
    const value = await run(effect)
    return { value, ms: performance.now() - began }
  }

  beforeAll(async () => {
    dataDir = tempDataDir()
    runtime = ManagedRuntime.make(appWithWorkersLayer(dataDir, [ConnectionTest], Start) as Layer.Layer<WorkerTestServices>)
    const began = performance.now()
    tab = await run(makeTab)
    await run(tab.profiles.create({ payload: { name: "Asha", timeZone: "America/New_York" } }))
    const profileId = (await run(tab.session.me())).id
    const questionIds = await run(seedHistoryBank)
    // Held for Mocks, so Sectionals and Mocks can start again and again.
    await run(seedFullExamBank(8))
    const seeded = await run(seedHistory({ profileId, questionIds, sessions: HistorySessions, perSession: PerSession, start: Start }))
    responseIds = seeded.responses.map((row) => row.id!)
    console.log(`seeded ${responseIds.length} Responses in ${Math.round(performance.now() - began)} ms`)
    expect(responseIds.length).toBe(50_000)
  }, 600_000)

  afterAll(async () => {
    await runtime?.dispose()
    if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true })
  })

  test("95% of submits show the next Question within 100 ms", async () => {
    const samples: Array<number> = []
    const byKind = { sectional: [] as Array<number>, practiceAnswer: [] as Array<number>, practiceNext: [] as Array<number> }
    // In a Sectional, a submit returns the next Question, picked adaptively.
    for (const section of ["quant", "verbal", "di", "quant", "verbal", "di"]) {
      let view = await run(tab.sectionals.start({ payload: { section } }))
      while (view.stage === "question" && view.current !== null) {
        const current = view.current
        const answered = await time(tab.sectionals.answer({
          params: { id: view.id },
          payload: { seq: view.nextSeq, questionId: current.question.id, selection: firstPicks(current.question.parts) }
        }))
        samples.push(answered.ms)
        byKind.sectional.push(answered.ms)
        view = answered.value
      }
      await run(tab.sectionals.finish({ params: { id: view.id } }))
    }
    // In a timed Practice Set, a submit records the answer and Next shows
    // the next Question; each counts.
    for (const section of ["quant", "verbal", "di"]) {
      let view = await run(tab.practice.start({ payload: { choice: { kind: "filters", section, status: "any", size: 20, timed: true } } }))
      while (view.status === "active" && view.current !== null) {
        const current = view.current
        const answered = await time(tab.practice.answer({
          params: { id: view.id },
          payload: { seq: view.nextSeq, questionId: current.question.id, selection: firstPicks(current.question.parts), guessed: false }
        }))
        samples.push(answered.ms)
        byKind.practiceAnswer.push(answered.ms)
        if (current.position + 1 >= answered.value.total) {
          view = await run(tab.practice.finish({ params: { id: view.id } }))
          break
        }
        const next = await time(tab.practice.next({ params: { id: view.id }, payload: { position: current.position + 1 } }))
        samples.push(next.ms)
        byKind.practiceNext.push(next.ms)
        view = next.value
      }
    }
    report("  Sectional submit", byKind.sectional)
    report("  Practice Set submit", byKind.practiceAnswer)
    report("  Practice Set next", byKind.practiceNext)
    report("submit", samples)
    expect(samples.length).toBeGreaterThan(200)
    expect(p95(samples)).toBeLessThan(Limits.submitMs)
  }, 600_000)

  test("95% of Section starts take under 300 ms", async () => {
    const samples: Array<number> = []
    // A Sectional's start, then its screen's first read, as the app does.
    for (let round = 0; round < 8; round++) {
      for (const section of ["quant", "verbal", "di"]) {
        const started = await time(Effect.gen(function*() {
          const view = yield* tab.sectionals.start({ payload: { section } })
          return yield* tab.sectionals.get({ params: { id: view.id } })
        }))
        samples.push(started.ms)
        await run(tab.sectionals.finish({ params: { id: started.value.id } }))
      }
    }
    // A Mock's start and each Section after a break, with the screen's reads.
    for (let round = 0; round < 4; round++) {
      const begun = await time(Effect.gen(function*() {
        const mock = yield* tab.mocks.start({ payload: { order: ["quant", "verbal", "di"] } })
        const view = yield* tab.mocks.get({ params: { id: mock.id } })
        const first = view.sections.find((section) => section.place === view.current)!
        yield* tab.sectionals.get({ params: { id: first.sessionId! } })
        return view
      }))
      samples.push(begun.ms)
      let mock = begun.value
      while (mock.stage !== "finished") {
        if (mock.stage === "section") {
          const running = mock.sections.find((section) => section.place === mock.current)!
          await run(tab.sectionals.finish({ params: { id: running.sessionId! } }))
          mock = await run(tab.mocks.get({ params: { id: mock.id } }))
          continue
        }
        const id = mock.id
        const wentOn = await time(Effect.gen(function*() {
          yield* tab.mocks.goOn({ params: { id } })
          const view = yield* tab.mocks.get({ params: { id } })
          const running = view.sections.find((section) => section.place === view.current)
          if (running?.sessionId != null) yield* tab.sectionals.get({ params: { id: running.sessionId } })
          return view
        }))
        samples.push(wentOn.ms)
        mock = wentOn.value
      }
    }
    report("Section start", samples)
    expect(samples.length).toBeGreaterThanOrEqual(32)
    expect(p95(samples)).toBeLessThan(Limits.startMs)
  }, 600_000)

  test("95% of analytics views load in under 300 ms with 50,000 Responses, after writes too", async () => {
    const views = [
      ["weak areas", tab.analytics.weakAreas()],
      ["skill map", tab.analytics.skillMap()],
      ["timing", tab.analytics.timing()],
      ["mistakes", tab.analytics.mistakes()],
      ["study", tab.analytics.study()],
      ["score trend", tab.scores.trend()],
      ["score estimates", tab.scores.estimates()]
    ] as const
    const samples: Array<number> = []
    const label = (round: number) =>
      Effect.gen(function*() {
        const db = yield* Db
        yield* db.insert(mistakeLabels).values({
          id: crypto.randomUUID(),
          profileId: (yield* tab.session.me()).id,
          responseId: responseIds[(round * 7919) % responseIds.length]!,
          part: 0,
          mistakeType: "misread",
          createdAt: Start
        }).pipe(Effect.orDie)
      })
    // The first read of each waits for the app's read-ahead; it is not counted.
    for (const [, view] of views) await run(view as Effect.Effect<unknown, unknown, WorkerTestServices>)
    const byView = new Map<string, Array<number>>()
    for (let round = 0; round < 10; round++) {
      for (const [name, view] of views) {
        // Half the reads come right after a write, as after labelling a miss.
        const written = round % 2 === 0
        if (written) await run(label(round))
        const { ms } = await time(view as Effect.Effect<unknown, unknown, WorkerTestServices>)
        samples.push(ms)
        const key = `${name}${written ? " after a write" : ""}`
        byView.set(key, [...(byView.get(key) ?? []), ms])
      }
    }
    for (const [name, times] of byView) report(`  ${name}`, times)
    report("analytics view", samples)
    expect(p95(samples)).toBeLessThan(Limits.analyticsMs)
  }, 600_000)

  test("the app starts in under 2 seconds, with 50,000 Responses and from nothing", async () => {
    // The app this test ran stops, so another can open the data folder.
    await runtime.dispose()
    const samples: Array<number> = []
    for (let round = 0; round < 6; round++) {
      // Two of the starts are first starts, on an empty data folder.
      const fresh = round % 3 === 0
      const folder = fresh ? mkdtempSync(join(tmpdir(), "gmat-prep-start-")) : dataDir
      samples.push(await timeAppStart(folder))
      if (fresh) rmSync(folder, { recursive: true, force: true })
    }
    report("app start", samples)
    expect(p95(samples)).toBeLessThan(Limits.appStartMs)
  }, 600_000)
})

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))))
    })
  })

// The executable `bun run build` makes for this computer, as the Learner
// runs it.
const executable = () => {
  const platform = process.platform === "win32" ? "windows" : process.platform
  const path = join(import.meta.dir, "..", "dist", `gmat-prep-${platform}-${process.arch}${platform === "windows" ? ".exe" : ""}`)
  if (!existsSync(path)) throw new Error(`Build the executable first: bun run build (looked for ${path})`)
  return path
}

// From launching the executable until it answers an API request, then a
// clean stop. Only the processes this starts are stopped.
const timeAppStart = async (dataDir: string) => {
  const port = await freePort()
  const config = mkdtempSync(join(tmpdir(), "gmat-prep-config-"))
  const command = executable()
  const began = performance.now()
  const app = spawn(command, [], {
    env: { ...process.env, GMAT_PREP_DATA_DIR: dataDir, GMAT_PREP_CONFIG_DIR: config, GMAT_PREP_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  })
  let output = ""
  app.stdout.on("data", (chunk) => (output += String(chunk)))
  app.stderr.on("data", (chunk) => (output += String(chunk)))
  const exited = new Promise<void>((resolve) => app.once("exit", () => resolve()))
  try {
    for (;;) {
      if (app.exitCode !== null) throw new Error(`the app stopped while starting:\n${output}`)
      if (performance.now() - began > 30_000) throw new Error(`the app did not start in 30 s:\n${output}`)
      const answered = await fetch(`http://127.0.0.1:${port}/api/profiles`).then((response) => response.ok, () => false)
      if (answered) return performance.now() - began
      await Bun.sleep(10)
    }
  } finally {
    app.kill("SIGTERM")
    await Promise.race([exited, Bun.sleep(10_000)])
    if (app.exitCode === null && app.signalCode === null) app.kill("SIGKILL")
    // The job worker the app started stops with it.
    const worker = /Job worker ready \(pid (\d+)\)/.exec(output)?.[1]
    if (worker !== undefined) await stopped(Number(worker))
    rmSync(config, { recursive: true, force: true })
  }
}

// Waits for a process to end, and ends it if it outlives its app.
const stopped = async (pid: number) => {
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  for (let i = 0; i < 100 && alive(); i++) await Bun.sleep(50)
  if (alive()) process.kill(pid, "SIGKILL")
}
