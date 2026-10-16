import { describe, expect, test } from "bun:test"
import {
  endingOf,
  mistakeWeeksOf,
  pacesOf,
  pacingOf,
  studyDaysOf,
  type TimedAnswer,
  trendOf
} from "../src/server/analytics/views.ts"
import { UncalibratedLine } from "../src/server/ratings/scale.ts"

// The analytics views (docs/design.md, "Analytics") as rules over facts.

const lines = { quant: UncalibratedLine, verbal: UncalibratedLine, di: UncalibratedLine }

describe("Score trend", () => {
  test("keeps each Section's last estimate of a Study Day, and the Total once all three have one", () => {
    const trend = trendOf([
      { section: "quant", day: 1, order: 1, ability: 0, standardError: 0.5 },
      { section: "quant", day: 1, order: 2, ability: 1, standardError: 0.4 },
      { section: "verbal", day: 2, order: 3, ability: 0, standardError: 0.5 },
      { section: "di", day: 3, order: 4, ability: -1, standardError: 0.5 },
      { section: "quant", day: 4, order: 5, ability: 2, standardError: 0.3 }
    ], lines)
    expect(trend.sections.get("quant")!.map((point) => [point.day, point.score])).toEqual([[1, 80], [4, 85]])
    // On day 3: 80, 75 and 70 make 225 above 180, so 205 + 45 × 20/3 = 505.
    expect(trend.total.map((point) => [point.day, point.score])).toEqual([[3, 505], [4, 535]])
    for (const point of trend.total) expect(point.low <= point.score && point.score <= point.high).toBe(true)
  })
})

const timed = (changes: Partial<TimedAnswer>): TimedAnswer => ({
  sessionId: "s1",
  kind: "sectional",
  position: 0,
  questionType: "quant.ps",
  correct: true,
  timedOut: false,
  timeSpentMs: 120_000,
  targetMs: 120_000,
  servedElapsedMs: 0,
  strategy: null,
  ...changes
})

describe("Timing", () => {
  test("takes the median time over Target Time by Question Type and by Strategy, time-outs left out", () => {
    const paces = pacesOf([
      timed({ timeSpentMs: 60_000, strategy: "quant.strategy.work-backward" }),
      timed({ timeSpentMs: 180_000, strategy: "quant.strategy.work-backward" }),
      timed({ timeSpentMs: 240_000 }),
      timed({ timeSpentMs: 999_000, timedOut: true }),
      timed({ questionType: "di.ds", timeSpentMs: 90_000, targetMs: 135_000 })
    ])
    expect(paces.questionTypes.get("quant.ps")).toEqual({ median: 1.5, answers: 3 })
    expect(paces.questionTypes.get("di.ds")!.median).toBeCloseTo(2 / 3, 10)
    expect(paces.strategies.get("quant.strategy.work-backward")).toEqual({ median: 1, answers: 2 })
  })

  test("sets each Section's last 5 Questions against the rest, and draws a Mock Section's pace against an even one", () => {
    const section = Array.from({ length: 8 }, (_, position) =>
      timed({ position, correct: position < 3, servedElapsedMs: position * 300_000, timeSpentMs: 300_000 })
    )
    expect(endingOf([...section, timed({ kind: "practice", correct: false })])).toEqual({
      last: { right: 0, answered: 5 },
      rest: { right: 3, answered: 3 }
    })
    const curve = pacingOf(section, 2_700_000, 9)
    expect(curve[0]).toEqual({ question: 1, usedMs: 300_000, evenMs: 300_000 })
    expect(curve.at(-1)).toEqual({ question: 8, usedMs: 2_400_000, evenMs: 2_400_000 })
  })
})

describe("Mistakes", () => {
  test("are counted per 100 Questions answered, 7 Study Days at a time, from the first week with an answer", () => {
    const weeks = mistakeWeeksOf(
      [100, 100, 99, 95, 94, 93, 92],
      [
        { day: 100, mistakeType: "trap", trapPattern: "quant.trap.wrong-quantity" },
        { day: 93, mistakeType: "trap", trapPattern: null },
        { day: 92, mistakeType: "misread", trapPattern: null }
      ],
      100,
      4
    )
    expect(weeks.map((week) => [week.from, week.to, week.questions])).toEqual([[87, 93, 2], [94, 100, 5]])
    expect(Object.fromEntries(weeks[0]!.mistakeTypes)).toEqual({ trap: 50, misread: 50 })
    expect(Object.fromEntries(weeks[1]!.mistakeTypes)).toEqual({ trap: 20 })
    expect(Object.fromEntries(weeks[1]!.trapPatterns)).toEqual({ "quant.trap.wrong-quantity": 20 })
  })
})

describe("Study", () => {
  test("gives each Study Day its minutes, Questions, accuracy by Section where shown, and Mocks", () => {
    const days = studyDaysOf([
      { day: 5, section: "quant", timeSpentMs: 90_000, correct: true },
      { day: 5, section: "quant", timeSpentMs: 60_000, correct: false },
      { day: 5, section: "verbal", timeSpentMs: 30_000, correct: null },
      { day: 7, section: "di", timeSpentMs: 120_000, correct: true }
    ], [7])
    expect(days.map((day) => [day.day, day.minutes, day.questions, day.mocks])).toEqual([[5, 3, 3, 0], [7, 2, 1, 1]])
    expect(Object.fromEntries(days[0]!.sections)).toEqual({ quant: { right: 1, answered: 2 } })
  })
})
