import type { RestoreBlocked, SnapshotView } from "../../../src/api/Snapshots.ts"
import { dayAndSecond, dayAndTime } from "../format.ts"

// How the Data page words sizes, times and a restore that must wait.

export const sizeText = (bytes: number | null) =>
  bytes === null
    ? "size unknown"
    : bytes === 0
    ? "empty"
    : bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : bytes < 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`

// When each snapshot was taken, to the second where two share a minute, so
// no two rows read the same.
export const takenTexts = (snapshots: ReadonlyArray<Pick<SnapshotView, "id" | "takenAt">>) => {
  const minuteOf = (takenAt: number) => Math.floor(takenAt / 60_000)
  const counts = new Map<number, number>()
  for (const snapshot of snapshots) counts.set(minuteOf(snapshot.takenAt), (counts.get(minuteOf(snapshot.takenAt)) ?? 0) + 1)
  return new Map(snapshots.map((snapshot) => [
    snapshot.id,
    (counts.get(minuteOf(snapshot.takenAt)) ?? 0) > 1 ? dayAndSecond(snapshot.takenAt) : dayAndTime(snapshot.takenAt)
  ]))
}

// Why a restore waits, naming the Learner whose Session it would cut short.
export const blockedText = (failure: Pick<RestoreBlocked, "reason" | "learner" | "session" | "paused">) => {
  if (failure.reason === "job-running") {
    return "A job is running or waiting to run. Pause it on the Jobs page, or let it finish, then restore."
  }
  const who = failure.learner ?? "A Learner"
  if (failure.paused) return `${who} has paused a timed set. Restore once they have finished it.`
  const what = failure.session === "mock" ? "a Mock" : failure.session === "sectional" ? "a Sectional" : "a timed set"
  return `${who} is in ${what}. Restore once it has ended.`
}
