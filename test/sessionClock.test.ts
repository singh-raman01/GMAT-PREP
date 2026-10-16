import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { type ClockState, fromSave, GapMs, tick } from "../src/server/practice/clock.ts"

const run = (start: ClockState, at: ReadonlyArray<number>, limitMs: number) => {
  let state = start
  const ticks = []
  for (const now of at) {
    const result = tick(state, now, limitMs)
    ticks.push(result)
    state = result.next
  }
  return { state, ticks }
}

describe("The Session clock", () => {
  test("counts each second, and saves every 5 seconds", () => {
    const { state, ticks } = run(fromSave(0, 0), [1000, 2000, 3000, 4000, 5000, 6000], 60_000)
    expect(state.elapsedMs).toBe(6000)
    expect(ticks.map((each) => each.save)).toEqual([false, false, false, false, true, false])
  })

  test("leaves a gap of more than 5 seconds uncounted and says it was lost", () => {
    const { state, ticks } = run(fromSave(0, 0), [1000, 2000, 30_000, 31_000], 60_000)
    expect(state.elapsedMs).toBe(3000)
    expect(ticks.map((each) => each.lost)).toEqual([false, false, true, false])
    // A clock that went back counts nothing either.
    expect(tick({ elapsedMs: 5000, lastTickAt: 10_000, savedAt: 10_000 }, 9000, 60_000)).toMatchObject({
      lost: true,
      next: { elapsedMs: 5000 }
    })
  })

  test("goes on from its last save after a restart, losing the time since", () => {
    // Saved at 5 seconds elapsed; the app stopped and came back a minute later.
    const restarted = tick(fromSave(5000, 5000), 65_000, 60_000)
    expect(restarted).toMatchObject({ lost: true, save: true, next: { elapsedMs: 5000 } })
    expect(tick(restarted.next, 66_000, 60_000).next.elapsedMs).toBe(6000)
  })

  test("stops at the limit and says so", () => {
    const { state, ticks } = run(fromSave(58_500, 0), [1000, 2000], 60_000)
    expect(state.elapsedMs).toBe(60_000)
    expect(ticks.map((each) => each.expired)).toEqual([false, true])
  })

  test("never counts more than the time that passed, nor a gap's worth at once", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 20_000 }), { maxLength: 50 }), (steps) => {
      let now = 0
      const at = steps.map((step) => (now += step))
      const { state } = run(fromSave(0, 0), at, Number.MAX_SAFE_INTEGER)
      const counted = steps.filter((step) => step <= GapMs).reduce((sum, step) => sum + step, 0)
      expect(state.elapsedMs).toBe(counted)
      expect(state.elapsedMs).toBeLessThanOrEqual(now)
    }))
  })
})
