import { describe, expect, test } from "bun:test"
import { type GoldenEntry, type GoldenItem, goldenReport } from "../src/server/review/goldenReport.ts"

const item: GoldenItem = {
  stimulus: null,
  stem: "What is \\(x\\)?",
  parts: [{ prompt: null, options: [{ label: "A", text: "1" }, { label: "B", text: "2" }] }],
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
    const passage = "The passage:\nThe committee met twice."
    const reading: GoldenEntry = {
      questionId: "q1",
      set: "Reading Comprehension",
      number: 1,
      expected: { ...item, stimulus: passage, ...tags, questionType: "verbal.rc-inference" },
      item: { ...item, stimulus: "The passage:\nThe committee met once." },
      tags: { ...tags, questionType: "verbal.rc-inference" }
    }
    const report = goldenReport([reading], 0)
    expect(report).toMatchObject({ textExact: 0, passed: false })
    expect(report.misses[0]?.detail).toContain("The passage differs.")
    const typed = goldenReport([{ ...reading, item: { ...item, stimulus: passage }, tags: { ...tags, questionType: "verbal.rc-main-idea" } }], 0)
    expect(typed).toMatchObject({ textExact: 1, tagAgreement: 0, passed: false })
    expect(typed.misses[0]?.detail).toContain("verbal.rc-main-idea")
  })

  test("one key that differs fails it, whatever the tags", () => {
    const report = goldenReport([...Array.from({ length: 9 }, (_, i) => entry(i + 1, true)), entry(10, true, false)], 0)
    expect(report).toMatchObject({ keysExact: 9, tagAgreement: 1, passed: false })
    expect(report.misses[0]?.detail).toBe("Key A, not B.")
  })
})

describe("The golden report on Questions with several Parts", () => {
  const statements = (keys: string, words = "North sold the most.") => ({
    stimulus: "The table:\nSales by region.\n\nThe table:\nRegion | Sales\nNorth | 1,200",
    stem: "For each statement, choose Yes if it is true.",
    parts: [words, "Every region grew."].map((prompt) => ({
      prompt,
      options: [{ label: "A", text: "Yes" }, { label: "B", text: "No" }]
    })),
    key: keys
  })
  const tagged = { questionType: "di.ta", primarySkill: "di.table-analysis", secondarySkills: [] }

  test("passes when every Part's words and key match, and names what differs otherwise", () => {
    const entry = (read: GoldenItem): GoldenEntry => ({
      questionId: "q1",
      set: "Table Analysis",
      number: 1,
      expected: { ...statements("A,B"), ...tagged },
      item: read,
      tags: tagged
    })
    expect(goldenReport([entry(statements("A,B"))], 0)).toMatchObject({ passed: true })
    const wrongKey = goldenReport([entry(statements("A,A"))], 0)
    expect(wrongKey).toMatchObject({ keysExact: 0, textExact: 1, passed: false })
    expect(wrongKey.misses[0]?.detail).toBe("Key A,A, not A,B.")
    const reworded = goldenReport([entry(statements("A,B", "North sold more."))], 0)
    expect(reworded).toMatchObject({ textExact: 0, keysExact: 1, passed: false })
    expect(reworded.misses[0]?.detail).toBe("Answer choice text differs.")
    const fewer = goldenReport([entry({ ...statements("A"), parts: statements("A").parts.slice(0, 1) })], 0)
    expect(fewer).toMatchObject({ textExact: 0, partsExact: 0, passed: false })
  })
})
