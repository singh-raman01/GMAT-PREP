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
