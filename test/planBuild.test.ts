import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import {
  buildPlan,
  dayNumber,
  dayOfNumber,
  MockMinutes,
  type PlanInputs,
  type PlannedItem,
  SectionalMinutes,
  type TakenEvent
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
    taken: [],
    todayWork: [],
    ...state,
    start: state.start ?? state.today ?? Monday,
    // A pending Diagnostic has every Section still to take unless said.
    diagnosticSections: state.diagnosticSections ?? (state.diagnostic === "pending" ? ["quant", "verbal", "di"] : [])
  }
})

const itemsOn = (plan: ReturnType<typeof buildPlan>, day: string) => plan.days.find((each) => each.day === day)?.items ?? []
const minutesOf = (items: ReadonlyArray<PlannedItem>) => items.reduce((sum, item) => sum + item.minutes, 0)

// A plan item done today, as the plan made it.
const doneItem = (day: string, fields: Partial<PlannedItem> = {}): PlannedItem => ({
  day,
  kind: "practice",
  diagnostic: false,
  timed: true,
  section: null,
  count: null,
  practice: { section: "quant", timed: true, size: 10, near: 0 },
  weakArea: null,
  remedy: null,
  minutes: 26,
  ...fields
})
const takenOn = (day: string, kind: TakenEvent["kind"], fields: Partial<TakenEvent> = {}): TakenEvent => ({
  day,
  kind,
  section: null,
  diagnostic: false,
  fromPlan: false,
  ...fields
})

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
    const plan = buildPlan(inputs({}, { todayWork: [doneItem(Monday, { minutes: 70 })] }))
    expect(minutesOf(itemsOn(plan, Monday))).toBeLessThanOrEqual(30)
  })

  test("a Weak Area set that cannot fit even 5 Questions is dropped with the reason", () => {
    const plan = buildPlan(inputs({ weeklyMinutes: 60, daysOff: [0, 6] }))
    expect(plan.dropped.some((item) => item.weakArea !== null && /No time left|under the/.test(item.reason))).toBe(true)
  })
})

