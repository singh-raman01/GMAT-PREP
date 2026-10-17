import {
  buildPlan,
  dayNumber,
  dayOfNumber,
  type Plan,
  type PlanInputs,
  type PlannedItem,
  type TakenEvent
} from "../src/server/plans/build.ts"

// A Learner following the Study Plan day by day, built as Plans.ts builds
// it: a new version at each Study Day and after each Mock or Sectional, and
// optionally after every item too, as a settings save or a Section reaching
// 20 Rated Responses would. The snapshot is what Plans.ts gives the builder:
// the Mocks and Sectionals of the last 7 Study Days by the day each started,
// and today's plan items started or done under any version. The Learner can
// also miss days, take Mocks and Sectionals from their own pages, and do a
// day's items last first. Written for the second review of ticket 16.

const pace = { quant: 129_000, verbal: 117_000, di: 135_000 }
export const Sections = ["quant", "verbal", "di"] as const

export const area = (n: number) => ({
  kind: "skill" as const,
  id: `quant.area-${n}`,
  name: `Area ${n}`,
  section: (["quant", "verbal", "di"] as const)[n % 3] ?? "quant",
  priority: 1 - n / 10,
  ability: -0.2,
  slow: false,
  topMistake: "concept-gap",
  topTrap: null
})

export interface SimSettings {
  readonly testDate: string | null
  readonly weeklyMinutes: number
  readonly daysOff: ReadonlyArray<number>
}

export interface SimOptions {
  readonly start: string
  // The last day simulated, inclusive; the day before the test by default.
  readonly until?: string
  readonly allowed?: number
  readonly diagnostic?: "pending" | "done" | "skipped"
  // Build again after every item, not only after Mocks and Sectionals.
  readonly rebuildEachItem?: boolean
  // Days the Learner does nothing at all (missed).
  readonly missed?: ReadonlySet<string>
  // Days the Learner takes a Sectional of this Section outside the plan,
  // first thing in the day.
  readonly outside?: ReadonlyMap<string, string>
  // Weak Areas in the snapshot.
  readonly weakAreas?: number
  // Days the Learner takes a Mock outside the plan, first thing in the day.
  readonly outsideMocks?: ReadonlySet<string>
  // Days the Learner does today's items last first.
  readonly reversed?: ReadonlySet<string>
}

export interface DayRecord {
  readonly day: string
  // The allotted minutes of each version built that day, in order.
  readonly allotted: Array<number>
  readonly done: Array<PlannedItem>
  readonly outsideMinutes: number
  readonly phase: string
  readonly builds: number
}

export interface SimResult {
  readonly days: ReadonlyArray<DayRecord>
  readonly taken: ReadonlyArray<TakenEvent>
  readonly firstPlan: Plan
  readonly plans: ReadonlyArray<{ readonly day: string; readonly plan: Plan; readonly takenCount: number }>
}

const isEvent = (item: PlannedItem) => item.kind === "mock" || item.kind === "sectional"

export const simulate = (settings: SimSettings, options: SimOptions): SimResult => {
  const start = dayNumber(options.start)
  const test = settings.testDate === null ? undefined : dayNumber(settings.testDate)
  const until = options.until !== undefined ? dayNumber(options.until) : test !== undefined ? test - 1 : start + 27
  const allowed: Record<string, number> = { quant: options.allowed ?? 9, verbal: options.allowed ?? 9, di: options.allowed ?? 9 }
  let diagnostic: PlanInputs["state"]["diagnostic"] = options.diagnostic ?? "pending"
  let diagnosticSections: Array<string> = diagnostic === "pending" ? [...Sections] : []
  const taken: Array<TakenEvent> = []
  const records: Array<DayRecord> = []
  const plans: Array<{ day: string; plan: Plan; takenCount: number }> = []
  let firstPlan: Plan | undefined
  const weakAreas = Array.from({ length: options.weakAreas ?? 6 }, (_, n) => area(n))

  for (let day = start; day <= until; day += 1) {
    const today = dayOfNumber(day)
    const todayWork: Array<PlannedItem> = []
    let outsideMinutes = 0
    const build = () => {
      const plan = buildPlan({
        settings: { testDate: settings.testDate, targetTotal: null, weeklyMinutes: settings.weeklyMinutes, daysOff: [...settings.daysOff] },
        state: {
          today,
          start: options.start,
          sections: Sections.map((id) => ({ id, ability: 0.4, rated: 40, paceMs: pace[id] })),
          weakAreas,
          retries: [],
          allowed: { ...allowed },
          diagnostic,
          diagnosticSections: [...diagnosticSections],
          taken: taken.filter((event) => dayNumber(event.day) >= day - 6),
          todayWork: [...todayWork]
        }
      })
      plans.push({ day: today, plan, takenCount: taken.length })
      firstPlan ??= plan
      return plan
    }
    const takeEvent = (item: PlannedItem) => {
      taken.push({ day: today, kind: item.kind === "mock" ? "mock" : "sectional", section: item.section, diagnostic: item.diagnostic, fromPlan: true })
      if (item.kind === "mock") for (const section of Sections) allowed[section] = (allowed[section] ?? 0) - 1
      else allowed[item.section!] = (allowed[item.section!] ?? 0) - 1
      if (item.kind === "mock") {
        diagnostic = "done"
        diagnosticSections = []
      } else if (item.diagnostic) {
        diagnosticSections = diagnosticSections.filter((section) => section !== item.section)
        if (diagnosticSections.length === 0) diagnostic = "done"
      }
    }
    let plan = build()
    const allotted: Array<number> = []
    const todayDay = () => plan.days.find((each) => each.day === today)
    allotted.push(todayDay()?.minutes ?? 0)
    let builds = 1
    if (options.outsideMocks?.has(today) === true) {
      taken.push({ day: today, kind: "mock", section: null, diagnostic: false, fromPlan: false })
      for (const section of Sections) allowed[section] = (allowed[section] ?? 0) - 1
      diagnostic = "done"
      diagnosticSections = []
      outsideMinutes += 145
      plan = build()
      builds += 1
      allotted.push(todayDay()?.minutes ?? 0)
    }
    const outsideSection = options.outside?.get(today)
    if (outsideSection !== undefined) {
      taken.push({ day: today, kind: "sectional", section: outsideSection, diagnostic: false, fromPlan: false })
      allowed[outsideSection] = (allowed[outsideSection] ?? 0) - 1
      outsideMinutes += 45
      plan = build()
      builds += 1
      allotted.push(todayDay()?.minutes ?? 0)
    }
    if (!(options.missed?.has(today) ?? false)) {
      // Do today's items in order; build again after each event (or each
      // item), and carry on with the new version's items.
      const order = (items: ReadonlyArray<PlannedItem>) => (options.reversed?.has(today) === true ? [...items].reverse() : [...items])
      let queue = order(todayDay()?.items ?? [])
      let guard = 0
      while (queue.length > 0 && guard < 50) {
        guard += 1
        const next = queue.shift()!
        todayWork.push(next)
        if (isEvent(next)) takeEvent(next)
        if (isEvent(next) || options.rebuildEachItem === true) {
          plan = build()
          builds += 1
          allotted.push(todayDay()?.minutes ?? 0)
          queue = order(todayDay()?.items ?? [])
        }
      }
    }
    records.push({ day: today, allotted, done: todayWork, outsideMinutes, phase: todayDay()?.phase ?? "none", builds })
  }
  return { days: records, taken, firstPlan: firstPlan!, plans }
}

