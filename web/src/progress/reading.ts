import { useEffect, useState } from "react"
import type { Result } from "effect"

// Reads one analytics view when the page opens; a failure goes to the page.

export const useReading = <A, E extends { readonly _tag: string }>(
  read: () => Promise<Result.Result<A, E>>,
  onFailure: (failure: E) => void
): A | undefined => {
  const [value, setValue] = useState<A>()
  useEffect(() => {
    let live = true
    void read().then((result) => {
      if (!live) return
      if (result._tag === "Failure") return onFailure(result.failure)
      setValue(result.success)
    })
    return () => {
      live = false
    }
  }, [read, onFailure])
  return value
}

// An Ability gap in Section points: an uncalibrated Section line gives 5
// points to each unit of Ability, so this says "about".
export const SectionPointsPerAbility = 5

// Where a Skill or Question Type sits against its Section level, in words.
export const levelText = (gap: number, section: string) => {
  const points = Math.round(gap * SectionPointsPerAbility)
  if (points === 0) return gap === 0 ? `Level with your ${section} level` : `Just ${gap > 0 ? "below" : "above"} your ${section} level`
  return `About ${Math.abs(points)} Section ${Math.abs(points) === 1 ? "point" : "points"} ${points > 0 ? "below" : "above"} your ${section} level`
}

export const paceText = (pace: number) => `${pace.toFixed(1)} times the Target Time`

export const percent = (right: number, answered: number) => (answered === 0 ? "none answered" : `${Math.round((100 * right) / answered)}%`)

export const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

// A Study Day as the server sends it, as a count of days, and back.
const DayMs = 24 * 60 * 60 * 1000
export const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DayMs
export const dayOfNumber = (number: number) => new Date(number * DayMs).toISOString().slice(0, 10)

// A day on a chart's axis: "Oct 3".
export const shortDay = (day: string) =>
  new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(Date.parse(`${day}T00:00:00Z`))
