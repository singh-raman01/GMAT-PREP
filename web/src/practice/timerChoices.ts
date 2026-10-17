import { useState } from "react"

// Two of the timer's choices outlast the screen (decision 126): a hidden
// timer stays hidden for the rest of its Session, through a reload and into
// a Mock's next Sections, and a dismissed warning stays dismissed for its
// clock, through a pause or a reload. Kept in this browser, as the Display
// choice is, for the latest Sessions only.

const StorageKey = "gmat-prep-timer"

// How many ids each list keeps.
export const KeptIds = 50

export interface TimerChoices {
  // The Sessions whose timer is hidden: Practice Sets, Sectionals and Mocks.
  readonly hidden: ReadonlyArray<string>
  // The clocks whose warning was dismissed: Practice Sets, Sectionals and
  // the Sections of a Mock, as each has a clock of its own.
  readonly dismissed: ReadonlyArray<string>
}

const NoChoices: TimerChoices = { hidden: [], dismissed: [] }

const idsOf = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(-KeptIds) : []

// What was saved, with anything not understood left out.
export const parseTimerChoices = (saved: string | null): TimerChoices => {
  if (saved === null) return NoChoices
  try {
    const value: unknown = JSON.parse(saved)
    if (typeof value !== "object" || value === null) return NoChoices
    const { hidden, dismissed } = value as { readonly hidden?: unknown; readonly dismissed?: unknown }
    return { hidden: idsOf(hidden), dismissed: idsOf(dismissed) }
  } catch {
    return NoChoices
  }
}

// The ids with this one added last, or taken out; the oldest go past
// KeptIds.
export const withChoice = (ids: ReadonlyArray<string>, id: string, on: boolean): ReadonlyArray<string> => {
  const others = ids.filter((each) => each !== id)
  return on ? [...others, id].slice(-KeptIds) : others
}

const storage = () => {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

const readChoices = (): TimerChoices => {
  try {
    return parseTimerChoices(storage()?.getItem(StorageKey) ?? null)
  } catch {
    return NoChoices
  }
}

// One choice for one Session or clock, read when the screen opens. Storage
// that is off or refused keeps it for as long as the screen is open.
export const useTimerChoice = (list: keyof TimerChoices, id: string): readonly [boolean, (on: boolean) => void] => {
  const [on, setOn] = useState(() => readChoices()[list].includes(id))
  const change = (next: boolean) => {
    setOn(next)
    const saved = readChoices()
    try {
      storage()?.setItem(StorageKey, JSON.stringify({ ...saved, [list]: withChoice(saved[list], id, next) }))
    } catch {
      // Kept while the screen is open.
    }
  }
  return [on, change]
}
