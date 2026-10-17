import { describe, expect, test } from "bun:test"
import { studyDayOf, studyDayStart } from "../src/api/studyDay.ts"

const DayMs = 24 * 60 * 60 * 1000
const day = (text: string) => Date.parse(`${text}T00:00:00Z`) / DayMs

describe("A Study Day's start", () => {
  test("is the first moment of the local day at the rollover hour, in any zone", () => {
    expect(studyDayStart(day("2026-10-02"), "UTC", 0)).toBe(Date.UTC(2026, 9, 2))
    expect(studyDayStart(day("2026-10-02"), "UTC", 4)).toBe(Date.UTC(2026, 9, 2, 4))
    // Auckland is 13 hours ahead in October, Los Angeles 7 behind.
    expect(studyDayStart(day("2026-10-02"), "Pacific/Auckland", 0)).toBe(Date.UTC(2026, 9, 1, 11))
    expect(studyDayStart(day("2026-10-02"), "America/Los_Angeles", 0)).toBe(Date.UTC(2026, 9, 2, 7))
    expect(studyDayStart(day("2026-10-02"), "Pacific/Kiritimati", 0)).toBe(Date.UTC(2026, 9, 1, 10))
  })

  test("follows daylight saving, and the moment before it is the day before", () => {
    // Los Angeles moves its clocks back on 1 November 2026.
    const start = studyDayStart(day("2026-11-02"), "America/Los_Angeles", 4)
    expect(start).toBe(Date.UTC(2026, 10, 2, 12))
    expect(studyDayOf(start, "America/Los_Angeles", 4)).toBe(day("2026-11-02"))
    expect(studyDayOf(start - 1, "America/Los_Angeles", 4)).toBe(day("2026-11-01"))
  })
})
