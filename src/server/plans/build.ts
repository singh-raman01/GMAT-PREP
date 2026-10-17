import { RetrySetMax } from "../../api/Retries.ts"

// The Study Plan builder (docs/design.md, "Study Plan, Diagnostic and Daily
// Log", decisions 83 to 89): fixed rules in code, no LLM, and a pure
// function of the settings and a snapshot of the Profile's state, so the same
// inputs always give the same plan. A plan is made again at each Study Day
// and after each Mock, so the snapshot carries what the plan has been doing:
// the day it started from, the Mocks and Sectionals of the last week, and
// today's work so far.

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
// Without a test date the plan covers this many Study Days, and its phases
// take turns a week at a time from the day it started.
export const UndatedDays = 14
// Sets and Retries are planned for this many days; the days after keep
// their time, phase, Mocks and Sectionals until they come nearer.
export const ItemDays = 28
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
  // A Question Type's own Target Time, when it has one; else its Section's.
  readonly paceMs?: number | undefined
}

export interface RetryDue {
  // The Study Day it falls due.
  readonly day: string
  readonly timed: boolean
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

// A Mock or Sectional the Learner started, from the plan or not.
export interface TakenEvent {
  // The Study Day it started.
  readonly day: string
  readonly kind: "mock" | "sectional"
  // A Sectional's Section.
  readonly section: SectionId | null
  // Whether it was planned as the Diagnostic or part of it.
  readonly diagnostic: boolean
  // Whether it was started from a plan item, so today's work counts it
  // already.
  readonly fromPlan: boolean
}

export interface PlanState {
  readonly today: string
  // The Study Day the current test date, or none, was set: the phases and
  // the Weak Area rotation count from it.
  readonly start: string
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
  // The Mocks and Sectionals started in the last 7 Study Days, today's too.
  readonly taken: ReadonlyArray<TakenEvent>
  // Today's plan items started or done, under any version of the plan.
  readonly todayWork: ReadonlyArray<PlannedItem>
  // The approved Lessons on the Weak Areas' subjects (decision 101).
  readonly lessons: ReadonlyArray<LessonState>
}

export interface LessonState {
  // The Skill or Question Type it teaches.
  readonly subject: string
  readonly lessonId: string
  // Minutes to read it all and take its check, and to read its methods.
  readonly minutes: number
  readonly methodsMinutes: number
  // Whether the Learner has done this version: the whole Lesson by
  // finishing its check in full, the methods by marking any part read or by
  // finishing the check.
  readonly done: boolean
  readonly methodsDone: boolean
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
  readonly kind: "mock" | "sectional" | "retries" | "practice" | "lesson"
  readonly diagnostic: boolean
  readonly timed: boolean
  readonly section: SectionId | null
  // How many Retries.
  readonly count: number | null
  readonly practice: PracticeParams | null
  readonly weakArea: { readonly kind: "skill" | "questionType"; readonly id: string; readonly name: string; readonly priority: number } | null
  // The Mistake Type the set remedies, or "slow".
  readonly remedy: string | null
  // A Lesson to read: the whole of it with its check, or its methods.
  readonly lesson: { readonly id: string; readonly subject: string; readonly part: "whole" | "methods" } | null
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
  // The last day whose sets and Retries are planned, or none.
  readonly itemsUntil: string | null
}

const DayMs = 86_400_000
export const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / DayMs)
export const dayOfNumber = (number: number) => new Date(number * DayMs).toISOString().slice(0, 10)
const weekdayOf = (number: number) => new Date(number * DayMs).getUTCDay()

const dayName = (number: number) =>
  new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }).format(number * DayMs)

const round2 = (value: number) => Math.round(value * 100) / 100
const minutesOf = (items: ReadonlyArray<PlannedItem>) => items.reduce((sum, each) => sum + each.minutes, 0)

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
  timed: fields.kind !== "practice" && fields.kind !== "retries" ? true : fields.practice?.timed ?? false,
  section: null,
  count: null,
  practice: null,
  weakArea: null,
  remedy: null,
  lesson: null,
  ...fields
})

