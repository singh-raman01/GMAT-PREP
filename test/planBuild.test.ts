import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import {
  buildPlan,
  dayNumber,
  dayOfNumber,
  MockMinutes,
  type PlanInputs,
  type PlannedItem,
  SectionalMinutes
} from "../src/server/plans/build.ts"

// The Study Plan builder (docs/design.md, "Study Plan, Diagnostic and Daily
// Log", decisions 83 to 89): a pure function of the settings and a state
// snapshot.

const pace = { quant: 129_000, verbal: 117_000, di: 135_000 }

const sections = (ability: number | null, rated: number) =>
  (["quant", "verbal", "di"] as const).map((id) => ({ id, ability, rated, paceMs: pace[id] }))

// A Monday, so weekdays are easy to read: 2026-11-02 is a Monday.
const Monday = "2026-11-02"
const plus = (day: string, days: number) => dayOfNumber(dayNumber(day) + days)

const inputs = (overrides: Partial<PlanInputs["settings"]> = {}, state: Partial<PlanInputs["state"]> = {}): PlanInputs => ({
  settings: { testDate: null, targetTotal: null, weeklyMinutes: 600, daysOff: [0], ...overrides },
  state: {
    today: Monday,
    sections: sections(0.4, 40),
    weakAreas: [
      { kind: "skill", id: "quant.percents", name: "Percents", section: "quant", priority: 0.3, ability: -0.2, slow: false, topMistake: "concept-gap", topTrap: null },
      { kind: "questionType", id: "verbal.cr-weaken", name: "CR Weaken", section: "verbal", priority: 0.2, ability: 0.1, slow: true, topMistake: null, topTrap: null },
      { kind: "skill", id: "di.tables", name: "Sorting tables", section: "di", priority: 0.1, ability: 0, slow: false, topMistake: "trap", topTrap: "trap.extreme" }
    ],
    retries: [],
    allowed: { quant: 6, verbal: 6, di: 6 },
    diagnostic: "done",
    doneToday: 0,
    mockToday: false,
    lessons: [],
    ...state,
    // A pending Diagnostic has every Section still to take unless said.
    diagnosticSections: state.diagnosticSections ?? (state.diagnostic === "pending" ? ["quant", "verbal", "di"] : [])
  }
})

const itemsOn = (plan: ReturnType<typeof buildPlan>, day: string) => plan.days.find((each) => each.day === day)?.items ?? []
const minutesOf = (items: ReadonlyArray<PlannedItem>) => items.reduce((sum, item) => sum + item.minutes, 0)

describe("Study Plan minutes", () => {
  test("weekly time is shared over the study days, and a day off gets nothing", () => {
    const plan = buildPlan(inputs())
    const monday = plan.days.find((day) => day.day === Monday)!
    const sunday = plan.days.find((day) => day.day === plus(Monday, 6))!
    expect(monday.minutes).toBe(100)
    expect(sunday).toMatchObject({ off: true, minutes: 0, items: [] })
    expect(minutesOf(monday.items)).toBeLessThanOrEqual(100)
  })

  test("without a test date the plan covers 14 Study Days", () => {
    const plan = buildPlan(inputs())
    expect(plan.days.length).toBe(14)
    expect(plan.days[0]!.day).toBe(Monday)
    expect(plan.notes.some((note) => note.includes("14 Study Days"))).toBe(true)
  })

  test("a test date today or past plans nothing and says so", () => {
    const plan = buildPlan(inputs({ testDate: Monday }))
    expect(plan.days).toEqual([])
    expect(plan.notes.join(" ")).toContain("test date")
  })
})

