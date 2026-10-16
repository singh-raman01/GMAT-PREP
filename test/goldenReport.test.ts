import { describe, expect, test } from "bun:test"
import { type GoldenEntry, goldenReport } from "../src/server/review/goldenReport.ts"

const item = { stem: "What is \\(x\\)?", options: [{ label: "A", text: "1" }, { label: "B", text: "2" }], key: "B" }
const tags = { primarySkill: "quant.algebra.linear-equations", secondarySkills: [] }

const entry = (number: number, agrees: boolean, exact = true): GoldenEntry => ({
  questionId: `q${number}`,
  set: "Problem Solving",
  number,
  expected: { ...item, ...tags },
  item: exact ? item : { ...item, key: "A" },
  tags: agrees ? tags : { primarySkill: "quant.algebra.quadratics", secondarySkills: [] }
})

describe("The golden report", () => {
  test("passes when text, Parts and keys are exact and tags agree at least 90% of the time", () => {
    const nineOfTen = goldenReport([...Array.from({ length: 9 }, (_, i) => entry(i + 1, true)), entry(10, false)], 0)
    expect(nineOfTen).toMatchObject({ items: 10, tagAgreement: 0.9, passed: true })
    expect(nineOfTen.misses.map((miss) => miss.number)).toEqual([10])
    const eightOfTen = goldenReport(
      [...Array.from({ length: 8 }, (_, i) => entry(i + 1, true)), entry(9, false), entry(10, false)],
      0
    )
    expect(eightOfTen).toMatchObject({ tagAgreement: 0.8, passed: false })
  })

  test("one key that differs fails it, whatever the tags", () => {
    const report = goldenReport([...Array.from({ length: 9 }, (_, i) => entry(i + 1, true)), entry(10, true, false)], 0)
    expect(report).toMatchObject({ keysExact: 9, tagAgreement: 1, passed: false })
    expect(report.misses[0]?.detail).toBe("Key A, not B.")
  })
})
