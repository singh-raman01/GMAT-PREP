import { useEffect, useState } from "react"
import { minutesAndSeconds, spokenDuration } from "../format.ts"

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

// The timer, which the Learner can hide, and a warning once the time left
// reaches warningMs, shown and announced whether the timer is shown or not.
// The warning says the time left when it showed: 5 minutes as the count
// passes them, or less when the screen opens later than that.
export const Timer = (
  { remainingMs, warningMs, hidden, onToggle }: {
    readonly remainingMs: number
    readonly warningMs: number
    readonly hidden: boolean
    readonly onToggle: () => void
  }
) => {
  const low = remainingMs <= warningMs
  const [warnedAt, setWarnedAt] = useState<number>()
  const [dismissed, setDismissed] = useState(false)
  if (low && remainingMs > 0 && warnedAt === undefined) setWarnedAt(remainingMs)
  return (
    <div className="timer">
      {!hidden && (
        <span className={low ? "timer-time timer-low" : "timer-time"}>
          <span className="visually-hidden">Time left:</span> {minutesAndSeconds(remainingMs)}
        </span>
      )}
      <button type="button" className="link-button" onClick={onToggle}>
        {hidden ? "Show the timer" : "Hide the timer"}
      </button>
      {warnedAt !== undefined && !dismissed && (
        <p className="timer-warning" role="alert">
          {spokenDuration(warnedAt)} left.
          <button type="button" className="link-button" onClick={() => setDismissed(true)}>OK</button>
        </p>
      )}
    </div>
  )
}
