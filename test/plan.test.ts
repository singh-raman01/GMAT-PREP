import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { type Duration, Effect, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { Api } from "../src/api/Api.ts"
import type { PlanSettingsInput, PlanView } from "../src/api/Plan.ts"
import type { PracticeView } from "../src/api/Practice.ts"
import { Db } from "../src/server/db/Database.ts"
import { planVersions, sessions } from "../src/server/db/schema.ts"
import { sectionTargetOf } from "../src/server/plans/Plans.ts"
import { totalScore } from "../src/server/ratings/scale.ts"
import { seedExamBank, SmallBlueprint } from "./fixtures/examBank.ts"
import { numbered, OtherPsSkill, seedBook } from "./fixtures/bank.ts"
import { openBrowser, runWithWorkers, tempDataDir, type WorkerTestServices } from "./harness.ts"

// The Study Plan at the API seam (docs/design.md, "Study Plan, Diagnostic
// and Daily Log", decisions 81 to 92).

// Noon UTC on Monday 2 November 2026.
const Start = Date.UTC(2026, 10, 2, 12)
const run = <A, E>(effect: Effect.Effect<A, E, WorkerTestServices>) => runWithWorkers(effect, undefined, tempDataDir(), Start)

const learner = (name: string, timeZone = "UTC") =>
  Effect.gen(function*() {
    const jar = yield* Ref.make(Cookies.empty)
    const tab = yield* HttpApiClient.make(Api, {
      transformClient: (client) =>
        client.pipe(HttpClient.withCookiesRef(jar), HttpClient.mapRequest(HttpClientRequest.setHeader("x-gp-device", "tab-1")))
    })
    const profile = yield* tab.profiles.create({ payload: { name, timeZone } })
    const later = (duration: Duration.Input) =>
      Effect.gen(function*() {
        yield* TestClock.adjust(duration)
        yield* tab.profiles.unlock({ params: { id: profile.id }, payload: {} })
      })
    return Object.assign(tab, { later, profileId: profile.id })
  })
type Tab = Effect.Success<ReturnType<typeof learner>>

const settings = (overrides: Partial<PlanSettingsInput> = {}): PlanSettingsInput => ({
  testDate: null,
  targetTotal: 655,
  weeklyMinutes: 600,
  daysOff: [0],
  timeZone: "UTC",
  rolloverHour: 4,
  ...overrides
})

const smallBlueprint = Effect.gen(function*() {
  const curator = yield* openBrowser
  yield* curator.curatorAccess.setPassphrase({ payload: { passphrase: "correct horse battery" } })
  yield* curator.settings.saveBlueprint({ payload: { blueprint: SmallBlueprint } })
})

const today = (view: PlanView) => view.plan.find((day) => day.day === view.today)!

// Answers every Question of an untimed or timed set with the first option.
const takeSet = (tab: Tab, started: PracticeView) =>
  Effect.gen(function*() {
    let view = started
    while (view.current !== null && view.status === "active") {
      const current = view.current
      yield* TestClock.adjust("60 seconds")
      view = yield* tab.practice.answer({
        params: { id: view.id },
        payload: {
          seq: view.nextSeq,
          questionId: current.question.id,
          selection: current.question.parts.map((part) => ({ part: part.position, choice: part.options[0]!.label })),
          guessed: false
        }
      })
      if (view.status !== "active") break
      if (!view.timed || view.current?.position === current.position) {
        view = current.position + 1 >= view.total
          ? yield* tab.practice.finish({ params: { id: view.id } })
          : yield* tab.practice.next({ params: { id: view.id }, payload: { position: current.position + 1 } })
      }
    }
    if (view.status === "active") view = yield* tab.practice.finish({ params: { id: view.id } })
    return view
  })

describe("Plan settings", () => {
  test("a Learner with none sees no plan until they are saved", () =>
    run(Effect.gen(function*() {
      const asha = yield* learner("Asha")
      const view = yield* asha.plan.view()
      expect(view).toMatchObject({ today: "2026-11-02", settings: null, version: null, plan: [], targets: null })
      expect(view.days).toMatchObject({ timeZone: "UTC", rolloverHour: 4, pending: null })
    })))

  test("are checked: a test date after today, a study day kept, and a real time zone", () =>
    run(Effect.gen(function*() {
      const asha = yield* learner("Asha")
      const tagOf = (input: PlanSettingsInput) =>
        asha.plan.saveSettings({ payload: input }).pipe(Effect.flip, Effect.map((error) => error._tag))
      expect(yield* tagOf(settings({ testDate: "2026-11-02" }))).toBe("PlanSettingsInvalid")
      expect(yield* tagOf(settings({ daysOff: [0, 1, 2, 3, 4, 5, 6] }))).toBe("PlanSettingsInvalid")
      expect(yield* tagOf(settings({ timeZone: "Mars/Olympus" }))).toBe("InvalidTimeZone")
    })))

  test("set equal Section targets that reach the target Total", () => {
    expect(sectionTargetOf(655)).toBe(83)
    expect(totalScore([83, 83, 83])).toBeGreaterThanOrEqual(655)
    expect(totalScore([82, 82, 82])).toBeLessThan(655)
    expect(sectionTargetOf(205)).toBe(60)
    expect(sectionTargetOf(805)).toBe(90)
  })
})

describe("Plan versions", () => {
  test("saving settings builds a plan from today, and reading again with nothing changed builds none", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Algebra Review", numbered(30))
      const asha = yield* learner("Asha")
      const saved = yield* asha.plan.saveSettings({ payload: settings() })
      expect(saved).toMatchObject({ version: 1, today: "2026-11-02" })
      expect(saved.plan.length).toBe(14)
      expect(saved.plan[0]!.day).toBe("2026-11-02")
      expect(saved.targets).toMatchObject({ total: 655 })
      expect(saved.targets!.sections.map((each) => each.target)).toEqual([83, 83, 83])
      // The Reserve is empty, so no Mock can start: the Diagnostic waits.
      expect(saved.diagnostic.state).toBe("blocked")
      expect(saved.notes.join(" ")).toContain("Medium")
      for (const item of today(saved).items) expect(item.status).toBe("planned")
      const again = yield* asha.plan.view()
      expect(again.version).toBe(1)
      expect(again.plan).toEqual(saved.plan)
    })))

  test("a new Study Day builds a new version from it, and the Daily Log keeps the day before as planned", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Algebra Review", numbered(30))
      const asha = yield* learner("Asha")
      const first = yield* asha.plan.saveSettings({ payload: settings() })
      const mondayItems = today(first).items.map((item) => item.title)
      // Past 4 am on Tuesday.
      yield* asha.later("17 hours")
      const second = yield* asha.plan.view()
      expect(second).toMatchObject({ version: 2, today: "2026-11-03" })
      expect(second.plan[0]!.day).toBe("2026-11-03")
      const log = yield* asha.plan.dailyLog()
      expect(log.today).toBe("2026-11-03")
      const monday = log.days.find((day) => day.day === "2026-11-02")!
      expect(monday.items.map((item) => item.title)).toEqual(mondayItems)
      expect(monday.items.every((item) => item.status === "planned")).toBe(true)
      const versions = yield* Effect.gen(function*() {
        const db = yield* Db
        return yield* db.select().from(planVersions).where(eq(planVersions.profileId, asha.profileId))
      })
      expect(versions.map((version) => [version.version, version.fromDay])).toEqual([[1, "2026-11-02"], [2, "2026-11-03"]])
    })))
})