describe("Making the plan again", () => {
  // A plan made at each Study Day and after each Mock carries on from what
  // was taken and done (decisions 85, 86 and 90).

  test("the day after a Diagnostic Mock in a Mock week plans no other Mock that week, nor within 3 days", () => {
    // The test is 23 days on, so Monday is in the 4th week before it.
    const testDate = plus(Monday, 23)
    const first = buildPlan(inputs({ testDate }, { diagnostic: "pending" }))
    expect(itemsOn(first, Monday)[0]).toMatchObject({ kind: "mock", diagnostic: true })
    const tuesday = plus(Monday, 1)
    const next = buildPlan(inputs({ testDate }, {
      today: tuesday,
      start: Monday,
      taken: [takenOn(Monday, "mock", { diagnostic: true })]
    }))
    const mocks = next.days.flatMap((day) => day.items.filter((item) => item.kind === "mock").map(() => day.day))
    expect(mocks.length).toBe(3)
    for (const day of mocks) expect(dayNumber(day)).toBeGreaterThanOrEqual(dayNumber(Monday) + 3)
    const weekOf = (day: string) => Math.floor((dayNumber(testDate) - 1 - dayNumber(day)) / 7)
    expect(mocks.some((day) => weekOf(day) === weekOf(Monday))).toBe(false)
  })

  test("a Mock taken early in its week is that week's Mock", () => {
    const testDate = plus(Monday, 47)
    // Week 1 before the test runs from test-14 to test-8.
    const taken = plus(testDate, -14)
    const next = buildPlan(inputs({ testDate }, { today: plus(taken, 2), start: Monday, taken: [takenOn(taken, "mock")] }))
    const weekOf = (day: string) => Math.floor((dayNumber(testDate) - 1 - dayNumber(day)) / 7)
    const mocks = next.days.flatMap((day) => day.items.filter((item) => item.kind === "mock").map(() => day.day))
    expect(mocks.filter((day) => weekOf(day) === weekOf(taken))).toEqual([])
    expect(mocks.length).toBe(1)
  })

  test("under a Mock's time, a Mock week's Sectional taken is not planned again that week", () => {
    const testDate = plus(Monday, 20)
    const settings = { testDate, weeklyMinutes: 120, daysOff: [] }
    const first = buildPlan(inputs(settings))
    const lastWeek = first.days.flatMap((day) => day.items.filter((item) => item.kind === "sectional").map((item) => [day.day, item.section]))
      .filter(([day]) => dayNumber(day!) >= dayNumber(testDate) - 7)
    expect(lastWeek).toEqual([[plus(testDate, -5), "quant"], [plus(testDate, -4), "verbal"], [plus(testDate, -3), "di"]])
    const next = buildPlan(inputs(settings, {
      today: plus(testDate, -4),
      start: Monday,
      taken: [takenOn(plus(testDate, -5), "sectional", { section: "quant" })]
    }))
    const planned = next.days.flatMap((day) => day.items.filter((item) => item.kind === "sectional").map((item) => [day.day, item.section]))
    expect(planned).toEqual([[plus(testDate, -4), "verbal"], [plus(testDate, -3), "di"]])
    expect(next.dropped.filter((item) => item.kind === "sectional")).toEqual([])
  })

  test("the Weak Area phase gives way to mixed practice when the plan is made each day", () => {
    const testDate = plus(Monday, 90)
    const firstMockWeek = dayNumber(testDate) - 28
    const phases: Array<string> = []
    for (let day = dayNumber(Monday); day < firstMockWeek; day += 1) {
      const plan = buildPlan(inputs({ testDate, daysOff: [] }, { today: dayOfNumber(day), start: Monday }))
      phases.push(plan.days[0]!.phase)
    }
    // 62 days before the Mock weeks: two thirds, 42 days, of Weak Area work.
    expect(phases.filter((phase) => phase === "weak-areas").length).toBe(42)
    expect(phases.filter((phase) => phase === "mixed").length).toBe(20)
    expect(phases.indexOf("mixed")).toBe(42)
  })

  test("the Weak Areas worked on and the mixed Sections turn from day to day when the plan is made each day", () => {
    const areas = Array.from({ length: 6 }, (_, n) => ({
      kind: "skill" as const,
      id: `quant.area-${n}`,
      name: `Area ${n}`,
      section: "quant",
      priority: 1 - n / 10,
      ability: -0.2,
      slow: false,
      topMistake: "concept-gap",
      topTrap: null
    }))
    const worked: Array<ReadonlyArray<string>> = []
    const firstMixed: Array<string> = []
    for (let offset = 0; offset < 6; offset += 1) {
      const today = plus(Monday, offset)
      const plan = buildPlan(inputs({ daysOff: [] }, { today, start: Monday, weakAreas: areas }))
      const items = plan.days[0]!.items
      worked.push(items.flatMap((item) => (item.weakArea === null ? [] : [item.weakArea.id])))
      firstMixed.push(items.find((item) => item.kind === "practice" && item.weakArea === null)?.practice?.section ?? "none")
    }
    // Two a day in the Weak Area week, round the six.
    expect(worked.slice(0, 3).flat().toSorted()).toEqual(areas.map((area) => area.id).toSorted())
    expect(new Set(firstMixed).size).toBe(3)
  })

  test("without a test date the phases take turns a week at a time from the plan's start", () => {
    const phaseOn = (offset: number) => buildPlan(inputs({ daysOff: [] }, { today: plus(Monday, offset), start: Monday })).days[0]!.phase
    expect([0, 6, 7, 13, 14, 20, 21].map(phaseOn)).toEqual(["weak-areas", "weak-areas", "mixed", "mixed", "weak-areas", "weak-areas", "mixed"])
  })

  test("a week's share stays the same when the plan is made again after its Mock", () => {
    const testDate = plus(Monday, 47)
    const first = buildPlan(inputs({ testDate }, { start: Monday }))
    const mockDay = first.days.find((day) => day.items.some((item) => item.kind === "mock"))!
    const weekOf = (day: string) => Math.floor((dayNumber(testDate) - 1 - dayNumber(day)) / 7)
    const shares = (plan: ReturnType<typeof buildPlan>) =>
      plan.days.filter((day) => !day.off && weekOf(day.day) === weekOf(mockDay.day) && day.day > mockDay.day).map((day) => day.minutes)
    const after = buildPlan(inputs({ testDate }, { today: plus(mockDay.day, 1), start: Monday, taken: [takenOn(mockDay.day, "mock")] }))
    expect(shares(after)).toEqual(shares(first))
  })
})

