import { describe, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { type Duration, Effect, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { Api } from "../src/api/Api.ts"
import type { PlanSettingsInput, PlanView } from "../src/api/Plan.ts"
import type { PracticeView, SessionId } from "../src/api/Practice.ts"
import { Db } from "../src/server/db/Database.ts"
import { planItems, planSettings, sessions } from "../src/server/db/schema.ts"
import { seedExamBank, SmallBlueprint } from "./fixtures/examBank.ts"
import { numbered, OtherPsSkill, seedBook } from "./fixtures/bank.ts"
import { openBrowser, runWithWorkers, tempDataDir, type WorkerTestServices } from "./harness.ts"

// The Study Plan made again during a day and across days, and its limits:
// the ticket 16 review's findings, kept as regression tests.

// Noon UTC on Monday 2 November 2026.
const Start = Date.UTC(2026, 10, 2, 12)
const run = <A, E>(effect: Effect.Effect<A, E, WorkerTestServices>) => runWithWorkers(effect, undefined, tempDataDir(), Start)

const learner = (name: string, timeZone = "UTC", device = "tab-1") =>
  Effect.gen(function*() {
    const jar = yield* Ref.make(Cookies.empty)
    const tab = yield* HttpApiClient.make(Api, {
      transformClient: (client) =>
        client.pipe(HttpClient.withCookiesRef(jar), HttpClient.mapRequest(HttpClientRequest.setHeader("x-gp-device", device)))
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

// Answers every Question of a set with the first option.
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

// Takes a Sectional to its end, every answer C.
const takeSectional = (tab: Tab, id: SessionId) =>
  Effect.gen(function*() {
    let view = yield* tab.sectionals.get({ params: { id } })
    while (view.stage === "question") {
      yield* TestClock.adjust("1 minute")
      view = yield* tab.sectionals.answer({
        params: { id: view.id },
        payload: { seq: view.nextSeq, questionId: view.current!.question.id, selection: [{ part: 0, choice: "C" }] }
      })
    }
    return yield* tab.sectionals.finish({ params: { id: view.id } })
  })

const sessionsOf = (planItemId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    return yield* db.select({ id: sessions.id }).from(sessions).where(eq(sessions.planItemId, planItemId))
  })

describe("Starting plan items", () => {
  test("two starts of one practice item at once make one set", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Algebra Review", numbered(40))
      yield* seedBook("Percents Review", numbered(40, { primarySkill: OtherPsSkill }))
      const asha = yield* learner("Asha")
      const saved = yield* asha.plan.saveSettings({ payload: settings() })
      const item = today(saved).items.find((each) => each.kind === "practice")!
      const [a, b] = yield* Effect.all([
        asha.plan.start({ params: { id: item.id }, payload: {} }),
        asha.plan.start({ params: { id: item.id }, payload: {} })
      ], { concurrency: 2 })
      expect((yield* sessionsOf(item.id)).length).toBe(1)
      expect(a.id).toBe(b.id)
    })))

  test("a started item stays on today's list when the plan is made again during the day", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Algebra Review", numbered(40))
      const asha = yield* learner("Asha")
      const saved = yield* asha.plan.saveSettings({ payload: settings() })
      const item = today(saved).items.find((each) => each.kind === "practice")!
      const started = yield* asha.plan.start({ params: { id: item.id }, payload: {} })
      const resaved = yield* asha.plan.saveSettings({ payload: settings({ weeklyMinutes: 660 }) })
      expect(resaved.version).toBe(2)
      const monday = today(resaved)
      expect(monday.items.find((each) => each.sessionId === started.id)).toMatchObject({ id: item.id, status: "started" })
      // The started set's minutes are used, as if done.
      const planned = monday.items.filter((each) => each.status === "planned")
      expect(planned.reduce((sum, each) => sum + each.minutes, 0) + item.minutes).toBeLessThanOrEqual(monday.minutes)
    })))

  test("a set done today is not planned again when the plan is made again during the day", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Algebra Review", numbered(40))
      yield* seedBook("Percents Review", numbered(40, { primarySkill: OtherPsSkill }))
      const asha = yield* learner("Asha")
      const saved = yield* asha.plan.saveSettings({ payload: settings({ daysOff: [] }) })
      const first = today(saved).items[0]!
      const started = yield* asha.plan.start({ params: { id: first.id }, payload: {} })
      yield* takeSet(asha, yield* asha.practice.get({ params: { id: started.id } }))
      const resaved = yield* asha.plan.saveSettings({ payload: settings({ daysOff: [], weeklyMinutes: 660 }) })
      const monday = today(resaved)
      expect(monday.items[0]).toMatchObject({ id: first.id, status: "done" })
      // With no Weak Area yet, the day is mixed sets in turn: Quantitative
      // was done, so Verbal comes next.
      expect(first).toMatchObject({ weakArea: null, section: { id: "quant" } })
      const nextMixed = monday.items.find((each) => each.status === "planned" && each.kind === "practice" && each.weakArea === null)
      expect(nextMixed?.section?.id).toBe("verbal")
    })))
})

