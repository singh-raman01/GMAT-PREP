import { useEffect, useState } from "react"
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

export const WarningMs = 5 * 60 * 1000

export const Timer = (
  { remainingMs, hidden, onToggle }: {
    readonly remainingMs: number
    readonly hidden: boolean
    readonly onToggle: () => void
  }
) => (
  <div className="timer">
    {!hidden && (
      <span className={remainingMs <= WarningMs ? "timer-time timer-low" : "timer-time"}>
        <span className="visually-hidden">Time left:</span> {minutesAndSeconds(remainingMs)}
      </span>
    )}
    <button type="button" className="link-button" aria-pressed={hidden} onClick={onToggle}>
      {hidden ? "Show the timer" : "Hide the timer"}
    </button>
  </div>
)
