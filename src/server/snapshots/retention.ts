// Which snapshots are kept (docs/design.md, "Data safety and operations",
// decision 110): the 7 latest daily snapshots, the first daily snapshot of
// each of the 4 latest weeks before them, and the 10 latest snapshots taken
// before a change. The rest are deleted.

export const SnapshotKinds = [
  "daily",
  "pre-migration",
  "pre-taxonomy",
  "pre-rescore",
  "pre-deletion",
  "pre-restore",
  "manual"
] as const
export type SnapshotKind = (typeof SnapshotKinds)[number]

export const KeepDaily = 7
export const KeepWeekly = 4
export const KeepEvents = 10

export interface SnapshotEntry {
  readonly id: string
  readonly kind: SnapshotKind
  // When it was taken, and on which day of the app's calendar, as days since
  // 1970-01-01.
  readonly at: number
  readonly day: number
}

// Weeks start on Monday: day 0, 1 January 1970, was a Thursday.
export const weekOf = (day: number) => Math.floor((day + 3) / 7)

const latestFirst = (a: SnapshotEntry, b: SnapshotEntry) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

// The ids of the snapshots to keep, among those taken and still on disk.
export const keptSnapshots = (entries: ReadonlyArray<SnapshotEntry>): ReadonlySet<string> => {
  const daily = entries.filter((entry) => entry.kind === "daily").toSorted(latestFirst)
  const kept = new Set(daily.slice(0, KeepDaily).map((entry) => entry.id))
  // Each older week's first daily snapshot.
  const firstOfWeek = new Map<number, SnapshotEntry>()
  for (const entry of daily.slice(KeepDaily)) {
    const week = weekOf(entry.day)
    const found = firstOfWeek.get(week)
    if (found === undefined || latestFirst(entry, found) > 0) firstOfWeek.set(week, entry)
  }
  for (const [, entry] of [...firstOfWeek].toSorted((a, b) => b[0] - a[0]).slice(0, KeepWeekly)) kept.add(entry.id)
  for (const entry of entries.filter((each) => each.kind !== "daily").toSorted(latestFirst).slice(0, KeepEvents)) kept.add(entry.id)
  return kept
}