describe("Making the plan again during a day", () => {
  test("after one Diagnostic Sectional today, the rest start on the next study day", () => {
    const plan = buildPlan(inputs({ weeklyMinutes: 140, daysOff: [] }, {
      diagnostic: "pending",
      diagnosticSections: ["verbal", "di"],
      taken: [takenOn(Monday, "sectional", { section: "quant", diagnostic: true })],
      todayWork: [doneItem(Monday, { kind: "sectional", diagnostic: true, section: "quant", practice: null, minutes: 45 })]
    }))
    const today = plan.days[0]!
    expect(today.items).toEqual([])
    expect(today.minutes).toBe(SectionalMinutes)
    const diagnostic = plan.days.flatMap((day) => day.items.filter((item) => item.diagnostic).map((item) => [day.day, item.section]))
    expect(diagnostic).toEqual([[plus(Monday, 1), "verbal"], [plus(Monday, 2), "di"]])
  })

  test("a Weak Area worked on today is not planned again today, and the next mixed Section follows today's", () => {
    const before = buildPlan(inputs({ daysOff: [] }))
    const first = itemsOn(before, Monday).find((item) => item.weakArea !== null)!
    const mixed = itemsOn(before, Monday).find((item) => item.kind === "practice" && item.weakArea === null)!
    const after = buildPlan(inputs({ daysOff: [] }, { todayWork: [first, mixed] }))
    const today = itemsOn(after, Monday)
    expect(today.filter((item) => item.weakArea?.id === first.weakArea!.id)).toEqual([])
    expect(today.filter((item) => item.weakArea !== null).length).toBe(1)
    const next = today.find((item) => item.kind === "practice" && item.weakArea === null)
    if (next !== undefined) expect(next.practice!.section).not.toBe(mixed.practice!.section)
    expect(minutesOf(today) + first.minutes + mixed.minutes).toBeLessThanOrEqual(before.days[0]!.minutes)
  })

  test("a Mock that would land on a day with work done goes to the next study day", () => {
    const plan = buildPlan(inputs({}, { diagnostic: "pending", todayWork: [doneItem(Monday, { kind: "retries", practice: null, count: 3, minutes: 9 })] }))
    expect(itemsOn(plan, Monday).some((item) => item.kind === "mock")).toBe(false)
    expect(itemsOn(plan, plus(Monday, 1))[0]).toMatchObject({ kind: "mock", diagnostic: true })
  })

  test("Retries done today count against the day's fifth for them", () => {
    const retries = Array.from({ length: 12 }, () => ({ day: Monday, timed: false, minutes: 3, priority: 0 }))
    const plan = buildPlan(inputs({}, { retries, todayWork: [doneItem(Monday, { kind: "retries", practice: null, count: 4, minutes: 12 })] }))
    // 100 minutes: 20 for Retries, 12 of them done.
    expect(itemsOn(plan, Monday).find((item) => item.kind === "retries")).toMatchObject({ count: 2, minutes: 6 })
  })

  test("a Mock taken today leaves nothing else to plan today", () => {
    const plan = buildPlan(inputs({}, { taken: [takenOn(Monday, "mock")] }))
    expect(itemsOn(plan, Monday)).toEqual([])
  })
})

