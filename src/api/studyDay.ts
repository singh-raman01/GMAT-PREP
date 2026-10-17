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
