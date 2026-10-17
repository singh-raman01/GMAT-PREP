import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
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
import type { ProfileId } from "../src/api/Profiles.ts"
import { Db } from "../src/server/db/Database.ts"
import { questions } from "../src/server/db/schema.ts"
import { ConnectionTest } from "../src/server/jobs/kinds/connectionTest.ts"
import { seedFullExamBank } from "./fixtures/fullExamBank.ts"
import { seedHistory, seedHistoryBank } from "./fixtures/history.ts"
import { appWithWorkersLayer, tempDataDir, type WorkerTestServices } from "./harness.ts"

// The speed targets (docs/design.md, "Speed targets", decision 127), each to
// hold 95% of the time, measured over HTTP on the real routes with one
// Profile's 50,000 Responses. Each kind of action, and each analytics view,
// must hold on its own, cold reads after a start or a Bank change included.
// The app's start is timed on the executable `bun run build` makes, as
// Learners run it. Seeding takes about a minute, so these run only when asked:
//
//   bun run test:speed        (bun run build && PERF=1 bun test test/speed.test.ts)
//
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

// Each kind's samples, reported, then held to the limit one kind at a time.
const holdEach = (kinds: ReadonlyMap<string, ReadonlyArray<number>>, limit: number) => {
  for (const [name, samples] of kinds) report(name, samples)
  for (const [name, samples] of kinds) expect({ name, p95: Math.round(p95(samples)) }).toEqual({ name, p95: Math.min(Math.round(p95(samples)), Math.round(limit) - 1) })
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

// A write to the Question Bank, after which the kept Question summaries are
// read again.
const bankWrite = (questionId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    yield* db.update(questions).set({ stem: sql`${questions.stem} || ' '` }).where(eq(questions.id, questionId)).pipe(Effect.orDie)
  })

