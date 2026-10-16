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