// A day's Mock or Sectional, for sharing the week's time.
interface DayEvent {
  readonly mock: boolean
  readonly minutes: number
}

export const buildPlan = ({ settings, state }: PlanInputs): Plan => {
  const notes: Array<string> = []
  const today = dayNumber(state.today)
  const start = Math.min(today, dayNumber(state.start))
  const test = settings.testDate === null ? undefined : dayNumber(settings.testDate)
  if (test !== undefined && test <= today) {
    return {
      days: [],
      dropped: [],
      notes: ["The test date is today or has passed. Set a new test date, or none, to plan again."],
      itemsUntil: null
    }
  }
  const last = test === undefined ? today + UndatedDays - 1 : test - 1
  const itemsUntil = Math.min(last, today + ItemDays - 1)
  if (test === undefined) {
    notes.push(
      `With no test date, the plan covers the next ${UndatedDays} Study Days and is made again each day: a week of Weak Area work, then a week of mixed practice, in turn.`
    )
  }
  if (last > itemsUntil) {
    notes.push(
      `Sets and Retries are planned ${ItemDays / 7} weeks ahead. The days after show their time and any Mock or Sectional, and get their sets as they come nearer.`
    )
  }
  const daysOff = new Set(settings.daysOff)
  const off = (day: number) => daysOff.has(weekdayOf(day))
  const studyPerWeek = 7 - daysOff.size
  const base = Math.floor(settings.weeklyMinutes / Math.max(1, studyPerWeek))
  const days = Array.from({ length: last - today + 1 }, (_, index) => today + index)
  const studyDays = days.filter((day) => !off(day))
  // Weeks run back from the test, so each Mock week ends the day before it;
  // without a test date they run on from the plan's start.
  const weekOf = (day: number) => (test === undefined ? Math.floor((day - start) / 7) : Math.floor((test - 1 - day) / 7))
  const studyDaysByWeek = Map.groupBy(studyDays, weekOf)
  const sectionIds = state.sections.map((section) => section.id)
  const sectionOf = new Map(state.sections.map((section) => [section.id, section] as const))
  const mockMode = settings.weeklyMinutes >= MockMinutes
  // Latest a Mock may fall: 3 days before the test.
  const mockLimit = test === undefined ? last : test - LastMockGap
  const paceOf = (section: SectionId) => sectionOf.get(section)?.paceMs ?? 120_000

  // What was taken: Mocks and Sectionals by the day each started, and the
  // work done today from the plan.
  const taken = state.taken.map((event) => ({ ...event, number: dayNumber(event.day) })).filter((event) => event.number <= today)
  const takenToday = taken.filter((event) => event.number === today)
  const mockToday = takenToday.some((event) => event.kind === "mock")
  // Today's plan items worked on, and the Sectionals taken today from their
  // own page, which take their minutes from today as well.
  const doneToday = minutesOf(state.todayWork) +
    takenToday.filter((event) => event.kind === "sectional" && !event.fromPlan).length * SectionalMinutes

  // The fixed events, Mocks and Sectionals, placed with today open to them
  // or not: today takes one only when none was taken today and it fits
  // what is left of the day.
  const placeEvents = (todayOpen: boolean) => {
    const events = new Map<number, PlannedItem>()
    const dropped: Array<DroppedItem> = []
    const remaining = { ...state.allowed }
    const canServe = (sections: ReadonlyArray<SectionId>) => sections.every((section) => (remaining[section] ?? 0) > 0)
    const serve = (sections: ReadonlyArray<SectionId>) => {
      for (const section of sections) remaining[section] = (remaining[section] ?? 0) - 1
    }
    const open = (day: number) => day !== today || todayOpen

    // The Diagnostic, first.
    const diagnosticDays: Array<number> = []
    if (state.diagnostic === "pending") {
      const usable = studyDays.filter((day) => day <= mockLimit && open(day))
      if (mockMode && state.diagnosticSections.length === sectionIds.length) {
        const day = usable[0]
        if (day !== undefined && canServe(sectionIds)) {
          events.set(day, item(day, { kind: "mock", diagnostic: true, minutes: MockMinutes }))
          serve(sectionIds)
          diagnosticDays.push(day)
        } else {
          dropped.push({
            ...item(day ?? today, { kind: "mock", diagnostic: true, minutes: MockMinutes }),
            reason: day === undefined ? "No study day falls at least 3 days before the test." : "The Mock Reserve cannot serve a Mock now."
          })
        }
      } else {
        // The Sectionals left, one a day.
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
      }
    }

    // The Mock weeks, the last 4 before the test, placed from the test back:
    // each Mock on the week's latest study day that keeps 3 days before the
    // test, 3 before the Mock after it and 3 after every Mock taken. A week
    // that holds the Diagnostic or a Mock taken needs no other. Under a
    // Mock's time, a week gets the Sectionals of the Sections it has not had,
    // each on its own day from the week's end, Data Insights last, so a day
    // missed drops its own Sectional and moves no other.
    if (test !== undefined) {
      const fixed = [
        ...diagnosticDays,
        ...taken.filter((event) => event.kind === "mock" || event.diagnostic).map((event) => event.number)
      ]
      const held = new Set(fixed.map(weekOf))
      const wanted: Array<{
        readonly days: ReadonlyArray<number>
        readonly sections: ReadonlyArray<SectionId>
        readonly missed: ReadonlyArray<SectionId>
      }> = []
      let next = Infinity
      for (let week = 0; week < MockWeeks; week += 1) {
        const weekEnd = test - 1 - week * 7
        // The weeks run back from the test, so the rest are past.
        if (weekEnd < today) break
        if (held.has(week)) {
          next = Math.min(next, ...fixed.filter((day) => weekOf(day) === week))
          continue
        }
        const had = new Set(taken.filter((event) => event.kind === "sectional" && weekOf(event.number) === week).map((event) => event.section))
        const sections = mockMode ? sectionIds : sectionIds.filter((section) => !had.has(section))
        if (sections.length === 0) continue
        const unplaced = (day: number, reason: string) => {
          if (mockMode) dropped.push({ ...item(day, { kind: "mock", minutes: MockMinutes }), reason })
          else for (const section of sections) dropped.push({ ...item(day, { kind: "sectional", section, minutes: SectionalMinutes }), reason })
        }
        const left = studyDaysByWeek.get(week) ?? []
        const beforeTest = left.filter((day) => day <= mockLimit)
        const inWeek = beforeTest.filter(open)
        const lastDay = Math.min(weekEnd, last)
        if (left.length === 0) {
          unplaced(lastDay, "No study day is left in its week.")
          continue
        }
        if (beforeTest.length === 0) {
          unplaced(lastDay, "No study day in its week falls at least 3 days before the test.")
          continue
        }
        if (inWeek.length === 0) {
          unplaced(today, "Today has had its Mock or Sectional, and no other study day is left in its week.")
          continue
        }
        if (mockMode) {
          const day = inWeek.filter((each) =>
            each <= next - MockSpacing && fixed.every((other) => other > each || each >= other + MockSpacing)
          ).at(-1)
          if (day === undefined) {
            unplaced(inWeek.at(-1)!, "No study day in its week is at least 3 days from the Mocks before and after it.")
            continue
          }
          wanted.push({ days: [day], sections: sectionIds, missed: [] })
          next = day
        } else {
          const count = Math.min(sections.length, inWeek.length)
          wanted.push({
            days: inWeek.slice(inWeek.length - count),
            sections: sections.slice(sections.length - count),
            missed: sections.slice(0, sections.length - count)
          })
        }
      }
      // The weeks nearest the test are kept first, as far as the start check
      // allows.
      for (const { days: eventDays, sections, missed } of wanted) {
        if (mockMode) {
          const day = eventDays[0]!
          if (canServe(sectionIds)) {
            events.set(day, item(day, { kind: "mock", minutes: MockMinutes }))
            serve(sectionIds)
          } else {
            dropped.push({ ...item(day, { kind: "mock", minutes: MockMinutes }), reason: "" })
          }
        } else {
          for (const section of missed) {
            dropped.push({
              ...item(eventDays[0]!, { kind: "sectional", section, minutes: SectionalMinutes }),
              reason: "The week has too few study days left before the test for all three Sectionals."
            })
          }
          sections.forEach((section, index) => {
            const day = eventDays[index]!
            if (canServe([section])) {
              events.set(day, item(day, { kind: "sectional", section, minutes: SectionalMinutes }))
              serve([section])
            } else {
              dropped.push({
                ...item(day, { kind: "sectional", section, minutes: SectionalMinutes }),
                reason: "The Question Bank cannot serve another Sectional of this Section."
              })
            }
          })
        }
      }
      // The Mock weeks' Mocks kept, the Diagnostic aside.
      const weekMocks = [...events.values()].filter((event) => event.kind === "mock" && !event.diagnostic).length
      const reason = weekMocks === 0
        ? "The Mock Reserve has too few unseen Questions for another Mock."
        : `The Mock Reserve has unseen Questions for only ${weekMocks} more ${weekMocks === 1 ? "Mock" : "Mocks"}, kept for the weeks nearest the test.`
      for (const [index, each] of dropped.entries()) {
        if (each.kind === "mock" && each.reason === "") dropped[index] = { ...each, reason }
      }
    }
    return { events, dropped, diagnosticDays }
  }

  // Each week's study days from the plan's start, the past ones of this week
  // too, so the plan made again during a week gives its days the same share:
  // a Mock day gets the Mock's minutes, as does a Sectional day the
  // Sectional's when the day is shorter, and the other study days share what
  // is left.
  const weekDays = new Map<number, Array<number>>()
  for (let day = Math.max(start, today - 6); day <= last; day += 1) {
    if (off(day) || (day < today && weekOf(day) !== weekOf(today))) continue
    const week = weekOf(day)
    weekDays.set(week, [...(weekDays.get(week) ?? []), day])
  }
  const takenEvents = new Map<number, DayEvent>()
  for (const event of taken) {
    const kept = takenEvents.get(event.number)
    if (kept?.mock === true) continue
    takenEvents.set(event.number, event.kind === "mock" ? { mock: true, minutes: MockMinutes } : { mock: false, minutes: SectionalMinutes })
  }
  const minutesUnder = (events: ReadonlyMap<number, PlannedItem>) => {
    const eventOf = (day: number): DayEvent | undefined => {
      const planned = events.get(day)
      return planned !== undefined ? { mock: planned.kind === "mock", minutes: planned.minutes } : day <= today ? takenEvents.get(day) : undefined
    }
    const minutes = new Map<number, number>()
    for (const inWeek of weekDays.values()) {
      const inWeekEvents = inWeek.flatMap((day) => {
        const event = eventOf(day)
        return event === undefined ? [] : [{ day, event }]
      })
      // A Sectional longer than the share takes its own minutes, which
      // leaves the rest a smaller share, so this settles in a few rounds.
      const special = new Map<number, number>()
      let share = base
      for (let round = 0; round <= inWeekEvents.length; round += 1) {
        for (const { day, event } of inWeekEvents) if (event.mock || event.minutes > share) special.set(day, event.minutes)
        const rest = base * inWeek.length - [...special.values()].reduce((sum, each) => sum + each, 0)
        share = special.size === 0 ? base : Math.floor(Math.max(0, rest) / Math.max(1, inWeek.length - special.size))
      }
      for (const day of inWeek) if (day >= today) minutes.set(day, special.get(day) ?? share)
    }
    return minutes
  }

  let placed = placeEvents(takenToday.length === 0)
  let minutes = minutesUnder(placed.events)
  const todayEvent = placed.events.get(today)
  if (
    todayEvent !== undefined &&
    (todayEvent.kind === "mock" ? doneToday > 0 : doneToday + todayEvent.minutes > (minutes.get(today) ?? base))
  ) {
    placed = placeEvents(false)
    minutes = minutesUnder(placed.events)
  }
  const { events, diagnosticDays } = placed
  const dropped = [...placed.dropped]

  if (state.diagnostic === "skipped") {
    notes.push(`You skipped the Diagnostic, so each Section is practised at Medium until it has ${WarmUpRated} Rated Responses.`)
  } else if (state.diagnostic === "blocked") {
    notes.push(
      `No Mock can start yet, so each Section is practised at Medium until it has ${WarmUpRated} Rated Responses. The Diagnostic is offered once a Mock can start.`
    )
  }
  if (test !== undefined && !mockMode) {
    notes.push(
      "Your weekly time is under the 2 hours 25 minutes a Mock takes, so each Mock week gets the three Sectionals instead, on three days."
    )
  }
  const smallest = Math.min(...sectionIds.map((section) => setMinutes(SmallestSet, paceOf(section))))
  if (sectionIds.length > 0 && base < smallest) {
    notes.push(
      `Each study day gets ${base} minutes of your weekly time, under the ${smallest} minutes the smallest set takes, so most days have no set. More hours a week, or more days off, give each study day enough.`
    )
  }

  // Phases: Weak Area work for the first two thirds of the days from the
  // plan's start to the Mock weeks, then mixed practice; without a test
  // date, a week of each in turn from the start.
  const firstMockWeekDay = test === undefined ? Infinity : test - MockWeeks * 7
  const weakUntil = test === undefined ? undefined : start + Math.ceil((Math.max(0, firstMockWeekDay - start) * 2) / 3)
  const phaseOf = (day: number): PlanDay["phase"] =>
    diagnosticDays.includes(day)
      ? "diagnostic"
      : day >= firstMockWeekDay
      ? "mocks"
      : weakUntil === undefined
      ? ((day - start) % (2 * 7)) < 7 ? "weak-areas" : "mixed"
      : day < weakUntil
      ? "weak-areas"
      : "mixed"

  // Pitch: theta - 0.69 once a Section is known, Medium before.
  const warm = (section: SectionId) => {
    const found = sectionOf.get(section)
    return found !== undefined && found.ability !== null && (state.diagnostic === "done" || found.rated >= WarmUpRated)
  }
  const near = (section: SectionId, ability?: number) =>
    warm(section) ? round2((ability ?? sectionOf.get(section)!.ability!) - PitchOffset) : 0

  const top = state.weakAreas.slice(0, TopWeakAreas)
  // A Lesson comes before a Weak Area's set when its misses are most often a
  // Concept gap (the whole Lesson) or a Wrong approach (its methods), once
  // in the plan, until the Learner has done it (decision 101).
  const lessonOf = new Map(state.lessons.map((lesson) => [lesson.subject, lesson] as const))
  const lessonFor = (area: WeakAreaState) => {
    const lesson = lessonOf.get(area.id)
    if (lesson === undefined || lesson.done) return undefined
    if (area.topMistake === "concept-gap") return { lesson, part: "whole" as const, minutes: lesson.minutes }
    if (area.topMistake === "wrong-approach" && !lesson.methodsDone) {
      return { lesson, part: "methods" as const, minutes: lesson.methodsMinutes }
    }
    return undefined
  }
  // A Lesson started or done today is placed already.
  const lessonsPlaced = new Set<string>(state.todayWork.flatMap((each) => (each.lesson == null ? [] : [each.lesson.id])))
  // A Lesson tried on a day without room for it, until a later day has room.
  const lessonsWaiting = new Map<string, DroppedItem>()
  if (top.length === 0) {
    notes.push("No Weak Area shows yet, so the plan sets mixed practice until your timed answers show where you lose points.")
  }
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

  // Today's work so far: the Weak Areas of its sets are not worked on
  // again (a Lesson is followed by its set), each of its mixed sets takes
  // its Section's next place in the turn, and its Retries count against the
  // day's share for them.
  const workedToday = new Set(
    state.todayWork.flatMap((each) => (each.kind === "practice" && each.weakArea !== null ? [each.weakArea.id] : []))
  )
  const areaSetsToday = state.todayWork.filter((each) => each.kind === "practice" && each.weakArea !== null).length
  const mixedToday = new Map<SectionId, number>()
  for (const each of state.todayWork) {
    if (each.kind !== "practice" || each.weakArea !== null || each.practice === null) continue
    mixedToday.set(each.practice.section, (mixedToday.get(each.practice.section) ?? 0) + 1)
  }
  const retriesToday = minutesOf(state.todayWork.filter((each) => each.kind === "retries"))

  // The study days from the start to today, for the turns.
  const studyDaysBefore = (day: number) => {
    const weeks = Math.floor((day - start) / 7)
    let count = weeks * studyPerWeek
    for (let each = start + weeks * 7; each < day; each += 1) if (!off(each)) count += 1
    return count
  }

  let carried: Array<RetryDue> = []
  const planDays: Array<PlanDay> = []
  let studyIndex = studyDaysBefore(today)
  for (const day of days) {
    const phase = phaseOf(day)
    if (off(day)) {
      carried = [...carried, ...state.retries.filter((retry) => dayNumber(retry.day) === day)]
      planDays.push({ day: dayOfNumber(day), off: true, minutes: 0, phase, items: [] })
      continue
    }
    const allotted = minutes.get(day) ?? base
    const event = events.get(day)
    // Past the days planned in full, a day keeps its time and its event.
    if (day > itemsUntil) {
      planDays.push({ day: dayOfNumber(day), off: false, minutes: allotted, phase, items: event === undefined ? [] : [event] })
      studyIndex += 1
      continue
    }
    const isToday = day === today
    let room = Math.max(0, allotted - (isToday ? doneToday : 0))
    if (isToday && mockToday) room = 0
    const items: Array<PlannedItem> = []
    if (event !== undefined) {
      items.push(event)
      room = Math.max(0, room - event.minutes)
    }

    // Due Retries, by Priority, up to a fifth of the day.
    const due = [...carried, ...state.retries.filter((retry) => dayNumber(retry.day) <= day && (dayNumber(retry.day) === day || isToday))]
      .map((retry, index) => ({ retry, index }))
      .toSorted((a, b) => b.retry.priority - a.retry.priority || a.index - b.index)
      .map(({ retry }) => retry)
    const cap = Math.max(0, Math.min(room, Math.floor(allotted * RetryShare) - (isToday ? retriesToday : 0)))
    const takenRetries: Array<RetryDue> = []
    let used = 0
    for (const retry of due) {
      if (used + retry.minutes > cap) break
      takenRetries.push(retry)
      used += retry.minutes
    }
    carried = due.slice(takenRetries.length)
    // A Retries item for each timing and each 20, as each is a set of its
    // own; it takes the Priority of its highest Retry.
    const chosen: Array<PlannedItem> = []
    const priorityOfItem = new Map<PlannedItem, number>()
    for (const timed of [false, true]) {
      const group = takenRetries.filter((retry) => retry.timed === timed)
      for (let from = 0; from < group.length; from += RetrySetMax) {
        const set = group.slice(from, from + RetrySetMax)
        const retriesItem = item(day, { kind: "retries", timed, count: set.length, minutes: set.reduce((sum, retry) => sum + retry.minutes, 0) })
        priorityOfItem.set(retriesItem, Math.max(...set.map((retry) => retry.priority)))
        chosen.push(retriesItem)
      }
    }
    room -= used

    // Weak Area sets, highest Priority first, rotating through the top Weak
    // Areas day by day. A Mock day holds only its Mock.
    const slots = phase === "weak-areas" ? 2 : 1
    const mockDay = event?.kind === "mock"
    if (top.length > 0 && !mockDay) {
      const turn = [...new Set(Array.from({ length: Math.min(slots, top.length) }, (_, slot) => top[(studyIndex * slots + slot) % top.length]!))]
      const picks = (isToday ? turn.filter((area) => !workedToday.has(area.id)).slice(0, Math.max(0, slots - areaSetsToday)) : turn)
        .toSorted((a, b) => b.priority - a.priority)
      for (const area of picks) {
        const { remedy, params } = remedyOf(area)
        const pace = params.trapPattern === undefined ? area.paceMs ?? paceOf(area.section) : paceOf(area.section)
        const weakArea = { kind: area.kind, id: area.id, name: area.name, priority: area.priority }
        const wanted = lessonFor(area)
        if (wanted !== undefined && !lessonsPlaced.has(wanted.lesson.lessonId)) {
          const lessonItem = item(day, {
            kind: "lesson",
            lesson: { id: wanted.lesson.lessonId, subject: area.id, part: wanted.part },
            weakArea,
            remedy,
            minutes: wanted.minutes
          })
          if (wanted.minutes <= room) {
            chosen.push(lessonItem)
            room -= wanted.minutes
            lessonsPlaced.add(wanted.lesson.lessonId)
            lessonsWaiting.delete(wanted.lesson.lessonId)
          } else if (!lessonsWaiting.has(wanted.lesson.lessonId)) {
            lessonsWaiting.set(wanted.lesson.lessonId, {
              ...lessonItem,
              reason: `No study day up to ${dayName(itemsUntil)} has room for its ${wanted.minutes} minutes.`
            })
          }
        }
        const size = fittingSize(room, pace)
        const pitch = near(area.section, params.trapPattern === undefined ? area.ability : undefined)
        if (size === undefined) {
          const needed = setMinutes(SmallestSet, pace)
          dropped.push({
            ...item(day, {
              kind: "practice",
              practice: { ...params, size: SetSize, near: pitch },
              weakArea,
              remedy,
              minutes: setMinutes(SetSize, pace)
            }),
            reason: allotted < needed
              ? `${dayName(day)} has ${allotted} minutes planned, under the ${needed} a set of ${SmallestSet} Questions takes.`
              : `No time left on ${dayName(day)} for a set of at least ${SmallestSet} Questions.`
          })
          continue
        }
        const minutesNeeded = setMinutes(size, pace)
        chosen.push(item(day, { kind: "practice", practice: { ...params, size, near: pitch }, weakArea, remedy, minutes: minutesNeeded }))
        room -= minutesNeeded
      }
    }

    // Timed mixed sets fill the rest, a Section at a time in turn. A set
    // done today takes its Section's next place, so a Section done first
    // does not come round again before the others.
    if (!mockDay) {
      const done = new Map(isToday ? mixedToday : [])
      for (let turn = 0; sectionIds.some((each) => fittingSize(room, paceOf(each)) !== undefined); turn += 1) {
        const section = sectionIds[(studyIndex + turn) % sectionIds.length]!
        const already = done.get(section) ?? 0
        if (already > 0) {
          done.set(section, already - 1)
          continue
        }
        const size = fittingSize(room, paceOf(section))
        if (size === undefined) continue
        const minutesNeeded = setMinutes(size, paceOf(section))
        chosen.push(item(day, { kind: "practice", practice: { section, timed: true, size, near: near(section) }, minutes: minutesNeeded }))
        room -= minutesNeeded
      }
    }

    // Items follow the Priority of the Weak Area they target.
    const priorityOf = (each: PlannedItem) => priorityOfItem.get(each) ?? each.weakArea?.priority ?? -1
    const ordered = chosen.map((each, index) => ({ each, index }))
      .toSorted((a, b) => priorityOf(b.each) - priorityOf(a.each) || a.index - b.index)
      .map(({ each }) => each)
    planDays.push({ day: dayOfNumber(day), off: false, minutes: allotted, phase, items: [...items, ...ordered] })
    studyIndex += 1
  }

  // A Lesson no day had room for is dropped where it was first tried.
  dropped.push(...lessonsWaiting.values())
  // Retries still due when no study day is left before the test.
  if (test !== undefined && itemsUntil === last && carried.length > 0) {
    for (const timed of [false, true]) {
      const group = carried.filter((retry) => retry.timed === timed)
      if (group.length === 0) continue
      dropped.push({
        ...item(last, { kind: "retries", timed, count: group.length, minutes: group.reduce((sum, retry) => sum + retry.minutes, 0) }),
        reason: "No study day is left before the test for these Retries."
      })
    }
  }

  return {
    days: planDays,
    dropped: dropped.toSorted((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
    notes,
    itemsUntil: dayOfNumber(itemsUntil)
  }
}