describe("Plan limits", () => {
  test("a test date more than 2 years on is refused", () =>
    run(Effect.gen(function*() {
      const asha = yield* learner("Asha")
      const refused = yield* asha.plan.saveSettings({ payload: settings({ testDate: "2028-11-03" }) }).pipe(Effect.flip)
      expect(refused).toMatchObject({ _tag: "PlanSettingsInvalid", problems: ["Choose a test date within 2 years."] })
      const db = yield* Db
      expect(yield* db.select().from(planSettings)).toEqual([])
      // The furthest date allowed still makes a plan, and reads stay quick.
      const far = yield* asha.plan.saveSettings({ payload: settings({ testDate: "2028-11-01", weeklyMinutes: 3600, daysOff: [] }) })
      expect(far.version).toBe(1)
      expect(far.plan.length).toBe(730)
      const began = performance.now()
      yield* asha.plan.view()
      yield* asha.plan.dailyLog()
      expect(performance.now() - began).toBeLessThan(1500)
    })), 60_000)

  test("a target Total is one a test can give: 205 to 805, ending in 5", () =>
    run(Effect.gen(function*() {
      const asha = yield* learner("Asha")
      const refused = yield* asha.plan.saveSettings({ payload: settings({ targetTotal: 650 }) }).pipe(Effect.flip)
      expect(refused._tag).not.toBe("PlanSettingsInvalid")
      const saved = yield* asha.plan.saveSettings({ payload: settings({ targetTotal: 645 }) })
      expect(saved.settings?.targetTotal).toBe(645)
    })))

  test("the plan and the Daily Log stay quick after 60 Study Days of plan versions", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Algebra Review", numbered(40))
      yield* seedBook("Percents Review", numbered(40, { primarySkill: OtherPsSkill }))
      const asha = yield* learner("Asha")
      yield* asha.plan.saveSettings({ payload: settings({ testDate: "2027-11-01", weeklyMinutes: 1200, targetTotal: null }) })
      for (let day = 1; day <= 60; day += 1) {
        yield* asha.later("24 hours")
        yield* asha.plan.view()
      }
      const db = yield* Db
      const [count] = yield* db.select({ rows: sql<number>`count(*)` }).from(planItems)
      // Sets are kept for 4 weeks ahead, not to the test.
      expect(count!.rows).toBeLessThan(20_000)
      const times: Array<number> = []
      for (let round = 0; round < 3; round += 1) {
        const began = performance.now()
        yield* asha.plan.dailyLog()
        yield* asha.plan.view()
        times.push(performance.now() - began)
      }
      expect(Math.min(...times)).toBeLessThan(300)
    })), 120_000)

  test("saving the same settings again keeps the plan as it is", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Algebra Review", numbered(30))
      const asha = yield* learner("Asha")
      const saved = yield* asha.plan.saveSettings({ payload: settings({ daysOff: [6, 0] }) })
      const again = yield* asha.plan.saveSettings({ payload: settings({ daysOff: [0, 6] }) })
      expect(again.version).toBe(saved.version)
      const db = yield* Db
      expect((yield* db.select().from(planSettings)).length).toBe(1)
    })))
})