describe("Plan items", () => {
  test("today's practice item starts a set from it, which marks it done once finished", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Algebra Review", numbered(30))
      yield* seedBook("Percents Review", numbered(30, { primarySkill: OtherPsSkill }))
      const asha = yield* learner("Asha")
      const saved = yield* asha.plan.saveSettings({ payload: settings() })
      const item = today(saved).items.find((each) => each.kind === "practice" && each.section?.id === "quant")!
      expect(item).toMatchObject({ status: "planned", timed: true })
      const started = yield* asha.plan.start({ params: { id: item.id }, payload: {} })
      expect(started.kind).toBe("practice")
      const set = yield* asha.practice.get({ params: { id: started.id } })
      expect(set.total).toBe(item.questions!)
      // Starting it again goes back to the same set.
      expect((yield* asha.plan.start({ params: { id: item.id }, payload: {} })).id).toBe(started.id)
      const during = yield* asha.plan.view()
      expect(today(during).items.find((each) => each.id === item.id)).toMatchObject({ status: "started", sessionId: started.id })
      yield* takeSet(asha, set)
      const after = yield* asha.plan.view()
      expect(today(after).items.find((each) => each.id === item.id)).toMatchObject({ status: "done" })
      // A done item cannot start again.
      const again = yield* asha.plan.start({ params: { id: item.id }, payload: {} }).pipe(Effect.flip)
      expect(again._tag).toBe("PlanItemNotOpen")
      const session = yield* Effect.gen(function*() {
        const db = yield* Db
        return (yield* db.select().from(sessions).where(eq(sessions.id, started.id)))[0]!
      })
      expect(session.planItemId).toBe(item.id)
    })))

  test("only today's items start", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Algebra Review", numbered(30))
      const asha = yield* learner("Asha")
      const saved = yield* asha.plan.saveSettings({ payload: settings() })
      const tomorrow = saved.plan[1]!.items[0]!
      const refused = yield* asha.plan.start({ params: { id: tomorrow.id }, payload: {} }).pipe(Effect.flip)
      expect(refused).toMatchObject({ _tag: "PlanItemNotOpen", day: "2026-11-03" })
      const stranger = yield* learner("Ravi")
      const hidden = yield* stranger.plan.start({ params: { id: tomorrow.id }, payload: {} }).pipe(Effect.flip)
      expect(hidden._tag).toBe("PlanItemNotFound")
    })))
})

