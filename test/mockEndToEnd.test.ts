import { BunHttpServer } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import { Clock, Effect, Layer, ManagedRuntime } from "effect"
import { HttpRouter } from "effect/http"
import { TestClock } from "effect/testing"
import { existsSync, mkdtempSync, readdirSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Browser, chromium, type Page } from "playwright"
import { Network } from "../src/server/access/Network.ts"
import { AppConfig } from "../src/server/AppConfig.ts"
import { AppRoutes, AppServices } from "../src/server/app.ts"
import { LlmTransportReplay } from "../src/server/llm/LlmTransport.ts"
import { SnapshotCopierInProcess } from "../src/server/snapshots/copier.ts"
import { WorkerSupervisor } from "../src/server/worker/WorkerSupervisor.ts"
import { seedFullExamBank } from "./fixtures/fullExamBank.ts"
import { tempDataDir } from "./harness.ts"

// One full Mock in a real browser against the real server (decision 127), on
// a fake clock both sides share: the server's TestClock and the page's clock
// move together, a minute a Question. It takes the break, comes back from
// the app stopping in Section 2 (an Interruption), uses Review & Edit, sees
// the 5-minute warning with the timer hidden, runs Section 3 out of time, and
// checks the Mock report and the Score Estimates. The LLM transport serves
// recorded replies only, from an empty folder, so the run is offline and
// fails if anything calls a model. It needs the web app built and Chromium:
//
//   bun run test:e2e          (bun run build:web && E2E=1 bun test test/mockEndToEnd.test.ts)
//   bunx playwright install chromium     (once, on a new machine)

const Enabled = process.env["E2E"] === "1"
const Root = join(import.meta.dir, "..")
// Thursday 1 October 2026, 2 pm in New York.
const Start = Date.UTC(2026, 9, 1, 18)
const MinuteMs = 60_000

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))))
    })
  })

// The app as it runs, with no job worker, on a port the browser can reach
// again after a restart, its clock set to startAt.
const appLayer = (dataDir: string, port: number, startAt: number, recordings: string) =>
  HttpRouter.serve(AppRoutes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provideMerge(AppServices),
    Layer.provide(WorkerSupervisor.layerIdle),
    Layer.provide(SnapshotCopierInProcess),
    Layer.provide(LlmTransportReplay(recordings)),
    Layer.provide(Network.live),
    Layer.provideMerge(AppConfig.layer({ dataDir, preferredPort: port })),
    Layer.provideMerge(BunHttpServer.layer({ hostname: "127.0.0.1", port })),
    Layer.provideMerge(Layer.effectDiscard(TestClock.setTime(startAt))),
    Layer.provideMerge(TestClock.layer())
  )

type App = ManagedRuntime.ManagedRuntime<Layer.Success<ReturnType<typeof appLayer>>, Layer.Error<ReturnType<typeof appLayer>>>

const startApp = async (dataDir: string, port: number, startAt: number, recordings: string): Promise<App> => {
  const app = ManagedRuntime.make(appLayer(dataDir, port, startAt, recordings))
  // The layer, and with it the server, is built on first use.
  await app.runPromise(Effect.void)
  return app
}

const questionCount = /^Question (\d+) of (\d+)$/

// The number on screen and the Section's count, once a Question shows.
const onScreen = async (page: Page) => {
  const heading = page.locator("h1.question-count")
  await heading.waitFor()
  const match = questionCount.exec((await heading.innerText()).trim())
  if (match === null) throw new Error(`not a Question: ${await heading.innerText()}`)
  return { number: Number(match[1]), total: Number(match[2]) }
}

// Answers the Question on screen and submits it: A to E and Enter for one
// choice, as a Learner at the keyboard would; a click on each part otherwise.
const answer = async (page: Page, letter: string) => {
  const body = page.locator(".question-body")
  const groups = [...new Set(await body.locator("input[type=radio]").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).name)))]
  const menus = body.locator("select")
  if (groups.length === 1 && (await menus.count()) === 0) {
    await page.locator("h1.question-count").focus()
    await page.keyboard.press(letter)
    await expect(await body.locator("input[type=radio]:checked").count()).toBe(1)
    await page.keyboard.press("Enter")
    return
  }
  for (const group of groups) await body.locator(`input[type=radio][name="${group}"]`).first().check()
  for (let i = 0; i < (await menus.count()); i++) await menus.nth(i).selectOption({ index: 1 })
  await page.getByRole("button", { name: /^Submit and (go on|review)$/ }).click()
}

