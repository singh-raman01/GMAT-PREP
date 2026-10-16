// Times and durations as the app shows them, in this browser's time zone.

export const clockTime = (millis: number) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(millis)

export const dayAndTime = (millis: number) =>
  new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(
    millis
  )

export const minutesAndSeconds = (millis: number) => {
  const seconds = Math.max(0, Math.ceil(millis / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

// When something ended: the time alone if it was the day it started.
export const endedAt = (started: number, ended: number) =>
  new Date(started).toDateString() === new Date(ended).toDateString() ? clockTime(ended) : dayAndTime(ended)
