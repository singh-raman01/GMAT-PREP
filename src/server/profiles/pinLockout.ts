// Five wrong PINs lock a Profile for five minutes. While locked, the PIN is not
// even checked. The count restarts when the lock ends or a PIN is accepted.

export const MaxWrongPins = 5
export const LockMillis = 5 * 60 * 1000

export interface PinState {
  readonly failedAttempts: number
  readonly lockedUntil: number | null
}

export type PinAttempt =
  | { readonly _tag: "Accepted"; readonly next: PinState }
  | { readonly _tag: "Rejected"; readonly attemptsLeft: number; readonly next: PinState }
  | { readonly _tag: "Locked"; readonly lockedUntil: number; readonly next: PinState }

export const isLocked = (state: PinState, now: number): boolean =>
  state.lockedUntil !== null && now < state.lockedUntil

export const attemptPin = (state: PinState, now: number, correct: boolean): PinAttempt => {
  if (state.lockedUntil !== null && now < state.lockedUntil) {
    return { _tag: "Locked", lockedUntil: state.lockedUntil, next: state }
  }
  if (correct) {
    return { _tag: "Accepted", next: { failedAttempts: 0, lockedUntil: null } }
  }
  const failed = (state.lockedUntil === null ? state.failedAttempts : 0) + 1
  if (failed >= MaxWrongPins) {
    const lockedUntil = now + LockMillis
    return { _tag: "Locked", lockedUntil, next: { failedAttempts: 0, lockedUntil } }
  }
  return {
    _tag: "Rejected",
    attemptsLeft: MaxWrongPins - failed,
    next: { failedAttempts: failed, lockedUntil: null }
  }
}
