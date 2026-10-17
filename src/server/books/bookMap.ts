import type { MapRangeInput, MapRole, TypeGroup } from "../../api/Books.ts"
import { TypeGroupLabels, TypeGroupSections } from "../../api/Books.ts"
import { setKey } from "../../api/bookMapRules.ts"
import type { PageSurvey } from "./survey.ts"

// Joining surveyed pages into a proposed Book Map. The rules a map must meet
// to be confirmed are in api/bookMapRules.ts, shared with the web app.

export interface SurveyedPage {
  readonly number: number
  // Null for a page that was not surveyed, such as a scanned page.
  readonly survey: PageSurvey | null
}

// A chapter title as compared: its number, such as 5 or 3.4, and the rest in
// lower case with spacing tidied.
export interface Chapter {
  readonly number: string | null
  // Empty when the title is only a number, such as "Chapter 3".
  readonly title: string
}

const Prefix = /^(?:chapter|part|section|unit|lesson)\b\.?\s*/
const Digits = /^\d+(?:\.\d+)*/
// Roman numerals count as a number only after a word such as "Part".
const Roman = /^[ivxlc]+\b/

// "5.0" and "05" are the number 5; "3.4" stays 3.4.
const tidyNumber = (number: string) => {
  const parts = number.split(".").map((part) => String(Number(part)))
  while (parts.length > 1 && parts.at(-1) === "0") parts.pop()
  return parts.join(".")
}

export const parseChapter = (chapter: string): Chapter => {
  let rest = chapter.toLowerCase().replace(/\s+/g, " ").trim()
  const prefixed = Prefix.test(rest)
  rest = rest.replace(Prefix, "")
  let number: string | null = null
  const digits = Digits.exec(rest)
  const roman = digits === null && prefixed ? Roman.exec(rest) : null
  if (digits !== null) number = tidyNumber(digits[0])
  else if (roman !== null) number = roman[0]
  const found = digits ?? roman
  if (found !== null) rest = rest.slice(found[0].length)
  return { number, title: rest.replace(/^[\s.:\-–—]+/, "").trim() }
}

// Two titles name the same chapter when their numbers match and so do their
// titles, unless one is only a number; or, with a number on at most one of
// them, when their titles match. So "5.0 Problem Solving" and "Chapter 5:
// Problem solving" match, and "Chapter 3" and "Chapter 4" do not.
export const sameChapter = (a: Chapter, b: Chapter) =>
  a.number !== null && b.number !== null
    ? a.number === b.number && (a.title === b.title || a.title === "" || b.title === "")
    : a.title !== "" && a.title === b.title

// Groups that may share a set: the same group, or a mixed page with any.
const fits = (a: TypeGroup, b: TypeGroup) => a === b || a === "mixed" || b === "mixed"

// Groups whose questions of one chapter share a set: the same group, or two
// Data Insights groups.
const sharesSet = (a: TypeGroup, b: TypeGroup) =>
  a === b || (TypeGroupSections[a] === "di" && TypeGroupSections[b] === "di")

interface Run {
  readonly role: MapRole
  readonly group: TypeGroup
  // The chapter of the run's first page; null when the survey gave none.
  readonly chapter: Chapter | null
  readonly labels: Map<string, number>
  readonly first: number
  last: number
  set: string
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

// Joins pages into ranges and names their sets.
//
// Neighbouring pages with the same role and group join while their chapters
// match; a page with no chapter carries on the range before it. A page that
// was not surveyed joins a range only when the pages on both sides belong to
// it; any other page ends it.
//
// Questions of one chapter and group share a set, named by the commonest
// spelling of the chapter's title; so do a chapter's Data Insights questions
// of every type, which a Focus book numbers on through the chapter and keys
// in one answer key. Questions with no chapter are named after their group,
// with their first page when another set has that name.
//
// Answer keys, explanations and difficulty labels take the set of the
// questions of their chapter and a fitting group, the nearest earlier ones
// when several match; else the nearest questions of their group before them,
// else the next ones after.
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
    const label = survey.chapter?.trim() ?? ""
    const chapter = label === "" ? null : parseChapter(label)
    const continues = current !== undefined && current.role === survey.role && current.group === group &&
      (chapter === null || (current.chapter !== null && sameChapter(current.chapter, chapter)))
    if (continues) {
      current!.last = page.number
    } else {
      current = { role: survey.role, group, chapter, labels: new Map(), first: page.number, last: page.number, set: "" }
      runs.push(current)
    }
    if (label !== "") current!.labels.set(label, (current!.labels.get(label) ?? 0) + 1)
  }

  const questions = runs.filter((run) => run.role === "questions")
  const matches = (run: Run, other: Run) =>
    run.chapter !== null && other.chapter !== null && sameChapter(run.chapter, other.chapter)

  // Questions with a chapter: the set of earlier questions of the same chapter
  // and group, else the chapter's own name, told apart from another group's.
  const taken = new Map<string, TypeGroup>()
  questions.forEach((run, index) => {
    if (run.chapter === null) return
    const earlier = questions.slice(0, index).find((other) => sharesSet(other.group, run.group) && matches(run, other))
    if (earlier !== undefined) {
      run.set = earlier.set
      return
    }
    const name = mostCommon(run.labels)!
    const owner = taken.get(setKey(name))
    run.set = owner === undefined || sharesSet(owner, run.group) ? name : `${name}, ${TypeGroupLabels[run.group]}`
    taken.set(setKey(run.set), run.group)
  })
  const unchaptered = questions.filter((run) => run.chapter === null)
  for (const run of unchaptered) {
    const name = TypeGroupLabels[run.group]
    const shared = taken.has(setKey(name)) || unchaptered.some((other) => other !== run && other.group === run.group)
    run.set = shared ? `${name} from page ${run.first}` : name
  }

  const nearest = (run: Run, candidates: ReadonlyArray<Run>) =>
    candidates.filter((q) => q.first < run.first).at(-1) ?? candidates.find((q) => q.first > run.first)

  for (const run of runs) {
    if (run.role === "questions") continue
    const fitting = questions.filter((q) => fits(q.group, run.group))
    const owner = nearest(run, fitting.filter((q) => matches(run, q))) ??
      fitting.filter((q) => q.first < run.first).at(-1) ??
      fitting.find((q) => q.first > run.first)
    run.set = owner?.set ?? mostCommon(run.labels) ?? TypeGroupLabels[run.group]
  }

  return runs.map((run) => ({ role: run.role, firstPage: run.first, lastPage: run.last, set: run.set, group: run.group }))
}