// The Question after the one numbered `from`, once it shows.
const nextQuestion = async (page: Page, from: number) => {
  await page.waitForFunction(
    (number) => document.querySelector("h1.question-count")?.textContent?.trim().startsWith(`Question ${number} of`) !== true,
    from
  )
  return onScreen(page)
}

describe.skipIf(!Enabled)("A full Mock in the browser", () => {
  test("with the break, an Interruption, Review & Edit, a time-out, the report and the Score Estimates", async () => {
    if (!existsSync(join(Root, "web", "dist", "index.html"))) throw new Error("Build the web app first: bun run build:web")
    const dataDir = tempDataDir()
    const recordings = mkdtempSync(join(tmpdir(), "gmat-prep-recordings-"))
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    let app = await startApp(dataDir, port, Start, recordings)
    let browser: Browser | undefined
    let shown: Page | undefined
    try {
      // Twice the real blueprint held for Mocks: exactly one Mock's worth.
      await app.runPromise(seedFullExamBank(2))
      browser = await chromium.launch()
      const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "America/New_York" })).newPage()
      shown = page
      const problems: Array<string> = []
      page.on("pageerror", (error) => problems.push(error.message))
      // The page's clock starts with the server's and runs on its own between
      // the jumps the test makes on both.
      await page.clock.install({ time: Start })
      const advance = async (millis: number) => {
        await app.runPromise(TestClock.adjust(millis))
        await page.clock.fastForward(millis)
      }

      // A Learner sets up a Profile and starts a Mock in the first order.
      await page.goto(base)
      await page.getByRole("heading", { name: "Set up your first profile" }).waitFor()
      await page.getByLabel("Name").fill("Asha")
      await page.getByRole("button", { name: "Add profile" }).click()
      await page.getByRole("link", { name: "Mocks" }).first().click()
      await page.getByRole("heading", { name: "Mocks", exact: true }).waitFor()
      await page.getByRole("button", { name: "Start the Mock" }).click()

      // Section 1, Quantitative Reasoning: every Question answered at a minute
      // each, two in three right, the third Bookmarked.
      let at = await onScreen(page)
      expect(at).toEqual({ number: 1, total: 21 })
      expect(await page.locator(".timer-time").innerText()).toMatch(/4[45]:\d\d/)
      for (;;) {
        if (at.number === 3) await page.getByRole("button", { name: "Bookmark", exact: true }).click()
        await answer(page, at.number % 3 === 0 ? "a" : "c")
        await advance(MinuteMs)
        if (at.number === at.total) break
        at = await nextQuestion(page, at.number)
      }
      // Review & Edit, with 24 minutes left: Question 3 changes to C.
      await page.getByRole("heading", { name: "Review & Edit" }).waitFor()
      await page.getByText("You can change 3 more answers").waitFor()
      await page.getByRole("button", { name: "Open Question 3" }).click()
      await page.getByRole("heading", { name: "Question 3 of 21" }).waitFor()
      await page.locator(".question-body input[type=radio]").nth(2).check()
      await page.getByRole("button", { name: "Change my answer" }).click()
      await page.getByText("Answer changed.").waitFor()
      await page.getByRole("button", { name: "Back to the list" }).click()
      await page.getByRole("button", { name: "Finish the Section" }).click()
      await page.getByRole("button", { name: "Finish and see the report" }).click()

      // The break, taken in full: when it runs out, Section 2 starts.
      await page.getByRole("heading", { name: "Break" }).waitFor()
      await advance(10 * MinuteMs + 2_000)
      at = await onScreen(page)
      expect(at).toEqual({ number: 1, total: 23 })

      // Section 2, Verbal Reasoning: eight Questions, then the app stops for
      // a minute and starts again, as when the computer sleeps.
      for (let i = 0; i < 8; i++) {
        await answer(page, "c")
        await advance(MinuteMs)
        at = await nextQuestion(page, at.number)
      }
      expect(at.number).toBe(9)
      const stoppedAt = await app.runPromise(Clock.currentTimeMillis)
      await app.dispose()
      app = await startApp(dataDir, port, stoppedAt + MinuteMs, recordings)
      await page.clock.fastForward(MinuteMs)
      await page.reload()
      at = await onScreen(page)
      expect(at).toEqual({ number: 9, total: 23 })
      for (;;) {
        await answer(page, "c")
        await advance(MinuteMs)
        if (at.number === at.total) break
        at = await nextQuestion(page, at.number)
      }
      await page.getByRole("heading", { name: "Review & Edit" }).waitFor()
      await page.getByRole("button", { name: "Finish the Section" }).click()
      await page.getByRole("button", { name: "Finish and see the report" }).click()

      // Section 3, Data Insights, straight on as the break is taken: five
      // Questions, then the timer hidden, the warning at 5 minutes left, and
      // time running out.
      at = await onScreen(page)
      expect(at).toEqual({ number: 1, total: 20 })
      for (let i = 0; i < 5; i++) {
        await answer(page, "c")
        await advance(MinuteMs)
        at = await nextQuestion(page, at.number)
      }
      expect(at.number).toBe(6)
      await page.getByRole("button", { name: "Hide the timer" }).click()
      await advance(35 * MinuteMs)
      const warning = page.locator(".timer-warning")
      await warning.waitFor()
      expect(await warning.getAttribute("role")).toBe("alert")
      expect(await warning.innerText()).toMatch(/\d+ minutes?( \d+ seconds?)? left\./)
      expect(await page.locator(".timer-time").count()).toBe(0)
      await advance(6 * MinuteMs)

      // The Mock report: a Total and the three Sections, the second marked
      // interrupted.
      await page.getByRole("heading", { name: /^Mock, / }).waitFor({ timeout: 20_000 })
      const total = Number(await page.locator(".report-score .score-value").innerText())
      expect(total).toBeGreaterThanOrEqual(205)
      expect(total).toBeLessThanOrEqual(805)
      const sections = page.locator(".mock-section")
      expect(await sections.count()).toBe(3)
      expect(await sections.nth(1).innerText()).toContain("interrupted")
      expect(await sections.nth(0).innerText()).not.toContain("interrupted")
      expect(await page.locator(".report-notes").innerText()).toContain("1 Section lost time to a stop of the app or the computer")
      for (let i = 0; i < 3; i++) {
        const score = Number(await sections.nth(i).locator(".mock-section-score").innerText())
        expect(score).toBeGreaterThanOrEqual(60)
        expect(score).toBeLessThanOrEqual(90)
      }

      // Section 3 ran out of time: its report says so.
      await sections.nth(2).getByRole("link", { name: /Each Question/ }).click()
      await page.getByText("Time ran out.").first().waitFor()

      // The Score Estimates moved with the Mock.
      await page.goto(`${base}/scores`)
      await page.getByRole("heading", { name: "Score Estimates" }).waitFor()
      const estimates = page.locator("section[aria-labelledby=estimates-title]")
      await estimates.locator(".score-list").waitFor()
      const listed = await estimates.innerText()
      for (const name of ["Total", "Quantitative Reasoning", "Verbal Reasoning", "Data Insights"]) expect(listed).toContain(name)

      expect(problems).toEqual([])
      // Nothing asked a model: the recorded-reply folder is still empty.
      expect(readdirSync(recordings)).toEqual([])
    } catch (error) {
      // What the page showed when a step failed.
      const main = await shown?.locator("main").innerText({ timeout: 1000 }).catch(() => "")
      console.log(`The page showed: ${(main ?? "").replace(/\s+/g, " ").slice(0, 800)}`)
      throw error
    } finally {
      await browser?.close()
      await app.dispose()
    }
  }, 300_000)
})