describe("Mocks", () => {
  // The test is on a Saturday 6 weeks and 5 days on.
  const testDate = plus(Monday, 47)

  test("one Mock a week over the last 4 weeks, the last at least 3 days before the test", () => {
    const plan = buildPlan(inputs({ testDate }))
    const mocks = plan.days.flatMap((day) => day.items.filter((item) => item.kind === "mock").map(() => day.day))
    expect(mocks.length).toBe(4)
    for (const day of mocks) expect(dayNumber(day)).toBeLessThanOrEqual(dayNumber(testDate) - 3)
    const weeks = new Set(mocks.map((day) => Math.floor((dayNumber(testDate) - 1 - dayNumber(day)) / 7)))
    expect([...weeks].toSorted()).toEqual([0, 1, 2, 3])
  })

  test("a Mock day gets the Mock's minutes and the week's other study days share the rest", () => {
    const plan = buildPlan(inputs({ testDate }))
    const mockDay = plan.days.find((day) => day.items.some((item) => item.kind === "mock"))!
    expect(mockDay.minutes).toBe(MockMinutes)
    const week = Math.floor((dayNumber(testDate) - 1 - dayNumber(mockDay.day)) / 7)
    const others = plan.days.filter((day) =>
      day.day !== mockDay.day && !day.off && Math.floor((dayNumber(testDate) - 1 - dayNumber(day.day)) / 7) === week
    )
    // Six study days of 100 minutes: 600 - 145 = 455 over the other five.
    for (const day of others) expect(day.minutes).toBe(91)
  })

  test("only as many Mocks as the start check allows; the rest are dropped with the reason", () => {
    const plan = buildPlan(inputs({ testDate }, { allowed: { quant: 2, verbal: 5, di: 5 } }))
    const mocks = plan.days.flatMap((day) => day.items.filter((item) => item.kind === "mock").map(() => day.day))
    expect(mocks.length).toBe(2)
    // The ones kept are the latest, nearest the test.
    const dropped = plan.dropped.filter((item) => item.kind === "mock")
    expect(dropped.length).toBe(2)
    for (const item of dropped) expect(dayNumber(item.day)).toBeLessThan(Math.min(...mocks.map(dayNumber)))
    expect(dropped[0]!.reason).toContain("only 2 more Mocks")
  })

  test("the Diagnostic is the first Mock, on the first study day, and counts against the start check", () => {
    const plan = buildPlan(inputs({ testDate }, { diagnostic: "pending", allowed: { quant: 2, verbal: 2, di: 2 } }))
    const first = itemsOn(plan, Monday)
    expect(first[0]).toMatchObject({ kind: "mock", diagnostic: true, minutes: MockMinutes })
    expect(plan.days.flatMap((day) => day.items).filter((item) => item.kind === "mock").length).toBe(2)
  })

  test("weekly time under a Mock gives each Mock week the three Sectionals, and says why", () => {
    const plan = buildPlan(inputs({ testDate, weeklyMinutes: 120, daysOff: [] }))
    expect(plan.days.flatMap((day) => day.items).some((item) => item.kind === "mock")).toBe(false)
    const sectionals = plan.days.flatMap((day) => day.items.filter((item) => item.kind === "sectional"))
    expect(sectionals.length).toBe(12)
    expect(new Set(sectionals.map((item) => item.section))).toEqual(new Set(["quant", "verbal", "di"]))
    expect(plan.notes.join(" ")).toContain("Sectionals")
    for (const day of plan.days.filter((each) => each.items.some((item) => item.kind === "sectional"))) {
      expect(day.minutes).toBe(SectionalMinutes)
    }
  })

  test("a Diagnostic under a Mock's time is the three Sectionals over up to 3 days", () => {
    const plan = buildPlan(inputs({ weeklyMinutes: 140, daysOff: [] }, { diagnostic: "pending" }))
    const diagnostic = plan.days.flatMap((day) => day.items.filter((item) => item.diagnostic).map((item) => [day.day, item.section]))
    expect(diagnostic).toEqual([[Monday, "quant"], [plus(Monday, 1), "verbal"], [plus(Monday, 2), "di"]])
  })
})