describe("Making the plan again after the second review", () => {
  test("a Sectional taken today from its own page takes its 45 minutes from today", () => {
    for (const weeklyMinutes of [120, 600]) {
      const settings = { weeklyMinutes, daysOff: [] }
      const offPlan = buildPlan(inputs(settings, { weakAreas: [], taken: [takenOn(Monday, "sectional", { section: "quant" })] }))
      const day = offPlan.days[0]!
      expect(minutesOf(day.items) + SectionalMinutes).toBeLessThanOrEqual(day.minutes)
      // Started from the plan, its minutes are in today's work, counted once.
      const fromPlan = buildPlan(inputs(settings, {
        weakAreas: [],
        taken: [takenOn(Monday, "sectional", { section: "quant", fromPlan: true })],
        todayWork: [doneItem(Monday, { kind: "sectional", section: "quant", practice: null, minutes: SectionalMinutes })]
      }))
      expect(minutesOf(fromPlan.days[0]!.items)).toBe(minutesOf(day.items))
    }
  })

  test("a Mock week's Sectional missed drops its own Section and moves no other", () => {
    // 120 minutes a week, every day a study day: the last week plans Quant,
    // Verbal and Data Insights on its last three days before the test.
    const testDate = plus(Monday, 20)
    const settings = { testDate, weeklyMinutes: 120, daysOff: [] }
    const first = buildPlan(inputs(settings, { weakAreas: [] }))
    const sectionalsOf = (plan: ReturnType<typeof buildPlan>) =>
      plan.days.flatMap((day) => day.items.filter((item) => item.kind === "sectional").map((item) => `${day.day} ${item.section}`))
    expect(sectionalsOf(first).slice(-3)).toEqual([`${plus(testDate, -5)} quant`, `${plus(testDate, -4)} verbal`, `${plus(testDate, -3)} di`])
    // Quant's day is missed: the next day keeps Verbal, and Quant is dropped.
    const next = buildPlan(inputs(settings, { today: plus(testDate, -4), start: Monday, weakAreas: [] }))
    expect(sectionalsOf(next)).toEqual([`${plus(testDate, -4)} verbal`, `${plus(testDate, -3)} di`])
    expect(next.dropped.filter((item) => item.kind === "sectional").map((item) => [item.section, item.reason])).toEqual([
      ["quant", "The week has too few study days left before the test for all three Sectionals."]
    ])
  })

  test("Mock weeks are placed from the test back, so studying on weekends gets all four Mocks", () => {
    const weekends = { weeklyMinutes: 600, daysOff: [1, 2, 3, 4, 5] }
    for (let offset = 36; offset < 42; offset += 1) {
      const testDate = plus(Monday, offset)
      const plan = buildPlan(inputs({ ...weekends, testDate }, { weakAreas: [] }))
      const mocks = plan.days.filter((day) => day.items.some((item) => item.kind === "mock")).map((day) => dayNumber(day.day))
      expect([testDate, mocks.length]).toEqual([testDate, 4])
      for (let index = 1; index < mocks.length; index += 1) expect(mocks[index]! - mocks[index - 1]!).toBeGreaterThanOrEqual(3)
    }
    // A test on a Monday leaves its last week no study day 3 days before it:
    // that week's Mock is listed as dropped, with the reason.
    const monday = buildPlan(inputs({ ...weekends, testDate: plus(Monday, 35) }, { weakAreas: [] }))
    expect(monday.days.filter((day) => day.items.some((item) => item.kind === "mock"))).toHaveLength(3)
    expect(monday.dropped.filter((item) => item.kind === "mock").map((item) => item.reason)).toEqual([
      "No study day in its week falls at least 3 days before the test."
    ])
  })

  test("a mixed set done today takes its Section's next place in the turn", () => {
    const state = { weakAreas: [], diagnostic: "done" as const }
    const settings = { weeklyMinutes: 900, daysOff: [] }
    const before = buildPlan(inputs(settings, state))
    const planned = before.days[0]!.items.map((item) => item.practice?.section)
    expect(planned).toEqual(["quant", "verbal", "di", "quant", "verbal"])
    // The Verbal set is done first; the plan made again keeps the turn.
    const verbal = before.days[0]!.items[1]!
    const after = buildPlan(inputs(settings, { ...state, todayWork: [verbal] }))
    expect(after.days[0]!.items.map((item) => item.practice?.section)).toEqual(["quant", "di", "quant", "verbal"])
  })
})

