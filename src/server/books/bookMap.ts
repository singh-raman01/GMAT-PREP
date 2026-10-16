import {
  type MapRangeInput,
  MapRoleLabels,
  type MapRole,
  type TypeGroup,
  TypeGroupLabels
} from "../../api/Books.ts"
import type { PageSurvey } from "./survey.ts"

// Pure rules for Book Maps: joining surveyed pages into a proposal, and
// checking a map before it is confirmed.

export interface SurveyedPage {
  readonly number: number
  // Null for a page that was not surveyed, such as a scanned page.
  readonly survey: PageSurvey | null
}

// Chapter titles as compared: case, spacing and leading numbers ignored, so
// "5.0 Problem Solving" and "Chapter 5: Problem solving" match.
export const chapterKey = (chapter: string) =>
  chapter
    .toLowerCase()
    .replace(/^\s*(chapter|part|section|unit)\b/, "")
    .replace(/^[\s\d.:\-–—]+/, "")
    .replace(/\s+/g, " ")
    .trim()

// Set names as compared.
export const setKey = (set: string) => set.trim().replace(/\s+/g, " ").toLowerCase()

interface Run {
  readonly role: MapRole
  readonly group: TypeGroup
  readonly chapter: string
  readonly labels: Map<string, number>
  readonly first: number
  last: number
}

const mostCommon = (labels: ReadonlyMap<string, number>): string | undefined => {
  let best: string | undefined
  let count = 0
  for (const [label, seen] of labels) {
    if (seen > count) {
      best = label
      count = seen
    }
  }
  return best
}

// Joins pages into ranges. Neighbouring pages with the same role, group and
// chapter form one range; a page that was not surveyed joins a range only
// when the pages on both sides belong to it; any other page ends it. Answer
// keys, explanations and difficulty labels take the set of the questions in
// their chapter, or else the nearest questions of their group before them.
export const assembleMap = (pages: ReadonlyArray<SurveyedPage>): ReadonlyArray<MapRangeInput> => {
  const runs: Array<Run> = []
  let current: Run | undefined
  for (const page of [...pages].sort((a, b) => a.number - b.number)) {
    const survey = page.survey
    if (survey === null) continue
    if (survey.role === "other") {
      current = undefined
      continue
    }
    const group = survey.group ?? "mixed"
    const chapter = survey.chapter === null ? "" : chapterKey(survey.chapter)
    if (current !== undefined && current.role === survey.role && current.group === group && current.chapter === chapter) {
      current.last = page.number
    } else {
      current = { role: survey.role, group, chapter, labels: new Map(), first: page.number, last: page.number }
      runs.push(current)
    }
    if (survey.chapter !== null && survey.chapter.trim() !== "") {
      const label = survey.chapter.trim()
      current.labels.set(label, (current.labels.get(label) ?? 0) + 1)
    }
  }

  const setOf = (run: Run) => mostCommon(run.labels) ?? TypeGroupLabels[run.group]
  const questions = runs.filter((run) => run.role === "questions")

  return runs.map((run) => {
    let set = setOf(run)
    if (run.role !== "questions") {
      const sameChapter = run.chapter === "" ? undefined : questions.find((q) => q.chapter === run.chapter)
      const fits = (q: Run) => run.group === "mixed" || q.group === run.group
      const before = questions.filter((q) => q.first < run.first && fits(q)).at(-1)
      const after = questions.find((q) => q.first > run.first && fits(q))
      const owner = sameChapter ?? before ?? after
      if (owner !== undefined) set = setOf(owner)
    }
    return { role: run.role, firstPage: run.first, lastPage: run.last, set, group: run.group }
  })
}

const pagesOf = (range: MapRangeInput) =>
  range.firstPage === range.lastPage ? `page ${range.firstPage}` : `pages ${range.firstPage} to ${range.lastPage}`

const describe = (range: MapRangeInput) => `${MapRoleLabels[range.role]}, ${pagesOf(range)}`

// Every problem with a Book Map, in words, or none.
export const mapProblems = (ranges: ReadonlyArray<MapRangeInput>, pageCount: number): ReadonlyArray<string> => {
  const problems: Array<string> = []
  if (!ranges.some((range) => range.role === "questions")) {
    problems.push("Add at least one range of questions.")
  }
  for (const range of ranges) {
    if (range.firstPage > range.lastPage) {
      problems.push(`${describe(range)}: the first page comes after the last.`)
    } else if (range.lastPage > pageCount) {
      problems.push(`${describe(range)}: the Book has ${pageCount} pages.`)
    }
  }
  const questionSets = new Set(ranges.filter((range) => range.role === "questions").map((range) => setKey(range.set)))
  for (const range of ranges) {
    if (range.role !== "questions" && !questionSets.has(setKey(range.set))) {
      problems.push(
        `${describe(range)}: the set "${range.set.trim()}" has no questions. Use the set name of the questions it belongs to.`
      )
    }
  }
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i]!
      const b = ranges[j]!
      if (
        a.role === b.role && setKey(a.set) === setKey(b.set) && a.firstPage <= b.lastPage && b.firstPage <= a.lastPage
      ) {
        problems.push(
          `Two ranges of ${MapRoleLabels[a.role].toLowerCase()} in the set "${a.set.trim()}" share pages: ${pagesOf(a)} and ${
            pagesOf(b)
          }.`
        )
      }
    }
  }
  return problems
}

// A map as stored: set names trimmed, ranges in page order.
export const tidyMap = (ranges: ReadonlyArray<MapRangeInput>): ReadonlyArray<MapRangeInput> =>
  ranges
    .map((range) => ({ ...range, set: range.set.trim().replace(/\s+/g, " ") }))
    .toSorted((a, b) => a.firstPage - b.firstPage || a.lastPage - b.lastPage)
