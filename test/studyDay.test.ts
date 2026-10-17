import { describe, expect, test } from "bun:test"
import {
  calendarDaysUnder,
  type DayRule,
  nextRolloverUnder,
  studyDayOf,
  studyDays,
  studyDayStart,
  studyDaysUnder,
  studyDayStartUnder
} from "../src/api/studyDay.ts"

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

describe("Many Study Days at once", () => {
  test("agree with one at a time, in zones a quarter or half hour off and across daylight saving", () => {
    for (const [zone, rollover] of [["Asia/Kathmandu", 4], ["Asia/Kolkata", 0], ["America/Los_Angeles", 4], ["Australia/Lord_Howe", 3]] as const) {
      const days = studyDays(zone, rollover)
      // Every 7 minutes over two months that hold a daylight saving change.
      for (let at = Date.UTC(2026, 9, 1); at < Date.UTC(2026, 11, 1); at += 7 * 60 * 1000) {
        expect(days(at)).toBe(studyDayOf(at, zone, rollover))
      }
    }
  })
})

describe("Day rules: a time zone or rollover change from the next rollover", () => {
  const NewYork: DayRule = { from: Number.NEGATIVE_INFINITY, timeZone: "America/New_York", rolloverHour: 4 }

  test("one rule gives the same Study Days as before", () => {
    const days = studyDaysUnder([NewYork])
    for (let at = Date.UTC(2026, 9, 1); at < Date.UTC(2026, 9, 20); at += 37 * 60 * 1000) {
      expect(days(at)).toBe(studyDayOf(at, "America/New_York", 4))
    }
  })

  test("a change set mid-day takes effect at the next rollover, and days before it stay as they were", () => {
    // Set at noon in New York on 5 October; the next rollover is 4 am on the 6th.
    const setAt = Date.UTC(2026, 9, 5, 16)
    const from = nextRolloverUnder([NewYork], setAt)
    expect(from).toBe(Date.UTC(2026, 9, 6, 8))
    const rules = [NewYork, { from, timeZone: "Asia/Taipei", rolloverHour: 4 }]
    const days = studyDaysUnder(rules)
    expect(days(setAt)).toBe(day("2026-10-05"))
    expect(days(from - 1)).toBe(day("2026-10-05"))
    // At 8:00 UTC it is 16:00 in Taipei on the 6th.
    expect(days(from)).toBe(day("2026-10-06"))
    // The 6th ends at 4 am in Taipei on the 7th, a short day.
    expect(days(Date.UTC(2026, 9, 6, 19, 59))).toBe(day("2026-10-06"))
    expect(days(Date.UTC(2026, 9, 6, 20))).toBe(day("2026-10-07"))
  })

  test("a change to a zone behind never goes back to a day already ended", () => {
    const Taipei: DayRule = { from: Number.NEGATIVE_INFINITY, timeZone: "Asia/Taipei", rolloverHour: 4 }
    const from = nextRolloverUnder([Taipei], Date.UTC(2026, 9, 5, 4))
    // 4 am in Taipei on the 6th is 20:00 UTC on the 5th.
    expect(from).toBe(Date.UTC(2026, 9, 5, 20))
    const days = studyDaysUnder([Taipei, { from, timeZone: "America/Los_Angeles", rolloverHour: 4 }])
    expect(days(from - 1)).toBe(day("2026-10-05"))
    // Los Angeles is still on the 5th at 13:00, so the 6th starts at once and
    // lasts until 4 am on the 7th there.
    expect(days(from)).toBe(day("2026-10-06"))
    expect(days(Date.UTC(2026, 9, 7, 10, 59))).toBe(day("2026-10-06"))
    expect(days(Date.UTC(2026, 9, 7, 11))).toBe(day("2026-10-07"))
    // Every moment's day is at least the one before it.
    let before = days(Date.UTC(2026, 9, 4))
    for (let at = Date.UTC(2026, 9, 4); at < Date.UTC(2026, 9, 10); at += 11 * 60 * 1000) {
      const now = days(at)
      expect(now).toBeGreaterThanOrEqual(before)
      before = now
    }
  })

  test("a rollover hour change keeps each day whole", () => {
    const from = nextRolloverUnder([NewYork], Date.UTC(2026, 9, 5, 16))
    const days = studyDaysUnder([NewYork, { from, timeZone: "America/New_York", rolloverHour: 0 }])
    expect(days(from)).toBe(day("2026-10-06"))
    expect(studyDayStartUnder([NewYork, { from, timeZone: "America/New_York", rolloverHour: 0 }], day("2026-10-07")))
      .toBe(Date.UTC(2026, 9, 7, 4))
  })

  test("a 23- or 25-hour Study Day is one day", () => {
    const days = studyDaysUnder([NewYork])
    // New York moves its clocks back at 2 am on 1 November 2026, so the
    // Study Day from 4 am on 31 October has 25 hours, and the one from 4 am
    // on 8 March 2026 had 23.
    const start = studyDayStartUnder([NewYork], day("2026-10-31"))
    const end = studyDayStartUnder([NewYork], day("2026-11-01"))
    expect(end - start).toBe(25 * 60 * 60 * 1000)
    expect(days(start)).toBe(day("2026-10-31"))
    expect(days(end - 1)).toBe(day("2026-10-31"))
    expect(studyDayStartUnder([NewYork], day("2026-03-08")) - studyDayStartUnder([NewYork], day("2026-03-07")))
      .toBe(23 * 60 * 60 * 1000)
  })

  test("calendar days follow the zone in effect", () => {
    const from = Date.UTC(2026, 9, 6, 8)
    const dates = calendarDaysUnder([NewYork, { from, timeZone: "Asia/Taipei", rolloverHour: 4 }])
    expect(dates(Date.UTC(2026, 9, 6, 3))).toBe(day("2026-10-05"))
    expect(dates(Date.UTC(2026, 9, 6, 17))).toBe(day("2026-10-07"))
  })
})