// What a simulation broke, in words.
export const problemsOf = (settings: SimSettings, result: SimResult, options: { readonly allowed: number }) => {
  const problems: Array<string> = []
  const test = settings.testDate === null ? undefined : dayNumber(settings.testDate)
  const mockMode = settings.weeklyMinutes >= 145
  const mocks = result.taken.filter((event) => event.kind === "mock").map((event) => dayNumber(event.day))
  for (let i = 1; i < mocks.length; i += 1) {
    if (mocks[i]! - mocks[i - 1]! < 3) problems.push(`Mocks taken ${dayOfNumber(mocks[i - 1]!)} and ${dayOfNumber(mocks[i]!)} are under 3 days apart`)
  }
  if (test !== undefined) {
    for (const day of mocks) if (day > test - 3) problems.push(`Mock taken ${dayOfNumber(day)} is under 3 days before the test`)
    const weekOf = (day: number) => Math.floor((test - 1 - day) / 7)
    if (mockMode) {
      const byWeek = Map.groupBy(result.taken.filter((event) => event.kind === "mock" && !event.diagnostic), (event) => weekOf(dayNumber(event.day)))
      for (const [week, events] of byWeek) {
        if (week >= 4) problems.push(`Mock outside the Mock weeks on ${events.map((each) => each.day).join(", ")}`)
        if (events.length > 1) problems.push(`week ${week} has ${events.length} Mocks: ${events.map((each) => each.day).join(", ")}`)
      }
    } else {
      const sectionals = result.taken.filter((event) => event.kind === "sectional" && !event.diagnostic)
      const byWeek = Map.groupBy(sectionals, (event) => weekOf(dayNumber(event.day)))
      for (const [week, events] of byWeek) {
        const sections = events.map((each) => each.section)
        if (new Set(sections).size !== sections.length) problems.push(`week ${week} repeats a Section: ${events.map((each) => `${each.day} ${each.section}`).join(", ")}`)
      }
    }
  }
  const byDay = Map.groupBy(result.taken, (event) => event.day)
  for (const [day, events] of byDay) if (events.length > 1) problems.push(`${day} has ${events.length} Mocks or Sectionals taken`)
  const mocksTaken = result.taken.filter((event) => event.kind === "mock").length
  if (mocksTaken > options.allowed) problems.push(`${mocksTaken} Mocks taken, more than the ${options.allowed} allowed`)
  for (const record of result.days) {
    const minutes = record.done.reduce((sum, each) => sum + each.minutes, 0) + record.outsideMinutes
    const final = record.allotted.at(-1)!
    const isMockDay = record.done.some((each) => each.kind === "mock")
    if (minutes > final && !isMockDay) problems.push(`${record.day}: ${minutes} minutes done against ${final} allotted (${record.allotted.join(" -> ")})`)
  }
  return problems
}

// Each week's minutes worked, by weeks running back from the test (or on
// from the start).
export const weekMinutes = (settings: SimSettings, result: SimResult, start: string) => {
  const test = settings.testDate === null ? undefined : dayNumber(settings.testDate)
  const weekOf = (day: number) => (test === undefined ? Math.floor((day - dayNumber(start)) / 7) : Math.floor((test - 1 - day) / 7))
  const weeks = new Map<number, number>()
  for (const record of result.days) {
    const week = weekOf(dayNumber(record.day))
    const minutes = record.done.reduce((sum, each) => sum + each.minutes, 0) + record.outsideMinutes
    weeks.set(week, (weeks.get(week) ?? 0) + minutes)
  }
  return weeks
}
