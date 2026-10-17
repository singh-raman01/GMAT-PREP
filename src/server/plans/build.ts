// The Study Plan builder (docs/design.md, "Study Plan, Diagnostic and Daily
// Log", decisions 83 to 89): fixed rules in code, no LLM, and a pure
// function of the settings and a snapshot of the Profile's state, so the same
// inputs always give the same plan.

// A Mock's minutes with its break, and a Sectional's.
export const MockMinutes = 145
export const SectionalMinutes = 45
// A Practice Set is its Target Times plus this share for its Debriefs.
export const DebriefShare = 0.2
// Due Retries take at most this share of a day's planned time.
export const RetryShare = 1 / 5
// Practice is pitched where about two in three come out right:
// 1 / (1 + e^-0.69) is about 2/3.
export const PitchOffset = 0.69
// Before the Diagnostic, a Section is pitched at Medium until it has this
// many Rated Responses.
export const WarmUpRated = 20
// The Mock weeks: one Mock in each of the last 4 weeks, the last at least 3
// days before the test, and Mocks at least 3 days apart.
export const MockWeeks = 4
export const LastMockGap = 3
export const MockSpacing = 3
// Without a test date the plan covers this many Study Days.
export const UndatedDays = 14
// A Practice Set's size, and the fewest Questions a set is cut down to.
export const SetSize = 10
export const SmallestSet = 5
// Weak Areas worked on: the top ones by Priority, two sets a day in the Weak
// Area phase and one a day otherwise.
export const TopWeakAreas = 6

export type SectionId = string

export interface PlanSettings {
  // The test's date as a calendar day, or none.
  readonly testDate: string | null
  readonly targetTotal: number | null
  readonly weeklyMinutes: number
  // Weekdays with no study, 0 for Sunday to 6 for Saturday.
  readonly daysOff: ReadonlyArray<number>
}

export interface SectionState {
  readonly id: SectionId
  // The Section Ability, or null before any Rated Response.
  readonly ability: number | null
  readonly rated: number
  // The Section's default Target Time per Question.
  readonly paceMs: number
}

export interface WeakAreaState {
  readonly kind: "skill" | "questionType"
  readonly id: string
  readonly name: string
  readonly section: SectionId
  readonly priority: number
  readonly ability: number
  readonly slow: boolean
  // The most common Mistake Type of its misses, and Trap Pattern of the
  // wrong options picked.
  readonly topMistake: string | null
  readonly topTrap: string | null
}

export interface RetryDue {
  // The Study Day it falls due.
  readonly day: string
  readonly minutes: number
  // The Priority of the Weak Area of its primary Skill, 0 for none.
  readonly priority: number
}

export type DiagnosticState =
  // A Mock has been finished, or the three Diagnostic Sectionals.
  | "done"
  // Offered and not yet taken.
  | "pending"
  // The Learner skipped it.
  | "skipped"
  // No Mock can start yet.
  | "blocked"

export interface PlanState {
  readonly today: string
  readonly sections: ReadonlyArray<SectionState>
  // Highest Priority first.
  readonly weakAreas: ReadonlyArray<WeakAreaState>
  readonly retries: ReadonlyArray<RetryDue>
  // How many more times the start check lets each Section's Questions be
  // served in a Mock or Sectional.
  readonly allowed: Readonly<Record<SectionId, number>>
  readonly diagnostic: DiagnosticState
  // While the Diagnostic is pending as Sectionals, the Sections still to take.
  readonly diagnosticSections: ReadonlyArray<SectionId>
  // Minutes of planned work already done today, and whether a Mock was.
  readonly doneToday: number
  readonly mockToday: boolean
}

export interface PlanInputs {
  readonly settings: PlanSettings
  readonly state: PlanState
}

export interface PracticeParams {
  readonly section: SectionId
  readonly skill?: string
  readonly questionType?: string
  readonly trapPattern?: string
  readonly timed: boolean
  readonly size: number
  // The difficulty the set is pitched at.
  readonly near: number
}