describe("Each day's items", () => {
  test("due Retries take at most a fifth of the day, and the rest wait for the next day", () => {
    const retries = Array.from({ length: 12 }, (_, index) => ({ day: Monday, timed: false, minutes: 3, priority: index % 2 === 0 ? 0.3 : 0 }))
    const plan = buildPlan(inputs({}, { retries }))
    const monday = itemsOn(plan, Monday).find((item) => item.kind === "retries")!
    // 100 minutes: at most 20 for Retries, 6 of them.
    expect(monday).toMatchObject({ count: 6, minutes: 18, timed: false })
    expect(itemsOn(plan, plus(Monday, 1)).find((item) => item.kind === "retries")).toMatchObject({ count: 6 })
  })

  test("untimed and timed Retries are two items, each a set of its own", () => {
    const retries = [
      { day: Monday, timed: false, minutes: 3, priority: 0 },
      { day: Monday, timed: true, minutes: 4, priority: 0.5 }
    ]
    const monday = itemsOn(buildPlan(inputs({}, { retries })), Monday).filter((item) => item.kind === "retries")
    expect(monday.map((item) => [item.timed, item.count, item.minutes])).toEqual([[true, 1, 4], [false, 1, 3]])
  })

  test("items follow their Weak Area's Priority and items for none come last", () => {
    const plan = buildPlan(inputs())
    const monday = itemsOn(plan, Monday)
    const priorities = monday.map((item) => item.weakArea?.priority ?? -1)
    expect(priorities).toEqual(priorities.toSorted((a, b) => b - a))
    expect(monday.at(-1)!.weakArea).toBeNull()
  })

  test("remedies follow the Mistake Types", () => {
    const plan = buildPlan(inputs())
    const all = plan.days.flatMap((day) => day.items)
    const percents = all.find((item) => item.weakArea?.id === "quant.percents")!
    expect(percents.practice).toMatchObject({ skill: "quant.percents", timed: false })
    const weaken = all.find((item) => item.weakArea?.id === "verbal.cr-weaken")!
    expect(weaken.practice).toMatchObject({ questionType: "verbal.cr-weaken", timed: true })
    const tables = all.find((item) => item.weakArea?.id === "di.tables")!
    expect(tables.practice).toMatchObject({ section: "di", trapPattern: "trap.extreme" })
  })

  test("practice is pitched near theta - 0.69, at Medium before a Section has 20 Rated Responses", () => {
    const pitched = buildPlan(inputs())
    const percents = pitched.days.flatMap((day) => day.items).find((item) => item.weakArea?.id === "quant.percents")!
    expect(percents.practice!.near).toBeCloseTo(-0.89, 5)
    const mixed = pitched.days.flatMap((day) => day.items).find((item) => item.kind === "practice" && item.weakArea === null && item.practice!.section === "verbal")!
    expect(mixed.practice!.near).toBeCloseTo(0.4 - 0.69, 5)
    const cold = buildPlan(inputs({}, { sections: sections(0.4, 12), diagnostic: "skipped" }))
    for (const item of cold.days.flatMap((day) => day.items)) {
      if (item.practice !== null) expect(item.practice.near).toBe(0)
    }
  })

  test("work done today leaves only the rest of the day to plan", () => {
    const plan = buildPlan(inputs({}, { doneToday: 70 }))
    expect(minutesOf(itemsOn(plan, Monday))).toBeLessThanOrEqual(30)
  })

  test("a Weak Area set that cannot fit even 5 Questions is dropped with the reason", () => {
    const plan = buildPlan(inputs({ weeklyMinutes: 60, daysOff: [0, 6] }))
    expect(plan.dropped.some((item) => item.weakArea !== null && item.reason.includes("No time"))).toBe(true)
  })
})

describe("Lessons in the plan", () => {
  const lesson = (subject: string, done = { done: false, methodsDone: false }) => ({
    subject,
    lessonId: `lesson-${subject}`,
    minutes: 25,
    methodsMinutes: 6,
    ...done
  })
  const weakAreas = (topMistake: string) => [
    { kind: "skill" as const, id: "quant.percents", name: "Percents", section: "quant", priority: 0.3, ability: -0.2, slow: false, topMistake, topTrap: null }
  ]
  const lessonsIn = (plan: ReturnType<typeof buildPlan>) => plan.days.flatMap((day) => day.items.filter((item) => item.kind === "lesson"))

  test("a Concept gap gets the whole Lesson once, before the Weak Area's set that day", () => {
    const plan = buildPlan(inputs({}, { weakAreas: weakAreas("concept-gap"), lessons: [lesson("quant.percents")] }))
    const planned = lessonsIn(plan)
    expect(planned.map((item) => [item.day, item.lesson, item.minutes])).toEqual([
      [Monday, { id: "lesson-quant.percents", subject: "quant.percents", part: "whole" }, 25]
    ])
    const monday = itemsOn(plan, Monday)
    const at = monday.findIndex((item) => item.kind === "lesson")
    expect(monday[at + 1]).toMatchObject({ kind: "practice", weakArea: { id: "quant.percents" } })
  })

  test("a Wrong approach gets the Lesson's methods; a Lesson done, or a Weak Area with another Mistake Type, gets none", () => {
    const methods = buildPlan(inputs({}, { weakAreas: weakAreas("wrong-approach"), lessons: [lesson("quant.percents")] }))
    expect(lessonsIn(methods).map((item) => [item.lesson!.part, item.minutes])).toEqual([["methods", 6]])
    const read = buildPlan(
      inputs({}, { weakAreas: weakAreas("wrong-approach"), lessons: [lesson("quant.percents", { done: false, methodsDone: true })] })
    )
    expect(lessonsIn(read)).toEqual([])
    const done = buildPlan(
      inputs({}, { weakAreas: weakAreas("concept-gap"), lessons: [lesson("quant.percents", { done: true, methodsDone: true })] })
    )
    expect(lessonsIn(done)).toEqual([])
    const trap = buildPlan(inputs({}, { weakAreas: weakAreas("calculation-slip"), lessons: [lesson("quant.percents")] }))
    expect(lessonsIn(trap)).toEqual([])
    const none = buildPlan(inputs({}, { weakAreas: weakAreas("concept-gap"), lessons: [] }))
    expect(lessonsIn(none)).toEqual([])
  })

  test("a Lesson no study day has room for is dropped with the reason", () => {
    const plan = buildPlan(inputs({}, { weakAreas: weakAreas("concept-gap"), lessons: [{ ...lesson("quant.percents"), minutes: 400 }] }))
    expect(lessonsIn(plan)).toEqual([])
    expect(plan.dropped.filter((item) => item.kind === "lesson").map((item) => item.reason)).toEqual([
      "No study day in the plan has room for its 400 minutes."
    ])
  })
})

