import { type SnapshotKind, SnapshotKinds } from "./retention.ts"

// A snapshot's file name says its kind and when it was taken, so files found
// in the folder without a record can be recorded from their names.

export const SnapshotFolder = "snapshots"

export const snapshotFileName = (kind: string, at: number, tag?: string) =>
  `${kind}-${new Date(at).toISOString().replace(/[:.]/g, "-")}${tag === undefined ? "" : `-${tag}`}.sqlite`

const NamePattern = /^([a-z-]+?)-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-[0-9a-f]+)?\.sqlite$/

// The kind and time a snapshot's file name gives, or none for another file.
export const parseSnapshotName = (name: string): { readonly kind: SnapshotKind; readonly at: number } | undefined => {
  const found = NamePattern.exec(name)
  if (found === null) return undefined
  const kind = SnapshotKinds.find((each) => each === found[1])
  if (kind === undefined) return undefined
  const [year, month, day, hour, minute, second, millis] = found.slice(2).map(Number) as [number, number, number, number, number, number, number]
  return { kind, at: Date.UTC(year, month - 1, day, hour, minute, second, millis) }
}