export interface PlannedItem {
  readonly day: string
  readonly kind: "mock" | "sectional" | "retries" | "practice"
  readonly diagnostic: boolean
  readonly section: SectionId | null
  readonly count: number | null
  readonly practice: PracticeParams | null
  readonly weakArea: { readonly kind: "skill" | "questionType"; readonly id: string; readonly name: string; readonly priority: number } | null
  // The Mistake Type the set remedies, or "slow".
  readonly remedy: string | null
  readonly minutes: number
}

export interface DroppedItem extends PlannedItem {
  readonly reason: string
}

export interface PlanDay {
  readonly day: string
  readonly off: boolean
  // The day's planned time.
  readonly minutes: number
  readonly phase: "diagnostic" | "weak-areas" | "mixed" | "mocks"
  readonly items: ReadonlyArray<PlannedItem>
}

export interface Plan {
  readonly days: ReadonlyArray<PlanDay>
  readonly dropped: ReadonlyArray<DroppedItem>
  readonly notes: ReadonlyArray<string>
}

const DayMs = 86_400_000
export const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / DayMs)
export const dayOfNumber = (number: number) => new Date(number * DayMs).toISOString().slice(0, 10)
const weekdayOf = (number: number) => new Date(number * DayMs).getUTCDay()

const dayName = (number: number) =>
  new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }).format(number * DayMs)

const round2 = (value: number) => Math.round(value * 100) / 100

// A set's minutes: its Target Times plus the Debrief share, whole minutes up.
export const setMinutes = (size: number, paceMs: number) => Math.ceil((size * paceMs * (1 + DebriefShare)) / 60_000)

// The biggest set of at most SetSize and at least SmallestSet Questions that
// fits, or none.
const fittingSize = (room: number, paceMs: number) => {
  for (let size = SetSize; size >= SmallestSet; size -= 1) {
    if (setMinutes(size, paceMs) <= room) return size
  }
  return undefined
}

const item = (day: number, fields: Partial<PlannedItem> & Pick<PlannedItem, "kind" | "minutes">): PlannedItem => ({
  day: dayOfNumber(day),
  diagnostic: false,
  section: null,
  count: null,
  practice: null,
  weakArea: null,
  remedy: null,
  ...fields
})

