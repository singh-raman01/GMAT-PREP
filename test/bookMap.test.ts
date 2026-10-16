import { describe, expect, test } from "bun:test"
import type { MapRangeInput } from "../src/api/Books.ts"
import { mapProblems, setsWithoutKeys, tidyMap } from "../src/api/bookMapRules.ts"
import { assembleMap, parseChapter, sameChapter, type SurveyedPage } from "../src/server/books/bookMap.ts"
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
    expect(parseChapter("5.0 Problem Solving")).toEqual({ number: "5", title: "problem solving" })
    expect(parseChapter("Chapter 5: Problem  solving")).toEqual({ number: "5", title: "problem solving" })
    expect(parseChapter("Part II Review")).toEqual({ number: "ii", title: "review" })
    expect(parseChapter("Index")).toEqual({ number: null, title: "index" })
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

  test("chapters with different numbers are different chapters, even when their titles match", () => {
    expect(sameChapter(parseChapter("Chapter 3 Practice Questions"), parseChapter("Chapter 4 Practice Questions"))).toBe(
      false
    )
    expect(sameChapter(parseChapter("Chapter 3"), parseChapter("Chapter 4"))).toBe(false)
    expect(sameChapter(parseChapter("Chapter 3"), parseChapter("Chapter 3 Practice Questions"))).toBe(true)
    expect(sameChapter(parseChapter("Practice Questions"), parseChapter("4 Practice Questions"))).toBe(true)
    const ranges = assembleMap([
      page(10, q("ps", "Chapter 3 Practice Questions")),
      page(11, q("ps", "Chapter 3 Practice Questions")),
      page(12, key("ps", "Chapter 3 Practice Questions")),
      page(13, q("ps", "Chapter 4")),
      page(14, q("ps", "Chapter 5")),
      page(15, key("ps", "Chapter 5")),
      page(20, q("ps", "Chapter 4 Practice Questions")),
      page(22, key("ps", "Chapter 4 Practice Questions"))
    ])
    expect(ranges.map((range) => [range.role, range.firstPage, range.lastPage, range.set])).toEqual([
      ["questions", 10, 11, "Chapter 3 Practice Questions"],
      ["answer-key", 12, 12, "Chapter 3 Practice Questions"],
      ["questions", 13, 13, "Chapter 4"],
      ["questions", 14, 14, "Chapter 5"],
      ["answer-key", 15, 15, "Chapter 5"],
      ["questions", 20, 20, "Chapter 4"],
      ["answer-key", 22, 22, "Chapter 4"]
    ])
  })

  test("a key joins the questions of its chapter only when their groups fit", () => {
    const ranges = assembleMap([
      page(1, q("rc", "3.4 Practice Questions")),
      page(2, q("cr", "4.4 Practice Questions")),
      page(3, key("cr", "4.4 Practice Questions")),
      page(4, key("rc", "3.4 Practice Questions")),
      page(5, q("mixed", "Review")),
      page(6, key("ps", "Review"))
    ])
    expect(ranges.map((range) => [range.role, range.firstPage, range.set])).toEqual([
      ["questions", 1, "3.4 Practice Questions"],
      ["questions", 2, "4.4 Practice Questions"],
      ["answer-key", 3, "4.4 Practice Questions"],
      ["answer-key", 4, "3.4 Practice Questions"],
      ["questions", 5, "Review"],
      ["answer-key", 6, "Review"]
    ])
  })

  test("sets without a chapter, or sharing one across groups, get names of their own", () => {
    const ranges = assembleMap([
      page(2, q("ps", null)),
      page(3, key("ps", null)),
      page(5, q("ps", null)),
      page(6, key("ps", null)),
      page(8, q("ps", "2.0 Diagnostic Test")),
      page(9, q("ds", "2.0 Diagnostic Test")),
      page(10, key("ds", "2.0 Diagnostic Test"))
    ])
    expect(ranges.map((range) => [range.role, range.firstPage, range.set])).toEqual([
      ["questions", 2, "Problem Solving from page 2"],
      ["answer-key", 3, "Problem Solving from page 2"],
      ["questions", 5, "Problem Solving from page 5"],
      ["answer-key", 6, "Problem Solving from page 5"],
      ["questions", 8, "2.0 Diagnostic Test"],
      ["questions", 9, "2.0 Diagnostic Test, Data Sufficiency"],
      ["answer-key", 10, "2.0 Diagnostic Test, Data Sufficiency"]
    ])
  })

  test("a page with no chapter carries on the range before it", () => {
    expect(assembleMap([
      page(2, q("ps", "Problem Solving")),
      page(3, q("ps", null)),
      page(4, q("ps", "Problem Solving"))
    ])).toEqual([{ role: "questions", firstPage: 2, lastPage: 4, set: "Problem Solving", group: "ps" }])
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

  test("every range needs a set name of at most 100 characters, and pages from 1", () => {
    expect(mapProblems([ps("questions", 2, 4, "   "), ps("questions", 0, 0, "x".repeat(101))], 10)).toEqual([
      "Questions, pages 2 to 4: give it a set name.",
      `Questions, page 0: shorten the set name to 100 characters.`,
      "Questions, page 0: pages are numbered from 1."
    ])
    expect(mapProblems(Array.from({ length: 501 }, (_, i) => ps("questions", i + 1, i + 1)), 600)).toContain(
      "A Book Map holds at most 500 ranges."
    )
  })

  test("ranges of different roles may share pages, and so may two sets' keys, but not their questions", () => {
    expect(mapProblems([ps("questions", 2, 4), ps("explanations", 4, 6), ps("difficulty-labels", 4, 6)], 10)).toEqual([])
    expect(mapProblems([
      ps("questions", 2, 4),
      ps("questions", 4, 6, "Review"),
      ps("answer-key", 7, 7),
      ps("answer-key", 7, 7, "Review")
    ], 10)).toEqual([
      "The sets \"Problem Solving\" and \"Review\" both have questions on page 4. Give each page of questions to one set."
    ])
  })

  test("sets with questions but no answer key are pointed out", () => {
    expect(setsWithoutKeys([
      ps("questions", 2, 8),
      ps("answer-key", 9, 9),
      ps("questions", 12, 14, "Diagnostic"),
      ps("explanations", 15, 16, "Diagnostic")
    ])).toEqual(["Diagnostic"])
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
