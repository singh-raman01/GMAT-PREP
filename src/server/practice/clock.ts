// A timed Session's clock as the server keeps it (ADR 0009). The server
// ticks every second and saves the elapsed time every 5 seconds. A gap of
// more than 5 seconds between ticks means the process stopped or the
// machine slept: that time is not counted, and the Session is marked
// interrupted. After a restart the clock goes on from its last save.

export const TickMs = 1000
export const SaveEveryMs = 5000
export const GapMs = 5000

export interface ClockState {
  readonly elapsedMs: number
  // When the clock last counted, by the server's clock.
  readonly lastTickAt: number
  readonly savedAt: number
}

export interface Tick {
  readonly next: ClockState
  // The time since the last tick was not counted.
  readonly lost: boolean
  readonly save: boolean
  readonly expired: boolean
}

export const tick = (state: ClockState, now: number, limitMs: number): Tick => {
  const gap = now - state.lastTickAt
  const lost = gap > GapMs || gap < 0
  const elapsedMs = Math.min(limitMs, state.elapsedMs + (lost ? 0 : gap))
  const expired = elapsedMs >= limitMs
  const save = lost || expired || now - state.savedAt >= SaveEveryMs
  return { next: { elapsedMs, lastTickAt: now, savedAt: save ? now : state.savedAt }, lost, save, expired }
}

// The clock as last saved, picked up again: from the save, so the time
// since it, if longer than a gap, is lost.
export const fromSave = (elapsedMs: number, savedAt: number): ClockState => ({ elapsedMs, lastTickAt: savedAt, savedAt })