describe("Plan size", () => {
  test("sets and Retries are planned 4 weeks ahead; later days keep their time and their Mocks", () => {
    const testDate = plus(Monday, 120)
    const plan = buildPlan(inputs({ testDate }))
    const later = plan.days.filter((day) => dayNumber(day.day) >= dayNumber(Monday) + 28)
    expect(later.length).toBeGreaterThan(0)
    for (const day of later) for (const item of day.items) expect(["mock", "sectional"]).toContain(item.kind)
    expect(later.flatMap((day) => day.items).filter((item) => item.kind === "mock").length).toBe(4)
    expect(plan.notes.join(" ")).toContain("4 weeks ahead")
  })

  test("a Retries item holds at most 20 Retries", () => {
    const retries = Array.from({ length: 45 }, () => ({ day: Monday, timed: true, minutes: 2, priority: 0 }))
    const plan = buildPlan(inputs({ weeklyMinutes: 3600, daysOff: [] }, { retries }))
    const items = itemsOn(plan, Monday).filter((item) => item.kind === "retries")
    expect(items.map((item) => item.count)).toEqual([20, 20, 5])
  })

  test("a day too short for any set says so, and the plan says why", () => {
    const plan = buildPlan(inputs({ weeklyMinutes: 60, daysOff: [] }))
    expect(plan.notes.join(" ")).toContain("under the 12 minutes the smallest set takes")
    expect(plan.dropped.find((item) => item.weakArea !== null)!.reason).toContain("8 minutes planned, under the")
  })

  test("Retries still due on the day before the test are listed as dropped", () => {
    const testDate = plus(Monday, 2)
    const retries = Array.from({ length: 30 }, () => ({ day: Monday, timed: false, minutes: 3, priority: 0 }))
    const plan = buildPlan(inputs({ testDate }, { retries }))
    const dropped = plan.dropped.filter((item) => item.kind === "retries")
    expect(dropped.length).toBe(1)
    expect(dropped[0]!.reason).toContain("No study day is left before the test")
  })

  test("a far test date builds quickly", () => {
    const began = performance.now()
    buildPlan(inputs({ testDate: plus(Monday, 730), weeklyMinutes: 3600, daysOff: [] }))
    expect(performance.now() - began).toBeLessThan(200)
  })
})

