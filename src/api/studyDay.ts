// A Study Day starts at the Profile's rollover hour in its time zone, 4 am by
// default, so late sessions count for the day they belong to. A day that
// gains or loses an hour to daylight saving is still one Study Day.

const partsFormat = new Map<string, Intl.DateTimeFormat>()

const formatFor = (timeZone: string) => {
  let format = partsFormat.get(timeZone)
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric"
    })
    partsFormat.set(timeZone, format)
  }
  return format
}

const DayMs = 24 * 60 * 60 * 1000

// The Study Day a moment falls in, as a count of days since 1970-01-01:
// the local date, or the one before when the local hour is before the
// rollover hour.
export const studyDayOf = (millis: number, timeZone: string, rolloverHour: number): number => {
  const parts = formatFor(timeZone).formatToParts(millis)
  const part = (type: string) => Number(parts.find((each) => each.type === type)?.value ?? 0)
  const local = Date.UTC(part("year"), part("month") - 1, part("day")) / DayMs
  return part("hour") < rolloverHour ? local - 1 : local
}

// The Study Day of many moments, each quarter hour worked out once: in every
// time zone in use the local date and hour change only on a quarter hour.
const QuarterHourMs = 15 * 60 * 1000
export const studyDays = (timeZone: string, rolloverHour: number) => {
  const known = new Map<number, number>()
  return (millis: number) => {
    const quarter = Math.floor(millis / QuarterHourMs)
    let day = known.get(quarter)
    if (day === undefined) {
      day = studyDayOf(millis, timeZone, rolloverHour)
      known.set(quarter, day)
    }
    return day
  }
}

// When a Study Day begins: the first millisecond whose Study Day it is. The
// local start moves with the zone's offset and daylight saving, so it is
// found by halving a window that holds it in every zone.
export const studyDayStart = (day: number, timeZone: string, rolloverHour: number): number => {
  let before = (day - 1) * DayMs
  let from = (day + 2) * DayMs
  while (from - before > 1) {
    const middle = Math.floor((before + from) / 2)
    if (studyDayOf(middle, timeZone, rolloverHour) >= day) from = middle
    else before = middle
  }
  return from
}

// A Profile's rule for Study Days from a moment on (decision 92): its time
// zone and rollover hour. The first holds from always; each later one from
// the rollover after it was set.
export interface DayRule {
  readonly from: number
  readonly timeZone: string
  readonly rolloverHour: number
}

const ruleAt = (rules: ReadonlyArray<DayRule>, millis: number) => {
  let index = rules.length - 1
  while (index > 0 && rules[index]!.from > millis) index -= 1
  return index
}

// The rule in effect at a moment: a change still waiting for its rollover
// is not.
export const ruleInEffect = (rules: ReadonlyArray<DayRule>, millis: number): DayRule => rules[ruleAt(rules, millis)]!

// The Study Day of many moments under a Profile's rules. After a change the
// day never goes back: a zone behind the old one holds the day after the
// last one ended until its own date catches up, so no day repeats.
export const studyDaysUnder = (rules: ReadonlyArray<DayRule>) => {
  const under = rules.map((rule) => studyDays(rule.timeZone, rule.rolloverHour))
  if (rules.length === 1) return under[0]!
  const floors = new Map<number, number>()
  const floorOf = (index: number): number => {
    let floor = floors.get(index)
    if (floor === undefined) {
      floor = dayOf(rules[index]!.from - 1) + 1
      floors.set(index, floor)
    }
    return floor
  }
  const dayOf = (millis: number): number => {
    const index = ruleAt(rules, millis)
    const raw = under[index]!(millis)
    return index === 0 ? raw : Math.max(raw, floorOf(index))
  }
  return dayOf
}

// The calendar date of many moments in the time zone in effect then.
export const calendarDaysUnder = (rules: ReadonlyArray<DayRule>) => {
  const under = rules.map((rule) => studyDays(rule.timeZone, 0))
  return (millis: number) => under[ruleAt(rules, millis)]!(millis)
}

// When a Study Day begins under a Profile's rules: the first moment whose
// Study Day it is, or the next day's start for a day a change skipped.
export const studyDayStartUnder = (rules: ReadonlyArray<DayRule>, day: number): number => {
  const dayOf = studyDaysUnder(rules)
  let before = (day - 3) * DayMs
  let from = (day + 4) * DayMs
  while (from - before > 1) {
    const middle = Math.floor((before + from) / 2)
    if (dayOf(middle) >= day) from = middle
    else before = middle
  }
  return from
}

// The next rollover after a moment: when a change made then takes effect.
export const nextRolloverUnder = (rules: ReadonlyArray<DayRule>, millis: number) =>
  studyDayStartUnder(rules, studyDaysUnder(rules)(millis) + 1)

// When a calendar date begins in the time zone in effect at its middle, as
// for an Official Score's date.
export const calendarDayStartUnder = (rules: ReadonlyArray<DayRule>, day: number) => {
  const rule = rules[ruleAt(rules, day * DayMs + DayMs / 2)]!
  return studyDayStart(day, rule.timeZone, 0)
}
