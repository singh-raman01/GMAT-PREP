import { Schema } from "effect"

// A date that exists, as YYYY-MM-DD: some engines read 2026-02-30 as 2 March,
// so it is checked by a round trip.
export const isDay = (day: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const millis = Date.parse(`${day}T00:00:00Z`)
  return !Number.isNaN(millis) && new Date(millis).toISOString().slice(0, 10) === day
}

export const Day = Schema.String.check(Schema.makeFilter(isDay, { description: "a date as YYYY-MM-DD" }))