describe("The Diagnostic", () => {
  test("is a Mock on the first study day once a Mock can start, and starts one from the plan", () =>
    run(Effect.gen(function*() {
      yield* smallBlueprint
      yield* seedExamBank()
      const asha = yield* learner("Asha")
      const saved = yield* asha.plan.saveSettings({ payload: settings({ testDate: "2026-12-19" }) })
      expect(saved.diagnostic).toMatchObject({ state: "pending", form: "mock" })
      const first = today(saved).items[0]!
      expect(first).toMatchObject({ kind: "mock", diagnostic: true, title: "Diagnostic Mock", minutes: 145 })
      const started = yield* asha.plan.start({ params: { id: first.id }, payload: { order: ["verbal", "quant", "di"] } })
      expect(started.kind).toBe("mock")
      const mock = yield* asha.mocks.get({ params: { id: started.id } })
      expect(mock.sections.map((section) => section.section.id)).toEqual(["verbal", "quant", "di"])
    })))

  test("can be skipped, and the plan then says each Section starts at Medium", () =>
    run(Effect.gen(function*() {
      yield* smallBlueprint
      yield* seedExamBank()
      const asha = yield* learner("Asha")
      yield* asha.plan.saveSettings({ payload: settings() })
      const skipped = yield* asha.plan.skipDiagnostic()
      expect(skipped.diagnostic.state).toBe("skipped")
      expect(skipped.version).toBe(2)
      expect(skipped.notes.join(" ")).toContain("skipped the Diagnostic")
      expect(skipped.plan.flatMap((day) => day.items).some((item) => item.diagnostic)).toBe(false)
      // Saving the settings again keeps the skip.
      const resaved = yield* asha.plan.saveSettings({ payload: settings({ weeklyMinutes: 480 }) })
      expect(resaved.diagnostic.state).toBe("skipped")
    })))

  test("under a Mock's time a week is the three Sectionals over three days", () =>
    run(Effect.gen(function*() {
      yield* smallBlueprint
      yield* seedExamBank()
      const asha = yield* learner("Asha")
      const saved = yield* asha.plan.saveSettings({ payload: settings({ weeklyMinutes: 120, daysOff: [] }) })
      expect(saved.diagnostic).toMatchObject({ state: "pending", form: "sectionals" })
      const firstThree = saved.plan.slice(0, 3).map((day) => day.items[0]!)
      expect(firstThree.map((item) => [item.kind, item.section?.id])).toEqual([["sectional", "quant"], ["sectional", "verbal"], ["sectional", "di"]])
    })))
})

