import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import {
  KeepDaily,
  KeepEvents,
  KeepWeekly,
  keptSnapshots,
  type SnapshotEntry,
  type SnapshotKind,
  SnapshotKinds,
  weekOf
} from "../src/server/snapshots/retention.ts"

// Which snapshots are kept (decision 110).

const DayMs = 86_400_000
// Monday 2 November 2026, as days since 1970.
const Monday = Date.UTC(2026, 10, 2) / DayMs

const daily = (day: number): SnapshotEntry => ({ id: `daily-${day}`, kind: "daily", at: day * DayMs + 3_600_000, day })
const event = (kind: SnapshotKind, at: number): SnapshotEntry => ({ id: `${kind}-${at}`, kind, at, day: Math.floor(at / DayMs) })

describe("Snapshot retention", () => {
  test("weeks start on Monday", () => {
    expect(weekOf(Monday)).toBe(weekOf(Monday + 6))
    expect(weekOf(Monday - 1)).toBe(weekOf(Monday) - 1)
  })

  test("keeps the 7 latest daily snapshots, and the first of each of the 4 weeks before them", () => {
    // Every day for ten weeks, the last a Sunday.
    const all = Array.from({ length: 70 }, (_, index) => daily(Monday - 63 + index))
    const kept = keptSnapshots(all)
    const last = Monday + 6
    const days = all.filter((entry) => kept.has(entry.id)).map((entry) => entry.day - last).toSorted((a, b) => a - b)
    // The last 7 days, then the Mondays of the 4 weeks before.
    expect(days).toEqual([-34, -27, -20, -13, -6, -5, -4, -3, -2, -1, 0])
  })

  test("a week with a few days missed keeps its first snapshot taken", () => {
    const all = [daily(Monday - 12), daily(Monday - 10), ...Array.from({ length: 7 }, (_, index) => daily(Monday + index))]
    const kept = keptSnapshots(all)
    expect(kept.has(daily(Monday - 12).id)).toBe(true)
    expect(kept.has(daily(Monday - 10).id)).toBe(false)
  })

  test("keeps the 10 latest snapshots taken before a change, of any kind, beside the daily ones", () => {
    const events = Array.from({ length: 14 }, (_, index) =>
      event(SnapshotKinds[1 + (index % (SnapshotKinds.length - 1))]!, Monday * DayMs + index * 60_000)
    )
    const kept = keptSnapshots([...events, daily(Monday)])
    expect(events.filter((entry) => kept.has(entry.id)).map((entry) => entry.id)).toEqual(events.slice(4).map((entry) => entry.id))
    expect(kept.has(daily(Monday).id)).toBe(true)
  })

  test("never keeps more than it should, always keeps the latest of each kind, and keeping again changes nothing", () => {
    const entryArb = fc.record({
      kind: fc.constantFrom(...SnapshotKinds),
      day: fc.integer({ min: Monday - 120, max: Monday }),
      minute: fc.integer({ min: 0, max: 1439 })
    })
    fc.assert(fc.property(fc.array(entryArb, { maxLength: 120 }), (raw) => {
      // One daily snapshot a day, as the app takes them.
      const seenDays = new Set<number>()
      const entries = raw.flatMap((each, index): Array<SnapshotEntry> => {
        if (each.kind === "daily") {
          if (seenDays.has(each.day)) return []
          seenDays.add(each.day)
        }
        return [{ id: `s${index}`, kind: each.kind, day: each.day, at: each.day * DayMs + each.minute * 60_000 }]
      })
      const kept = keptSnapshots(entries)
      expect(kept.size).toBeLessThanOrEqual(KeepDaily + KeepWeekly + KeepEvents)
      for (const kind of SnapshotKinds) {
        const latest = entries.filter((entry) => entry.kind === kind).toSorted((a, b) => b.at - a.at)[0]
        if (latest !== undefined) expect(kept.has(latest.id)).toBe(true)
      }
      const again = keptSnapshots(entries.filter((entry) => kept.has(entry.id)))
      expect([...again].toSorted()).toEqual([...kept].toSorted())
    }), { numRuns: 300 })
  })
})