describe("The Diagnostic as three Sectionals", () => {
  test("after its first Sectional, the other two are still planned, each on a day of its own", () =>
    run(Effect.gen(function*() {
      yield* smallBlueprint
      yield* seedExamBank()
      const asha = yield* learner("Asha")
      const saved = yield* asha.plan.saveSettings({ payload: settings({ weeklyMinutes: 120, daysOff: [] }) })
      expect(saved.diagnostic).toMatchObject({ state: "pending", form: "sectionals" })
      const quant = today(saved).items[0]!
      expect(quant).toMatchObject({ kind: "sectional", diagnostic: true, section: { id: "quant" } })
      const started = yield* asha.plan.start({ params: { id: quant.id }, payload: {} })
      yield* takeSectional(asha, started.id)
      const after = yield* asha.plan.view()
      expect(after.diagnostic.state).toBe("pending")
      expect(after.diagnostic.sectionsLeft.map((each) => each.id)).toEqual(["verbal", "di"])
      const planned = after.plan.flatMap((day) => day.items.filter((each) => each.diagnostic && each.status === "planned").map((each) => [day.day, each.section?.id]))
      // Not today, after today's: the next two days.
      expect(planned).toEqual([["2026-11-03", "verbal"], ["2026-11-04", "di"]])
      expect(today(after).items.map((each) => [each.id, each.status])).toEqual([[quant.id, "done"]])
    })), 60_000)
})

describe("Mocks counted from the Reserve", () => {
  test("four times the Blueprint unseen lets three Mocks start in turn, and the plan counts three", () =>
    run(Effect.gen(function*() {
      yield* smallBlueprint
      yield* seedExamBank()
      yield* seedExamBank({ quant: "Quant Review 2", verbal: "Verbal Review 2", di: "Data Insights Review 2" })
      const asha = yield* learner("Asha")
      const saved = yield* asha.plan.saveSettings({ payload: settings({ testDate: "2027-01-30" }) })
      const mocks = saved.plan.flatMap((day) => day.items).filter((each) => each.kind === "mock")
      expect(mocks.length).toBe(3)
      expect(mocks[0]!.diagnostic).toBe(true)
      const dropped = saved.dropped.filter((each) => each.kind === "mock")
      expect(dropped.length).toBe(2)
      expect(dropped[0]!.reason).toContain("only 2 more Mocks")
    })), 60_000)
})

describe("Time zones", () => {
  test("the Error Log shows times in the zone in effect now, not one waiting for the next rollover", () =>
    run(Effect.gen(function*() {
      const asha = yield* learner("Asha", "America/New_York")
      yield* asha.plan.saveSettings({ payload: settings({ timeZone: "Asia/Taipei" }) })
      const log = yield* asha.errorLog.list({ query: {} })
      expect(log.timeZone).toBe("America/New_York")
      yield* asha.later("22 hours")
      expect((yield* asha.errorLog.list({ query: {} })).timeZone).toBe("Asia/Taipei")
    })))

  test("undoing a waiting change leaves none waiting, and a zone named in other case is the same zone", () =>
    run(Effect.gen(function*() {
      const asha = yield* learner("Asha", "America/New_York")
      const changed = yield* asha.plan.saveSettings({ payload: settings({ timeZone: "Asia/Taipei" }) })
      expect(changed.days.pending).toMatchObject({ timeZone: "Asia/Taipei" })
      const undone = yield* asha.plan.saveSettings({ payload: settings({ timeZone: "america/new_york" }) })
      expect(undone.days).toMatchObject({ timeZone: "America/New_York", pending: null })
    })))
})

describe("Daily Log notes", () => {
  test("are kept for today and the 89 Study Days before it, and refused for other days", () =>
    run(Effect.gen(function*() {
      const asha = yield* learner("Asha")
      for (const day of ["2026-11-03", "2027-06-01", "2026-08-04"]) {
        const refused = yield* asha.plan.writeNote({ params: { day }, payload: { note: "A note." } }).pipe(Effect.flip)
        expect(refused).toMatchObject({ _tag: "NoteDayInvalid", day })
      }
      const kept = yield* asha.plan.writeNote({ params: { day: "2026-08-05" }, payload: { note: "The first day kept." } })
      expect(kept.note).toBe("The first day kept.")
    })))
})