describe.skipIf(!Enabled)("Speed targets", () => {
  let runtime: ManagedRuntime.ManagedRuntime<WorkerTestServices, never>
  let tab: Tab
  let dataDir: string
  let profileId: ProfileId
  let historyIds: ReadonlyArray<string> = []
  let responseIds: ReadonlyArray<string> = []
  const run = <A, E>(effect: Effect.Effect<A, E, WorkerTestServices>) => runtime.runPromise(effect)
  const time = async <A>(effect: Effect.Effect<A, unknown, WorkerTestServices>) => {
    const began = performance.now()
    const value = await run(effect)
    return { value, ms: performance.now() - began }
  }
  const startRuntime = () => {
    runtime = ManagedRuntime.make(appWithWorkersLayer(dataDir, [ConnectionTest], Start) as Layer.Layer<WorkerTestServices>)
  }
  // The app stops and starts again on the same data, nothing kept in memory;
  // the Learner unlocks their Profile again and, a couple of seconds later as
  // a Learner takes to get there, opens a screen. Meanwhile the app reads
  // ahead the history of the Profiles that practised last, as it does on
  // every start.
  const restart = async () => {
    await runtime.dispose()
    startRuntime()
    tab = await run(makeTab)
    await run(tab.profiles.unlock({ params: { id: profileId }, payload: {} }))
    await Bun.sleep(2000)
  }

  beforeAll(async () => {
    // The last test needs the executable; better to know before seeding.
    executable()
    dataDir = tempDataDir()
    startRuntime()
    const began = performance.now()
    tab = await run(makeTab)
    profileId = (await run(tab.profiles.create({ payload: { name: "Asha", timeZone: "America/New_York" } }))).id
    historyIds = await run(seedHistoryBank)
    // Held for Mocks, so Sectionals and Mocks can start again and again.
    await run(seedFullExamBank(8))
    const seeded = await run(seedHistory({ profileId, questionIds: historyIds, sessions: HistorySessions, perSession: PerSession, start: Start }))
    responseIds = seeded.responses.map((row) => row.id!)
    console.log(`seeded ${responseIds.length} Responses in ${Math.round(performance.now() - began)} ms`)
    expect(responseIds.length).toBe(50_000)
  }, 600_000)

  afterAll(async () => {
    await runtime?.dispose()
  })

  test("95% of submits show the next Question within 100 ms, for each kind of submit", async () => {
    const kinds = new Map<string, Array<number>>([["Sectional submit", []], ["Practice Set submit", []], ["Practice Set next", []]])
    // In a Sectional, a submit returns the next Question, picked adaptively.
    for (const section of ["quant", "verbal", "di", "quant", "verbal", "di"]) {
      let view = await run(tab.sectionals.start({ payload: { section } }))
      while (view.stage === "question" && view.current !== null) {
        const current = view.current
        const answered = await time(tab.sectionals.answer({
          params: { id: view.id },
          payload: { seq: view.nextSeq, questionId: current.question.id, selection: firstPicks(current.question.parts) }
        }))
        kinds.get("Sectional submit")!.push(answered.ms)
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
        kinds.get("Practice Set submit")!.push(answered.ms)
        if (current.position + 1 >= answered.value.total) {
          view = await run(tab.practice.finish({ params: { id: view.id } }))
          break
        }
        const next = await time(tab.practice.next({ params: { id: view.id }, payload: { position: current.position + 1 } }))
        kinds.get("Practice Set next")!.push(next.ms)
        view = next.value
      }
    }
    expect(kinds.get("Sectional submit")!.length).toBeGreaterThan(100)
    holdEach(kinds, Limits.submitMs)
  }, 600_000)

  test("95% of Section starts take under 300 ms, for Sectionals, Mocks and each Section after a break, cold ones included", async () => {
    const kinds = new Map<string, Array<number>>([["Sectional start", []], ["Mock start", []], ["Mock Section after a break", []]])
    const sectional = async (section: string) => {
      // A Sectional's start, then its screen's first read, as the app does.
      const started = await time(Effect.gen(function*() {
        const view = yield* tab.sectionals.start({ payload: { section } })
        return yield* tab.sectionals.get({ params: { id: view.id } })
      }))
      kinds.get("Sectional start")!.push(started.ms)
      await run(tab.sectionals.finish({ params: { id: started.value.id } }))
    }
    // The first start after the app starts reads the whole history.
    await restart()
    await sectional("quant")
    for (let round = 0; round < 8; round++) for (const section of ["quant", "verbal", "di"]) await sectional(section)
    // And the first after the Question Bank changes.
    await run(bankWrite(historyIds[0]!))
    await sectional("verbal")
    // A Mock's start and each Section after a break, with the screen's reads.
    for (let round = 0; round < 6; round++) {
      const begun = await time(Effect.gen(function*() {
        const mock = yield* tab.mocks.start({ payload: { order: ["quant", "verbal", "di"] } })
        const view = yield* tab.mocks.get({ params: { id: mock.id } })
        const first = view.sections.find((section) => section.place === view.current)!
        yield* tab.sectionals.get({ params: { id: first.sessionId! } })
        return view
      }))
      kinds.get("Mock start")!.push(begun.ms)
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
        kinds.get("Mock Section after a break")!.push(wentOn.ms)
        mock = wentOn.value
      }
    }
    holdEach(kinds, Limits.startMs)
  }, 600_000)

  test("95% of loads of each analytics view take under 300 ms with 50,000 Responses: cold, after labels, after answers and after a Bank change", async () => {
    const views = [
      ["weak areas", () => tab.analytics.weakAreas()],
      ["skill map", () => tab.analytics.skillMap()],
      ["timing", () => tab.analytics.timing()],
      ["mistakes", () => tab.analytics.mistakes()],
      ["study", () => tab.analytics.study()],
      ["score trend", () => tab.scores.trend()],
      ["score estimates", () => tab.scores.estimates()]
    ] as const
    const kinds = new Map<string, Array<number>>(views.map(([name]) => [name, []]))
    const readAll = async () => {
      for (const [name, view] of views) kinds.get(name)!.push((await time(view() as Effect.Effect<unknown, unknown, WorkerTestServices>)).ms)
    }
    // Cold: the first read of each view after the app starts.
    await restart()
    await readAll()
    // A miss labelled through the Error Log, as a Learner labels one.
    const entries = (await run(tab.errorLog.list({ query: {} }))).entries
    expect(entries.length).toBeGreaterThan(10)
    const label = (round: number) => {
      const entry = entries[round % entries.length]!
      return tab.errorLog.setMistakeType({
        params: { questionId: entry.questionId },
        payload: { responseId: entry.responseId, part: entry.parts[0]!.part, mistakeType: round % 4 === 0 ? "misread" : "concept-gap" }
      })
    }
    for (let round = 0; round < 20; round++) {
      for (const [name, view] of views) {
        // Half the reads come right after a write, as after labelling a miss.
        if (round % 2 === 0) await run(label(round))
        kinds.get(name)!.push((await time(view() as Effect.Effect<unknown, unknown, WorkerTestServices>)).ms)
      }
    }
    // Each right after an answer in a timed Practice Set, which changes the
    // facts every view is worked out from.
    let set = await run(tab.practice.start({ payload: { choice: { kind: "filters", section: "quant", status: "any", size: 7, timed: true } } }))
    for (const [name, view] of views) {
      const current = set.current!
      set = await run(tab.practice.answer({
        params: { id: set.id },
        payload: { seq: set.nextSeq, questionId: current.question.id, selection: firstPicks(current.question.parts), guessed: false }
      }))
      kinds.get(name)!.push((await time(view() as Effect.Effect<unknown, unknown, WorkerTestServices>)).ms)
      if (current.position + 1 < set.total) set = await run(tab.practice.next({ params: { id: set.id }, payload: { position: current.position + 1 } }))
    }
    await run(tab.practice.finish({ params: { id: set.id } }))
    // After the Question Bank changes, with no Question summary kept.
    await run(bankWrite(historyIds[1]!))
    await readAll()
    holdEach(kinds, Limits.analyticsMs)
  }, 600_000)

  test("the app starts in under 2 seconds, with 50,000 Responses and from nothing", async () => {
    // The app this test ran stops, so another can open the data folder.
    await runtime.dispose()
    // The day's first start takes the day's snapshot and the week's
    // integrity check in the background; once they are done, later starts
    // that day take neither, as on a Learner's computer.
    await startApp(dataDir, { settle: true })
    const kinds = new Map<string, Array<number>>([["app start, 50,000 Responses", []], ["app start, empty data folder", []]])
    for (let round = 0; round < 4; round++) kinds.get("app start, 50,000 Responses")!.push(await startApp(dataDir))
    for (let round = 0; round < 2; round++) {
      const folder = mkdtempSync(join(tmpdir(), "gmat-prep-start-"))
      try {
        kinds.get("app start, empty data folder")!.push(await startApp(folder))
      } finally {
        rmSync(folder, { recursive: true, force: true })
        rmSync(`${folder}-config`, { recursive: true, force: true })
      }
    }
    holdEach(kinds, Limits.appStartMs)
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

// A process's children whose command line matches, where pgrep is there to
// ask (macOS and Linux).
const childrenOf = (pid: number, matching?: string): ReadonlyArray<number> => {
  try {
    const found = Bun.spawnSync(["pgrep", "-P", String(pid), ...(matching === undefined ? [] : ["-f", matching])])
    return found.exitCode === 0 ? new TextDecoder().decode(found.stdout).split("\n").filter((line) => line !== "").map(Number) : []
  } catch {
    return []
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// From launching the executable until it answers an API request. Then, with
// `settle`, until its background snapshot work is done; then a clean stop,
// waiting for every process it started to end. Returns the time to answer.
const startApp = async (dataDir: string, options: { readonly settle?: boolean } = {}) => {
  const port = await freePort()
  const config = mkdtempSync(join(tmpdir(), "gmat-prep-config-"))
  let output = ""
  const began = performance.now()
  const app = spawn(executable(), [], {
    env: { ...process.env, GMAT_PREP_DATA_DIR: dataDir, GMAT_PREP_CONFIG_DIR: config, GMAT_PREP_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  })
  app.stdout.on("data", (chunk) => (output += String(chunk)))
  app.stderr.on("data", (chunk) => (output += String(chunk)))
  const exited = new Promise<void>((resolve) => app.once("exit", () => resolve()))
  try {
    let answeredAt: number | undefined
    while (answeredAt === undefined) {
      if (app.exitCode !== null) throw new Error(`the app stopped while starting:\n${output}`)
      if (performance.now() - began > 30_000) throw new Error(`the app did not start in 30 s:\n${output}`)
      const answered = await fetch(`http://127.0.0.1:${port}/api/profiles`, { signal: AbortSignal.timeout(1000) })
        .then((response) => response.ok, () => false)
      if (answered) answeredAt = performance.now()
      else await Bun.sleep(10)
    }
    if (options.settle === true) {
      // Quiet for a second, at most a minute.
      let quiet = 0
      for (let waited = 0; quiet < 10 && waited < 600; waited++) {
        quiet = childrenOf(app.pid!, "snapshot-").length === 0 ? quiet + 1 : 0
        await Bun.sleep(100)
      }
    }
    return answeredAt - began
  } finally {
    const started = childrenOf(app.pid!)
    app.kill("SIGTERM")
    await Promise.race([exited, Bun.sleep(10_000)])
    if (app.exitCode === null && app.signalCode === null) app.kill("SIGKILL")
    for (const pid of started) {
      for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(50)
      if (alive(pid)) process.kill(pid, "SIGKILL")
    }
    rmSync(config, { recursive: true, force: true })
  }
}
