// Times and durations as the app shows them, in this browser's time zone.

export const clockTime = (millis: number) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(millis)

// In this browser's time zone, or the one given, such as a Profile's.
export const dayAndTime = (millis: number, timeZone?: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone === undefined ? {} : { timeZone })
  }).format(millis)

// The same, to the second, to tell apart moments in one minute.
export const dayAndSecond = (millis: number) =>
  new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })
    .format(millis)

export const minutesAndSeconds = (millis: number) => {
  const seconds = Math.max(0, Math.ceil(millis / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

// When something ended: the time alone if it was the day it started.
export const endedAt = (started: number, ended: number) =>
  new Date(started).toDateString() === new Date(ended).toDateString() ? clockTime(ended) : dayAndTime(ended)

// A length of time in words: "45 seconds", "1 minute 30 seconds".
export const spokenDuration = (millis: number) => {
  const seconds = Math.max(0, Math.round(millis / 1000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`
  if (minutes === 0) return unit(rest, "second")
  return rest === 0 ? unit(minutes, "minute") : `${unit(minutes, "minute")} ${unit(rest, "second")}`
}

// A calendar day as the server sends it (2026-10-03), read as written, not in
// a time zone: "Sat, Oct 3".
export const calendarDay = (day: string) =>
  new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(
    Date.parse(`${day}T00:00:00Z`)
  )

// A calendar day in full, as a heading: "Monday, November 2".
export const longDay = (day: string) =>
  new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }).format(
    Date.parse(`${day}T00:00:00Z`)
  )

// Minutes as hours and minutes: "1 hour 40 minutes", "45 minutes".
export const hoursAndMinutes = (total: number) => {
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`
  if (hours === 0) return unit(minutes, "minute")
  return minutes === 0 ? unit(hours, "hour") : `${unit(hours, "hour")} ${unit(minutes, "minute")}`
}
