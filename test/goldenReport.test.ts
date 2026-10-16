import { describe, expect, test } from "bun:test"
import { type GoldenEntry, goldenReport } from "../src/server/review/goldenReport.ts"

const item = {
  passage: null,
  stem: "What is \\(x\\)?",
  options: [{ label: "A", text: "1" }, { label: "B", text: "2" }],
  key: "B"
}
const tags = { questionType: "quant.ps", primarySkill: "quant.algebra.linear-equations", secondarySkills: [] }

const entry = (number: number, agrees: boolean, exact = true): GoldenEntry => ({
  questionId: `q${number}`,
  set: "Problem Solving",
  number,
  expected: { ...item, ...tags },
  item: exact ? item : { ...item, key: "A" },
  tags: agrees ? tags : { ...tags, primarySkill: "quant.algebra.quadratics" }
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

  test("a passage that differs fails it, and a Question Type that differs counts against tag agreement", () => {
    const passage = "The committee met twice."
    const reading: GoldenEntry = {
      questionId: "q1",
      set: "Reading Comprehension",
      number: 1,
      expected: { ...item, passage, ...tags, questionType: "verbal.rc-inference" },
      item: { ...item, passage: "The committee met once." },
      tags: { ...tags, questionType: "verbal.rc-inference" }
    }
    const report = goldenReport([reading], 0)
    expect(report).toMatchObject({ textExact: 0, passed: false })
    expect(report.misses[0]?.detail).toContain("The passage text differs.")
    const typed = goldenReport([{ ...reading, item: { ...item, passage }, tags: { ...tags, questionType: "verbal.rc-main-idea" } }], 0)
    expect(typed).toMatchObject({ textExact: 1, tagAgreement: 0, passed: false })
    expect(typed.misses[0]?.detail).toContain("verbal.rc-main-idea")
  })

  test("one key that differs fails it, whatever the tags", () => {
    const report = goldenReport([...Array.from({ length: 9 }, (_, i) => entry(i + 1, true)), entry(10, true, false)], 0)
    expect(report).toMatchObject({ keysExact: 9, tagAgreement: 1, passed: false })
    expect(report.misses[0]?.detail).toBe("Key A, not B.")
  })
})
