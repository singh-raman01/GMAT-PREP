import { describe, expect, test } from "bun:test"
import type { MapRangeInput } from "../src/api/Books.ts"
import { assembleMap, chapterKey, mapProblems, type SurveyedPage, tidyMap } from "../src/server/books/bookMap.ts"
import { spread } from "../src/server/books/intakeJob.ts"
import type { PageSurvey } from "../src/server/books/survey.ts"

const page = (number: number, survey: PageSurvey | null): SurveyedPage => ({ number, survey })
const q = (group: PageSurvey["group"], chapter: string | null): PageSurvey => ({ role: "questions", group, chapter })
const key = (group: PageSurvey["group"], chapter: string | null): PageSurvey => ({ role: "answer-key", group, chapter })
const explained = (group: PageSurvey["group"], chapter: string | null): PageSurvey => ({
  role: "explanations",
  group,
  chapter
})
const other: PageSurvey = { role: "other", group: null, chapter: null }

describe("Proposing a Book Map", () => {
  test("neighbouring pages of one kind join, and an unsurveyed page joins only between two of them", () => {
    expect(assembleMap([
      page(1, other),
      page(2, q("ps", "Problem Solving")),
      page(3, null),
      page(4, q("ps", "Problem Solving")),
      page(5, null),
      page(6, other),
      page(7, q("ps", "Problem Solving"))
    ])).toEqual([
      { role: "questions", firstPage: 2, lastPage: 4, set: "Problem Solving", group: "ps" },
      { role: "questions", firstPage: 7, lastPage: 7, set: "Problem Solving", group: "ps" }
    ])
  })

  test("chapter titles match whatever their numbering, and the set takes the commonest spelling", () => {
    expect(chapterKey("5.0 Problem Solving")).toBe("problem solving")
    expect(chapterKey("Chapter 5: Problem  solving")).toBe("problem solving")
    expect(assembleMap([
      page(10, q("ps", "5.0 Problem Solving")),
      page(11, q("ps", "Chapter 5 Problem Solving")),
      page(12, q("ps", "5.0 Problem Solving"))
    ])).toEqual([{ role: "questions", firstPage: 10, lastPage: 12, set: "5.0 Problem Solving", group: "ps" }])
  })

  test("keys and explanations join the questions of their chapter, or else the nearest earlier ones of their group", () => {
    const ranges = assembleMap([
      page(1, q("ps", "Diagnostic")),
      page(2, q("ds", "Diagnostic Data Sufficiency")),
      page(3, key("mixed", "Diagnostic Answer Key")),
      page(4, q("ps", "Problem Solving")),
      page(5, key("ps", null)),
      page(6, explained("ps", "Problem Solving")),
      page(7, q("cr", null)),
      page(8, key("cr", "Critical Reasoning Answers"))
    ])
    expect(ranges.map((range) => [range.role, range.firstPage, range.set])).toEqual([
      ["questions", 1, "Diagnostic"],
      ["questions", 2, "Diagnostic Data Sufficiency"],
      ["answer-key", 3, "Diagnostic Data Sufficiency"],
      ["questions", 4, "Problem Solving"],
      ["answer-key", 5, "Problem Solving"],
      ["explanations", 6, "Problem Solving"],
      ["questions", 7, "Critical Reasoning"],
      ["answer-key", 8, "Critical Reasoning"]
    ])
  })

  test("a page with no group counts as mixed", () => {
    expect(assembleMap([page(3, q(null, "Review"))])).toEqual([
      { role: "questions", firstPage: 3, lastPage: 3, set: "Review", group: "mixed" }
    ])
  })
})

describe("Checking a Book Map", () => {
  const ps = (role: MapRangeInput["role"], firstPage: number, lastPage: number, set = "Problem Solving"): MapRangeInput => ({
    role,
    firstPage,
    lastPage,
    set,
    group: "ps"
  })

  test("a sound map has no problems, and set names compare without case or extra spaces", () => {
    expect(mapProblems([ps("questions", 2, 10), ps("answer-key", 11, 11, "  problem   SOLVING ")], 20)).toEqual([])
  })

  test("names every problem it finds", () => {
    expect(mapProblems([ps("answer-key", 9, 4, "Keys")], 20)).toEqual([
      "Add at least one range of questions.",
      "Answer key, pages 9 to 4: the first page comes after the last.",
      "Answer key, pages 9 to 4: the set \"Keys\" has no questions. Use the set name of the questions it belongs to."
    ])
    expect(mapProblems([ps("questions", 2, 25), ps("questions", 20, 21)], 22)).toEqual([
      "Questions, pages 2 to 25: the Book has 22 pages.",
      "Two ranges of questions in the set \"Problem Solving\" share pages: pages 2 to 25 and pages 20 to 21."
    ])
  })

  test("ranges of different roles or sets may share pages", () => {
    expect(mapProblems([ps("questions", 2, 4), ps("explanations", 4, 6), ps("difficulty-labels", 4, 6)], 10)).toEqual([])
  })

  test("a confirmed map is stored tidy, in page order", () => {
    expect(tidyMap([ps("explanations", 9, 12, " Problem   Solving "), ps("questions", 2, 8)])).toEqual([
      ps("questions", 2, 8),
      ps("explanations", 9, 12)
    ])
  })
})

describe("The sample", () => {
  test("is spread evenly from the start of the Book to its end", () => {
    const pages = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(spread(pages, 10)).toEqual([6, 16, 26, 36, 46, 56, 66, 76, 86, 96])
    expect(spread([3, 4, 5], 10)).toEqual([3, 4, 5])
  })
})
