import type { ScoreLine } from "../ratings/scale.ts"
import { sectionEstimateOn, totalEstimate } from "../ratings/scale.ts"

// The analytics views as rules over plain facts (docs/design.md,
// "Analytics"): Score trend, Timing, Mistakes and Study.

const TotalOrder = ["quant", "verbal", "di"] as const

const median = (values: ReadonlyArray<number>) => {
  if (values.length === 0) return null
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

// Score trend ---------------------------------------------------------------

export interface KeptEstimate {
  readonly section: string
  // Its Study Day.
  readonly day: number
  // The order it was written in, to tell apart those of one moment.
  readonly order: number
  readonly ability: number
  readonly standardError: number
}

export interface TrendPoint {
  readonly day: number
  readonly score: number
  readonly low: number
  readonly high: number
}

// Each Section's last Score Estimate of each Study Day, on the Section's
// current line, and the Total on each day all three have one by then.
export const trendOf = (kept: ReadonlyArray<KeptEstimate>, lines: Readonly<Record<string, ScoreLine>>) => {
  const lastOfDay = new Map<string, KeptEstimate>()
  for (const estimate of kept.toSorted((a, b) => a.day - b.day || a.order - b.order)) {
    lastOfDay.set(`${estimate.section}|${estimate.day}`, estimate)
  }
  const ordered = [...lastOfDay.values()].toSorted((a, b) => a.day - b.day || a.order - b.order)
  const sections = new Map<string, Array<TrendPoint>>()
  for (const estimate of ordered) {
    const line = lines[estimate.section]
    if (line === undefined) continue
    const point = { day: estimate.day, ...sectionEstimateOn(line, estimate) }
    const found = sections.get(estimate.section)
    if (found === undefined) sections.set(estimate.section, [point])
    else found.push(point)
  }
  const total: Array<TrendPoint> = []
  const latest = new Map<string, KeptEstimate>()
  for (const [day, ofDay] of Map.groupBy(ordered, (estimate) => estimate.day)) {
    for (const estimate of ofDay) latest.set(estimate.section, estimate)
    const parts = TotalOrder.map((section) => latest.get(section))
    if (parts.some((part) => part === undefined || lines[part.section] === undefined)) continue
    const estimate = totalEstimate(parts.map((part) => {
      const line = lines[part!.section]!
      return { score: sectionEstimateOn(line, part!).score, standardError: part!.standardError, line }
    }) as unknown as Parameters<typeof totalEstimate>[0])
    total.push({ day, score: estimate.score, low: estimate.low, high: estimate.high })
  }
  return { sections, total }
}

// Timing --------------------------------------------------------------------

export interface TimedAnswer {
  readonly sessionId: string
  readonly kind: string
  // Its place in the Session, from 0.
  readonly position: number
  readonly questionType: string
  readonly correct: boolean
  readonly timedOut: boolean
  // The first Response's time, and the Question's own Target Time.
  readonly timeSpentMs: number
  readonly targetMs: number
  // The Session's clock when it was served.
  readonly servedElapsedMs: number | null
  // The Strategy of its fastest valid Approach.
  readonly strategy: string | null
}

export interface Pace {
  readonly median: number
  readonly answers: number
}

const pacesBy = (answers: ReadonlyArray<TimedAnswer>, keyOf: (answer: TimedAnswer) => string | null) => {
  const groups = new Map<string, Array<number>>()
  for (const answer of answers) {
    const key = keyOf(answer)
    if (key === null || answer.timedOut || answer.targetMs <= 0) continue
    const found = groups.get(key)
    if (found === undefined) groups.set(key, [answer.timeSpentMs / answer.targetMs])
    else found.push(answer.timeSpentMs / answer.targetMs)
  }
  return new Map([...groups].map(([key, paces]) => [key, { median: median(paces)!, answers: paces.length }] as const))
}

// Time over Target Time, by Question Type and by the Strategy that solves a
// Question fastest.
export const pacesOf = (answers: ReadonlyArray<TimedAnswer>) => ({
  questionTypes: pacesBy(answers, (answer) => answer.questionType),
  strategies: pacesBy(answers, (answer) => answer.strategy)
})

export interface Accuracy {
  readonly right: number
  readonly answered: number
}

// How Sectionals and Mock Sections end: accuracy on each Section's last 5
// Questions served against the rest.
export const LastQuestions = 5
export const endingOf = (answers: ReadonlyArray<TimedAnswer>) => {
  const last = { right: 0, answered: 0 }
  const rest = { right: 0, answered: 0 }
  for (const session of Map.groupBy(answers.filter((answer) => answer.kind !== "practice"), (answer) => answer.sessionId).values()) {
    const end = Math.max(...session.map((answer) => answer.position))
    for (const answer of session) {
      const into = answer.position > end - LastQuestions ? last : rest
      into.answered++
      if (answer.correct && !answer.timedOut) into.right++
    }
  }
  return { last: last as Accuracy, rest: rest as Accuracy }
}

export interface PacingPoint {
  // The Question's place from 1.
  readonly question: number
  // The Section's clock when it was answered, and where an even pace would be.
  readonly usedMs: number
  readonly evenMs: number
}

// A Mock Section's pacing curve: the time used at each answer against an
// even pace through its limit.
export const pacingOf = (answers: ReadonlyArray<TimedAnswer>, limitMs: number, questions: number): ReadonlyArray<PacingPoint> =>
  answers.filter((answer) => answer.servedElapsedMs !== null)
    .toSorted((a, b) => a.position - b.position)
    .map((answer) => ({
      question: answer.position + 1,
      usedMs: Math.min(limitMs, answer.servedElapsedMs! + answer.timeSpentMs),
      evenMs: Math.round(limitMs * (answer.position + 1) / Math.max(1, questions))
    }))

// Mistakes ------------------------------------------------------------------

export interface WrongPart {
  readonly day: number
  readonly mistakeType: string | null
  readonly trapPattern: string | null
}

export interface MistakeWeek {
  // Its first and last Study Days.
  readonly from: number
  readonly to: number
  readonly questions: number
  // Per 100 Questions answered that week.
  readonly mistakeTypes: ReadonlyMap<string, number>
  readonly trapPatterns: ReadonlyMap<string, number>
}

export const StudyWeek = 7

// Mistake Types and Trap Patterns per 100 Questions answered, week by week:
// 7 Study Days ending today, then the 7 before, from the first week with an
// answer.
export const mistakeWeeksOf = (
  answeredDays: ReadonlyArray<number>,
  wrongParts: ReadonlyArray<WrongPart>,
  today: number,
  weeks: number
): ReadonlyArray<MistakeWeek> => {
  const weekOf = (day: number) => Math.floor((today - day) / StudyWeek)
  const counted = Array.from({ length: weeks }, (_, index) => ({
    from: today - (index + 1) * StudyWeek + 1,
    to: today - index * StudyWeek,
    questions: 0,
    mistakeTypes: new Map<string, number>(),
    trapPatterns: new Map<string, number>()
  }))
  for (const day of answeredDays) {
    const week = counted[weekOf(day)]
    if (week !== undefined) week.questions++
  }
  for (const part of wrongParts) {
    const week = counted[weekOf(part.day)]
    if (week === undefined) continue
    if (part.mistakeType !== null) week.mistakeTypes.set(part.mistakeType, (week.mistakeTypes.get(part.mistakeType) ?? 0) + 1)
    if (part.trapPattern !== null) week.trapPatterns.set(part.trapPattern, (week.trapPatterns.get(part.trapPattern) ?? 0) + 1)
  }
  const per100 = (counts: Map<string, number>, questions: number) =>
    new Map([...counts].map(([id, count]) => [id, questions === 0 ? 0 : (100 * count) / questions] as const))
  const ordered = counted.reverse()
  const first = ordered.findIndex((week) => week.questions > 0)
  return (first === -1 ? [] : ordered.slice(first)).map((week) => ({
    from: week.from,
    to: week.to,
    questions: week.questions,
    mistakeTypes: per100(week.mistakeTypes, week.questions),
    trapPatterns: per100(week.trapPatterns, week.questions)
  }))
}

// Study ---------------------------------------------------------------------

export interface StudyAnswer {
  readonly day: number
  readonly section: string
  // The first Response's time.
  readonly timeSpentMs: number
  // Null while its Session hides how it went.
  readonly correct: boolean | null
}

export interface StudyDay {
  readonly day: number
  readonly minutes: number
  readonly questions: number
  readonly sections: ReadonlyMap<string, Accuracy>
  readonly mocks: number
}

// Each Study Day with work: minutes, Questions answered, accuracy by Section
// where shown, and Mocks finished.
export const studyDaysOf = (answers: ReadonlyArray<StudyAnswer>, mockDays: ReadonlyArray<number>): ReadonlyArray<StudyDay> => {
  const days = new Map<number, { spent: number; questions: number; sections: Map<string, { right: number; answered: number }>; mocks: number }>()
  const dayOf = (day: number) => {
    const found = days.get(day) ?? { spent: 0, questions: 0, sections: new Map(), mocks: 0 }
    days.set(day, found)
    return found
  }
  for (const answer of answers) {
    const found = dayOf(answer.day)
    found.spent += answer.timeSpentMs
    found.questions++
    if (answer.correct === null) continue
    const section = found.sections.get(answer.section) ?? { right: 0, answered: 0 }
    section.answered++
    if (answer.correct) section.right++
    found.sections.set(answer.section, section)
  }
  for (const day of mockDays) dayOf(day).mocks++
  return [...days].toSorted((a, b) => a[0] - b[0]).map(([day, found]) => ({
    day,
    minutes: Math.round(found.spent / 60_000),
    questions: found.questions,
    sections: found.sections,
    mocks: found.mocks
  }))
}
