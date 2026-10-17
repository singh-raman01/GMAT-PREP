import { useEffect, useRef, useState } from "react"
import { minutesAndSeconds } from "../format.ts"

// The time left in a timed set. The server owns the clock: this counts down
// from the time it last sent, and the set screen reads it again on every
// Response and every 15 seconds.

export interface ClockReading {
  readonly remainingMs: number
  readonly paused: boolean
  // When the reading arrived, by performance.now().
  readonly at: number
}

// The time left now, from the last reading, updated four times a second.
export const useRemaining = (reading: ClockReading | undefined): number | undefined => {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (reading === undefined || reading.paused) return
    const timer = setInterval(() => setNow(performance.now()), 250)
    return () => clearInterval(timer)
  }, [reading])
  if (reading === undefined) return undefined
  return reading.paused ? reading.remainingMs : Math.max(0, reading.remainingMs - (now - reading.at))
}

// The time left turns to a warning in the last 5 minutes, or the last fifth
// of a set shorter than that allows.
export const warningFor = (limitMs: number) => Math.min(5 * 60 * 1000, limitMs / 5)

// What the warning says, from the time left when it showed, rounded up so
// that it stays true while it shows: to whole minutes, or to tens of seconds
// from 50 seconds down.
export const warningText = (remainingMs: number) => {
  if (remainingMs > 50_000) {
    const minutes = Math.ceil(remainingMs / 60_000)
    return `Under ${minutes} ${minutes === 1 ? "minute" : "minutes"} left.`
  }
  return `Under ${Math.max(1, Math.ceil(remainingMs / 10_000)) * 10} seconds left.`
}

// The timer, which the Learner can hide, and a warning once the time left
// reaches warningMs, shown and announced whether the timer is shown or not,
// until dismissed. The screen keeps both choices (timerChoices.ts).
export const Timer = (
  { remainingMs, warningMs, hidden, onToggle, dismissed, onDismiss }: {
    readonly remainingMs: number
    readonly warningMs: number
    readonly hidden: boolean
    readonly onToggle: () => void
    readonly dismissed: boolean
    readonly onDismiss: () => void
  }
) => {
  const low = remainingMs <= warningMs
  const [warnedAt, setWarnedAt] = useState<number>()
  const toggle = useRef<HTMLButtonElement>(null)
  if (low && remainingMs > 0 && warnedAt === undefined) setWarnedAt(remainingMs)
  return (
    <div className="timer">
      {!hidden && (
        <span className={low ? "timer-time timer-low" : "timer-time"}>
          <span className="visually-hidden">Time left:</span> {minutesAndSeconds(remainingMs)}
        </span>
      )}
      <button ref={toggle} type="button" className="link-button" onClick={onToggle}>
        {hidden ? "Show the timer" : "Hide the timer"}
      </button>
      {warnedAt !== undefined && !dismissed && (
        <div className="timer-warning">
          <p role="alert">{warningText(warnedAt)}</p>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              onDismiss()
              // The button goes with the warning; focus stays by the timer.
              toggle.current?.focus()
            }}
          >
            Dismiss<span className="visually-hidden"> the time warning</span>
          </button>
        </div>
      )}
    </div>
  )
}