export const buildPlan = ({ settings, state }: PlanInputs): Plan => {
  const notes: Array<string> = []
  const dropped: Array<DroppedItem> = []
  const today = dayNumber(state.today)
  const test = settings.testDate === null ? undefined : dayNumber(settings.testDate)
  if (test !== undefined && test <= today) {
    return { days: [], dropped: [], notes: ["The test date is today or has passed. Set a new test date, or none, to plan again."] }
  }
  const last = test === undefined ? today + UndatedDays - 1 : test - 1
  if (test === undefined) notes.push(`With no test date, the plan covers the next ${UndatedDays} Study Days and is made again each day.`)
  const off = (day: number) => settings.daysOff.includes(weekdayOf(day))
  const studyPerWeek = Math.max(1, 7 - new Set(settings.daysOff).size)
  const base = Math.floor(settings.weeklyMinutes / studyPerWeek)
  const days = Array.from({ length: last - today + 1 }, (_, index) => today + index)
  const studyDays = days.filter((day) => !off(day))
  // Weeks run back from the test, so each Mock week ends the day before it;
  // without a test date they run on from today.
  const weekOf = (day: number) => (test === undefined ? Math.floor((day - today) / 7) : Math.floor((test - 1 - day) / 7))
  const sectionIds = state.sections.map((section) => section.id)
  const sectionOf = new Map(state.sections.map((section) => [section.id, section] as const))
  const mockMode = settings.weeklyMinutes >= MockMinutes
  // Latest a Mock may fall: 3 days before the test.
  const mockLimit = test === undefined ? last : test - LastMockGap

  // The day's fixed event: a Mock, or a Sectional in its place.
  const events = new Map<number, PlannedItem>()
  const remaining = { ...state.allowed }
  const canServe = (sections: ReadonlyArray<SectionId>) => sections.every((section) => (remaining[section] ?? 0) > 0)
  const serve = (sections: ReadonlyArray<SectionId>) => {
    for (const section of sections) remaining[section] = (remaining[section] ?? 0) - 1
  }

  // The Diagnostic, first.
  let lastMock: number | undefined
  const diagnosticDays: Array<number> = []
  if (state.diagnostic === "pending") {
    const usable = studyDays.filter((day) => day <= mockLimit && !(day === today && state.mockToday))
    if (mockMode && state.diagnosticSections.length === sectionIds.length) {
      const day = usable[0]
      if (day !== undefined && canServe(sectionIds)) {
        events.set(day, item(day, { kind: "mock", diagnostic: true, minutes: MockMinutes }))
        serve(sectionIds)
        lastMock = day
        diagnosticDays.push(day)
      } else {
        dropped.push({
          ...item(day ?? today, { kind: "mock", diagnostic: true, minutes: MockMinutes }),
          reason: day === undefined ? "No study day falls at least 3 days before the test." : "The Mock Reserve cannot serve a Mock now."
        })
      }
    } else {
      // The three Sectionals over up to 3 days.
      state.diagnosticSections.forEach((section, index) => {
        const day = usable[index]
        if (day !== undefined && canServe([section])) {
          events.set(day, item(day, { kind: "sectional", diagnostic: true, section, minutes: SectionalMinutes }))
          serve([section])
          diagnosticDays.push(day)
        } else {
          dropped.push({
            ...item(day ?? today, { kind: "sectional", diagnostic: true, section, minutes: SectionalMinutes }),
            reason: day === undefined ? "No study day is left for it before the test." : "The Question Bank cannot serve this Sectional now."
          })
        }
      })
      if (diagnosticDays.length > 0) lastMock = Math.max(...diagnosticDays)
    }
  } else if (state.diagnostic === "skipped") {
    notes.push(`You skipped the Diagnostic, so each Section is practised at Medium until it has ${WarmUpRated} Rated Responses.`)
  } else if (state.diagnostic === "blocked") {
    notes.push(
      `No Mock can start yet, so each Section is practised at Medium until it has ${WarmUpRated} Rated Responses. The Diagnostic is offered once a Mock can start.`
    )
  }

  // The Mock weeks: the last 4 before the test, earliest first, each Mock on
  // the week's latest study day that keeps 3 days before the test and 3
  // after the Mock before it. A week that already holds the Diagnostic, or a
  // Mock taken today, needs no other.
  const wanted: Array<{ readonly week: number; readonly days: ReadonlyArray<number> }> = []
  if (test !== undefined) {
    if (!mockMode) {
      notes.push(
        "Your weekly time is under the 2 hours 25 minutes a Mock takes, so each Mock week gets the three Sectionals instead, on three days."
      )
    }
    const taken = new Set([...diagnosticDays.map(weekOf), ...(state.mockToday ? [weekOf(today)] : [])])
    for (let week = MockWeeks - 1; week >= 0; week -= 1) {
      if (taken.has(week)) continue
      const inWeek = studyDays.filter((day) => weekOf(day) === week && day <= mockLimit)
      if (inWeek.length === 0) continue
      if (mockMode) {
        const after = lastMock === undefined ? -Infinity : lastMock + MockSpacing
        const day = inWeek.filter((each) => each >= after).at(-1)
        if (day === undefined) continue
        wanted.push({ week, days: [day] })
        lastMock = day
      } else {
        wanted.push({ week, days: inWeek.slice(-sectionIds.length) })
      }
    }
    // The Mocks nearest the test are kept first, as far as the start check
    // allows.
    for (const { days: eventDays } of wanted.toReversed()) {
      if (mockMode) {
        const day = eventDays[0]!
        if (canServe(sectionIds)) {
          events.set(day, item(day, { kind: "mock", minutes: MockMinutes }))
          serve(sectionIds)
        } else {
          dropped.push({ ...item(day, { kind: "mock", minutes: MockMinutes }), reason: "" })
        }
      } else {
        sectionIds.forEach((section, index) => {
          const day = eventDays[index]
          if (day !== undefined && canServe([section])) {
            events.set(day, item(day, { kind: "sectional", section, minutes: SectionalMinutes }))
            serve([section])
          } else {
            dropped.push({
              ...item(day ?? eventDays.at(-1)!, { kind: "sectional", section, minutes: SectionalMinutes }),
              reason: day === undefined
                ? "The week has too few study days before the test for all three Sectionals."
                : "The Question Bank cannot serve another Sectional of this Section."
            })
          }
        })
      }
    }
    const mocksKept = [...events.values()].filter((event) => event.kind === "mock").length
    for (const [index, each] of dropped.entries()) {
      if (each.kind === "mock" && each.reason === "") {
        dropped[index] = { ...each, reason: `The Mock Reserve holds unseen Questions for ${mocksKept} Mocks in all.` }
      }
    }
  }

  // Each day's planned time: a Mock day gets the Mock's minutes, as does a
  // Sectional day the Sectional's when the day is shorter, and the week's
  // other study days share what is left.
  const minutes = new Map<number, number>()
  for (const week of new Set(days.map(weekOf))) {
    const inWeek = studyDays.filter((day) => weekOf(day) === week)
    const special = inWeek.filter((day) => {
      const event = events.get(day)
      return event !== undefined && (event.kind === "mock" || event.minutes > base)
    })
    const rest = base * inWeek.length - special.reduce((sum, day) => sum + events.get(day)!.minutes, 0)
    const share = special.length === 0 ? base : Math.floor(Math.max(0, rest) / Math.max(1, inWeek.length - special.length))
    for (const day of inWeek) minutes.set(day, special.includes(day) ? events.get(day)!.minutes : share)
  }

  // Phases: Weak Area work for the first two thirds of the days before the
  // Mock weeks, then mixed practice; without a test date, the first week
  // then the second.
  const firstMockWeekDay = test === undefined ? Infinity : test - MockWeeks * 7
  const practiceDays = days.filter((day) => day < firstMockWeekDay)
  const weakUntil = test === undefined ? today + 7 : (practiceDays[0] ?? today) + Math.ceil((practiceDays.length * 2) / 3)
  const phaseOf = (day: number): PlanDay["phase"] =>
    diagnosticDays.includes(day) ? "diagnostic" : day >= firstMockWeekDay ? "mocks" : day < weakUntil ? "weak-areas" : "mixed"

  // Pitch: theta - 0.69 once a Section is known, Medium before.
  const warm = (section: SectionId) => {
    const found = sectionOf.get(section)
    return found !== undefined && found.ability !== null && (state.diagnostic === "done" || found.rated >= WarmUpRated)
  }
  const near = (section: SectionId, ability?: number) =>
    warm(section) ? round2((ability ?? sectionOf.get(section)!.ability!) - PitchOffset) : 0
  const paceOf = (section: SectionId) => sectionOf.get(section)?.paceMs ?? 120_000

  const top = state.weakAreas.slice(0, TopWeakAreas)
  const remedyOf = (area: WeakAreaState): Pick<PlannedItem, "remedy"> & { readonly params: Omit<PracticeParams, "size" | "near"> } => {
    const scope = area.kind === "skill" ? { skill: area.id } : { questionType: area.id }
    if (area.topMistake === "trap" && area.topTrap !== null) {
      return { remedy: "trap", params: { section: area.section, trapPattern: area.topTrap, timed: area.slow } }
    }
    const timedMistake = area.topMistake === "wrong-approach" || area.topMistake === "calculation-slip" ||
      area.topMistake === "time-pressure"
    return {
      remedy: area.topMistake ?? (area.slow ? "slow" : null),
      params: { section: area.section, ...scope, timed: area.slow || timedMistake }
    }
  }

  let carried: Array<RetryDue> = []
  const planDays: Array<PlanDay> = []
  let studyIndex = 0
  for (const day of days) {
    const phase = phaseOf(day)
    if (off(day)) {
      carried = [...carried, ...state.retries.filter((retry) => dayNumber(retry.day) === day)]
      planDays.push({ day: dayOfNumber(day), off: true, minutes: 0, phase, items: [] })
      continue
    }
    const allotted = minutes.get(day) ?? base
    let room = Math.max(0, allotted - (day === today ? state.doneToday : 0))
    if (day === today && state.mockToday) room = 0
    const items: Array<PlannedItem> = []
    const event = events.get(day)
    if (event !== undefined) {
      items.push(event)
      room = Math.max(0, room - event.minutes)
    }

    // Due Retries, by Priority, up to a fifth of the day.
    const due = [...carried, ...state.retries.filter((retry) => dayNumber(retry.day) <= day && (dayNumber(retry.day) === day || day === today))]
      .map((retry, index) => ({ retry, index }))
      .toSorted((a, b) => b.retry.priority - a.retry.priority || a.index - b.index)
      .map(({ retry }) => retry)
    const cap = Math.min(room, Math.floor(allotted * RetryShare))
    const taken: Array<RetryDue> = []
    let used = 0
    for (const retry of due) {
      if (used + retry.minutes > cap) break
      taken.push(retry)
      used += retry.minutes
    }
    carried = due.slice(taken.length)
    const chosen: Array<PlannedItem> = []
    if (taken.length > 0) {
      chosen.push(item(day, {
        kind: "retries",
        count: taken.length,
        minutes: used,
        weakArea: null,
        remedy: null
      }))
    }
    room -= used

    // Weak Area sets, highest Priority first, rotating through the top Weak
    // Areas day by day. A Mock day holds only its Mock.
    const slots = phase === "weak-areas" ? 2 : 1
    const mockDay = event?.kind === "mock"
    if (top.length > 0 && !mockDay) {
      const picks = [...new Set(Array.from({ length: Math.min(slots, top.length) }, (_, slot) => top[(studyIndex * slots + slot) % top.length]!))]
        .toSorted((a, b) => b.priority - a.priority)
      for (const area of picks) {
        const { remedy, params } = remedyOf(area)
        const pace = paceOf(area.section)
        const size = fittingSize(room, pace)
        const weakArea = { kind: area.kind, id: area.id, name: area.name, priority: area.priority }
        const pitch = near(area.section, params.trapPattern === undefined ? area.ability : undefined)
        if (size === undefined) {
          dropped.push({
            ...item(day, {
              kind: "practice",
              practice: { ...params, size: SetSize, near: pitch },
              weakArea,
              remedy,
              minutes: setMinutes(SetSize, pace)
            }),
            reason: `No time left on ${dayName(day)} for a set of at least ${SmallestSet} Questions.`
          })
          continue
        }
        const minutesNeeded = setMinutes(size, pace)
        chosen.push(item(day, { kind: "practice", practice: { ...params, size, near: pitch }, weakArea, remedy, minutes: minutesNeeded }))
        room -= minutesNeeded
      }
    }

    // Timed mixed sets fill the rest, a Section at a time in rotation.
    if (!mockDay) {
      for (let turn = 0; sectionIds.some((each) => fittingSize(room, paceOf(each)) !== undefined); turn += 1) {
        const section = sectionIds[(studyIndex + turn) % sectionIds.length]!
        const size = fittingSize(room, paceOf(section))
        if (size === undefined) continue
        const minutesNeeded = setMinutes(size, paceOf(section))
        chosen.push(item(day, { kind: "practice", practice: { section, timed: true, size, near: near(section) }, minutes: minutesNeeded }))
        room -= minutesNeeded
      }
    }

    // A Retries item takes the Priority of its highest Retry.
    const priorityOf = (each: PlannedItem) =>
      each.kind === "retries" ? Math.max(...taken.map((retry) => retry.priority)) : each.weakArea?.priority ?? -1
    const ordered = chosen.map((each, index) => ({ each, index }))
      .toSorted((a, b) => priorityOf(b.each) - priorityOf(a.each) || a.index - b.index)
      .map(({ each }) => each)
    planDays.push({ day: dayOfNumber(day), off: false, minutes: allotted, phase, items: [...items, ...ordered] })
    studyIndex += 1
  }

  return { days: planDays, dropped: dropped.toSorted((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)), notes }
}