describe("Study Plan properties", () => {
  const settingsArb = fc.record({
    testDate: fc.option(fc.integer({ min: -3, max: 120 }).map((days) => plus(Monday, days)), { nil: null }),
    targetTotal: fc.constant(null),
    weeklyMinutes: fc.integer({ min: 60, max: 3600 }),
    daysOff: fc.uniqueArray(fc.integer({ min: 0, max: 6 }), { maxLength: 6 })
  })
  const stateArb = fc.record({
    ability: fc.option(fc.double({ min: -3, max: 3, noNaN: true }), { nil: null }),
    rated: fc.integer({ min: 0, max: 80 }),
    diagnostic: fc.constantFrom("done", "pending", "skipped", "blocked") as fc.Arbitrary<PlanInputs["state"]["diagnostic"]>,
    allowed: fc.integer({ min: 0, max: 6 }),
    retries: fc.array(fc.record({ offset: fc.integer({ min: 0, max: 13 }), minutes: fc.integer({ min: 1, max: 6 }), priority: fc.double({ min: 0, max: 1, noNaN: true }) }), { maxLength: 30 }),
    doneToday: fc.integer({ min: 0, max: 200 }),
    // A Lesson on the Concept gap Weak Area, Percents, of any length.
    lessonMinutes: fc.option(fc.integer({ min: 1, max: 300 }), { nil: null })
  })
  interface StateSample {
    readonly ability: number | null
    readonly rated: number
    readonly diagnostic: PlanInputs["state"]["diagnostic"]
    readonly allowed: number
    readonly retries: ReadonlyArray<{ readonly offset: number; readonly minutes: number; readonly priority: number }>
    readonly doneToday: number
    readonly lessonMinutes: number | null
  }
  const toInputs = (settings: PlanInputs["settings"], state: StateSample) =>
    inputs(settings, {
      sections: sections(state.ability, state.rated),
      diagnostic: state.diagnostic,
      diagnosticSections: state.diagnostic === "pending" ? ["quant", "verbal", "di"] : [],
      allowed: { quant: state.allowed, verbal: state.allowed, di: state.allowed },
      retries: state.retries.map((retry) => ({ day: plus(Monday, retry.offset), timed: retry.offset % 2 === 0, minutes: retry.minutes, priority: retry.priority })),
      doneToday: state.doneToday,
      lessons: state.lessonMinutes === null
        ? []
        : [{ subject: "quant.percents", lessonId: "lesson-1", minutes: state.lessonMinutes, methodsMinutes: 5, done: false, methodsDone: false }]
    })

  test("the same inputs and state give the same plan", () => {
    fc.assert(fc.property(settingsArb, stateArb, (settings, state) => {
      expect(buildPlan(toInputs(settings, state))).toEqual(buildPlan(toInputs(settings, state)))
    }), { numRuns: 200 })
  })

  test("no Study Day other than a Mock day is given more minutes than it has", () => {
    fc.assert(fc.property(settingsArb, stateArb, (settings, state) => {
      const plan = buildPlan(toInputs(settings, state))
      for (const day of plan.days) {
        if (day.off) expect(day.items).toEqual([])
        const mock = day.items.some((item) => item.kind === "mock" || item.kind === "sectional")
        if (!mock) expect(minutesOf(day.items)).toBeLessThanOrEqual(day.minutes)
        const retries = day.items.filter((item) => item.kind === "retries")
        expect(minutesOf(retries)).toBeLessThanOrEqual(Math.floor(day.minutes / 5))
      }
    }), { numRuns: 300 })
  })

  test("Mocks keep to the start check and to 3 days before the test", () => {
    fc.assert(fc.property(settingsArb, stateArb, (settings, state) => {
      const plan = buildPlan(toInputs(settings, state))
      const mocks = plan.days.flatMap((day) => day.items.filter((item) => item.kind === "mock").map(() => day.day))
      expect(mocks.length).toBeLessThanOrEqual(state.allowed)
      if (settings.testDate !== null) {
        for (const day of mocks) expect(dayNumber(day)).toBeLessThanOrEqual(dayNumber(settings.testDate) - 3)
      }
    }), { numRuns: 300 })
  })
})