describe("Study Days and the Daily Log", () => {
  test("a time zone change waits for the next rollover", () =>
    run(Effect.gen(function*() {
      const asha = yield* learner("Asha", "America/New_York")
      // Noon UTC is 7 am in New York: Monday's Study Day.
      const saved = yield* asha.plan.saveSettings({ payload: settings({ timeZone: "Asia/Taipei" }) })
      expect(saved.today).toBe("2026-11-02")
      // The next rollover is 4 am on Tuesday in New York, 09:00 UTC.
      expect(saved.days).toMatchObject({
        timeZone: "America/New_York",
        pending: { timeZone: "Asia/Taipei", rolloverHour: 4, from: Date.UTC(2026, 10, 3, 9) }
      })
      // At 10:00 UTC on Tuesday it is 6 pm there in Taipei.
      yield* asha.later("22 hours")
      const after = yield* asha.plan.view()
      expect(after.days).toMatchObject({ timeZone: "Asia/Taipei", pending: null })
      expect(after.today).toBe("2026-11-03")
    })))

  test("keeps a note for each Study Day, the latest kept", () =>
    run(Effect.gen(function*() {
      const asha = yield* learner("Asha")
      yield* asha.plan.writeNote({ params: { day: "2026-11-02" }, payload: { note: "Tired today." } })
      const day = yield* asha.plan.writeNote({ params: { day: "2026-11-02" }, payload: { note: "  Slept badly, kept going.  " } })
      expect(day).toMatchObject({ day: "2026-11-02", note: "Slept badly, kept going." })
      const log = yield* asha.plan.dailyLog()
      expect(log.days[0]).toMatchObject({ day: "2026-11-02", note: "Slept badly, kept going." })
      const cleared = yield* asha.plan.writeNote({ params: { day: "2026-11-02" }, payload: { note: "" } })
      expect(cleared.note).toBeNull()
    })))
})

describe("Building again during a day", () => {
  test("new settings keep today's done items and plan only the rest of the day", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Algebra Review", numbered(40))
      const asha = yield* learner("Asha")
      const saved = yield* asha.plan.saveSettings({ payload: settings() })
      const item = today(saved).items.find((each) => each.kind === "practice")!
      const started = yield* asha.plan.start({ params: { id: item.id }, payload: {} })
      yield* takeSet(asha, yield* asha.practice.get({ params: { id: started.id } }))
      const resaved = yield* asha.plan.saveSettings({ payload: settings({ weeklyMinutes: 900 }) })
      expect(resaved.version).toBe(2)
      const monday = today(resaved)
      // 900 minutes over 6 days is 150 a day; the done set's minutes are used.
      expect(monday.minutes).toBe(150)
      expect(monday.items[0]).toMatchObject({ id: item.id, status: "done" })
      const rest = monday.items.filter((each) => each.status === "planned")
      expect(rest.reduce((sum, each) => sum + each.minutes, 0)).toBeLessThanOrEqual(150 - item.minutes)
    })))

  test("a finished Mock builds again, and the Diagnostic is done", () =>
    run(Effect.gen(function*() {
      yield* smallBlueprint
      yield* seedExamBank()
      const asha = yield* learner("Asha")
      const saved = yield* asha.plan.saveSettings({ payload: settings({ testDate: "2026-12-19" }) })
      const diagnostic = today(saved).items[0]!
      const started = yield* asha.plan.start({ params: { id: diagnostic.id }, payload: {} })
      // Each Section runs out of time, and the break is skipped.
      let mock = yield* asha.mocks.get({ params: { id: started.id } })
      for (let guard = 0; mock.stage !== "finished" && guard < 10; guard += 1) {
        yield* TestClock.adjust("46 minutes")
        mock = yield* asha.mocks.get({ params: { id: started.id } })
        if (mock.stage === "break") mock = yield* asha.mocks.goOn({ params: { id: started.id } })
      }
      expect(mock.stage).toBe("finished")
      const after = yield* asha.plan.view()
      expect(after.diagnostic.state).toBe("done")
      expect(after.version).toBeGreaterThan(saved.version!)
      // The finished Mock fills the day: nothing else is planned for it.
      expect(today(after).items.filter((each) => each.status === "planned")).toEqual([])
      expect(today(after).items.find((each) => each.id === diagnostic.id)).toMatchObject({ status: "done" })
    })))
})