describe("Study Plan properties", () => {
  const settingsArb = fc.record({
    testDate: fc.option(fc.integer({ min: -3, max: 120 }).map((days) => plus(Monday, days)), { nil: null }),
    targetTotal: fc.constant(null),
    weeklyMinutes: fc.integer({ min: 60, max: 3600 }),
    daysOff: fc.uniqueArray(fc.integer({ min: 0, max: 6 }), { maxLength: 6 })
  })
  const workArb = fc.record({
    kind: fc.constantFrom("practice", "retries", "sectional") as fc.Arbitrary<"practice" | "retries" | "sectional">,
    minutes: fc.integer({ min: 5, max: 60 }),
    area: fc.option(fc.constantFrom("quant.percents", "verbal.cr-weaken", "di.tables"), { nil: null })
  })
  const stateArb = fc.record({
    ability: fc.option(fc.double({ min: -3, max: 3, noNaN: true }), { nil: null }),
    rated: fc.integer({ min: 0, max: 80 }),
    diagnostic: fc.constantFrom("done", "pending", "skipped", "blocked") as fc.Arbitrary<PlanInputs["state"]["diagnostic"]>,
    allowed: fc.integer({ min: 0, max: 6 }),
    retries: fc.array(fc.record({ offset: fc.integer({ min: 0, max: 13 }), minutes: fc.integer({ min: 1, max: 6 }), priority: fc.double({ min: 0, max: 1, noNaN: true }) }), { maxLength: 30 }),
    startBack: fc.integer({ min: 0, max: 60 }),
    work: fc.array(workArb, { maxLength: 4 }),
    taken: fc.array(
      fc.record({ back: fc.integer({ min: 0, max: 6 }), mock: fc.boolean(), section: fc.constantFrom("quant", "verbal", "di"), fromPlan: fc.boolean() }),
      { maxLength: 3 }
    )
  })
  interface StateSample {
    readonly ability: number | null
    readonly rated: number
    readonly diagnostic: PlanInputs["state"]["diagnostic"]
    readonly allowed: number
    readonly retries: ReadonlyArray<{ readonly offset: number; readonly minutes: number; readonly priority: number }>
    readonly startBack: number
    readonly work: ReadonlyArray<{ readonly kind: "practice" | "retries" | "sectional"; readonly minutes: number; readonly area: string | null }>
    readonly taken: ReadonlyArray<{ readonly back: number; readonly mock: boolean; readonly section: string; readonly fromPlan: boolean }>
  }
  const toInputs = (settings: PlanInputs["settings"], state: StateSample) => {
    const work = state.work.map((each) =>
      doneItem(Monday, {
        kind: each.kind,
        minutes: each.kind === "sectional" ? 45 : each.minutes,
        section: each.kind === "sectional" ? "quant" : null,
        practice: each.kind === "practice" ? { section: "quant", timed: true, size: 10, near: 0 } : null,
        weakArea: each.kind === "practice" && each.area !== null ? { kind: "skill", id: each.area, name: each.area, priority: 0.1 } : null
      })
    )
    const taken = [
      ...state.taken.map((each) =>
        takenOn(plus(Monday, -each.back), each.mock ? "mock" : "sectional", { section: each.mock ? null : each.section, fromPlan: each.fromPlan })
      ),
      ...work.filter((each) => each.kind === "sectional").map((each) => takenOn(Monday, "sectional", { section: each.section, fromPlan: true }))
    ]
    return inputs(settings, {
      start: plus(Monday, -state.startBack),
      sections: sections(state.ability, state.rated),
      diagnostic: state.diagnostic,
      diagnosticSections: state.diagnostic === "pending" ? ["quant", "verbal", "di"] : [],
      allowed: { quant: state.allowed, verbal: state.allowed, di: state.allowed },
      retries: state.retries.map((retry) => ({ day: plus(Monday, retry.offset), timed: retry.offset % 2 === 0, minutes: retry.minutes, priority: retry.priority })),
      todayWork: work,
      taken
    })
  }

  test("the same inputs and state give the same plan", () => {
    fc.assert(fc.property(settingsArb, stateArb, (settings, state) => {
      expect(buildPlan(toInputs(settings, state))).toEqual(buildPlan(toInputs(settings, state)))
    }), { numRuns: 200 })
  })

  test("no Study Day is given more minutes than it has, today's work included", () => {
    fc.assert(fc.property(settingsArb, stateArb, (settings, state) => {
      const built = toInputs(settings, state)
      const plan = buildPlan(built)
      // Today's plan items, and the Sectionals taken today from their own page.
      const done = minutesOf(built.state.todayWork) +
        built.state.taken.filter((event) => event.day === Monday && event.kind === "sectional" && !event.fromPlan).length * 45
      const retriesDone = minutesOf(built.state.todayWork.filter((item) => item.kind === "retries"))
      for (const day of plan.days) {
        if (day.off) expect(day.items).toEqual([])
        const today = day.day === Monday
        expect(minutesOf(day.items)).toBeLessThanOrEqual(Math.max(0, day.minutes - (today ? done : 0)))
        const retries = day.items.filter((item) => item.kind === "retries")
        expect(minutesOf(retries)).toBeLessThanOrEqual(Math.max(0, Math.floor(day.minutes / 5) - (today ? retriesDone : 0)))
        // One Mock or Sectional a day at most, none today after one was taken.
        const events = day.items.filter((item) => item.kind === "mock" || item.kind === "sectional")
        expect(events.length).toBeLessThanOrEqual(1)
        if (today && built.state.taken.some((event) => event.day === Monday)) expect(events).toEqual([])
      }
    }), { numRuns: 300 })
  })

  test("Mocks keep to the start check, to 3 days before the test and to 3 days after the Mock before", () => {
    fc.assert(fc.property(settingsArb, stateArb, (settings, state) => {
      const built = toInputs(settings, state)
      const plan = buildPlan(built)
      const mocks = plan.days.flatMap((day) => day.items.filter((item) => item.kind === "mock").map(() => dayNumber(day.day)))
      expect(mocks.length).toBeLessThanOrEqual(state.allowed)
      if (settings.testDate !== null) {
        for (const day of mocks) expect(day).toBeLessThanOrEqual(dayNumber(settings.testDate) - 3)
      }
      // Each Mock week's Mock is 3 days from every other Mock, taken or
      // planned; the Diagnostic comes first, whatever was taken.
      const taken = built.state.taken.filter((event) => event.kind === "mock").map((event) => dayNumber(event.day))
      const weekMocks = plan.days.flatMap((day) => day.items.filter((item) => item.kind === "mock" && !item.diagnostic).map(() => dayNumber(day.day)))
      const diagnostic = plan.days.flatMap((day) => day.items.filter((item) => item.kind === "mock" && item.diagnostic).map(() => dayNumber(day.day)))
      for (const day of weekMocks) {
        for (const other of [...taken, ...diagnostic, ...weekMocks]) if (other !== day) expect(Math.abs(day - other)).toBeGreaterThanOrEqual(3)
      }
    }), { numRuns: 300 })
  })
})
