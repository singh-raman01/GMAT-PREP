import { type MapRangeInput, MapRoleLabels, MaxMapRanges, MaxSetName } from "./Books.ts"

// What a Book Map must meet to be confirmed, shared by the server, which
// enforces it, and the Book Map editor, which shows it as the Curator types.

// Set names as compared.
export const setKey = (set: string) => set.trim().replace(/\s+/g, " ").toLowerCase()

const pagesOf = (range: MapRangeInput) =>
  range.firstPage === range.lastPage ? `page ${range.firstPage}` : `pages ${range.firstPage} to ${range.lastPage}`

const describe = (range: MapRangeInput) => `${MapRoleLabels[range.role]}, ${pagesOf(range)}`

// Every problem with a Book Map, in words, or none.
export const mapProblems = (ranges: ReadonlyArray<MapRangeInput>, pageCount: number): ReadonlyArray<string> => {
  const problems: Array<string> = []
  if (!ranges.some((range) => range.role === "questions")) {
    problems.push("Add at least one range of questions.")
  }
  if (ranges.length > MaxMapRanges) problems.push(`A Book Map holds at most ${MaxMapRanges} ranges.`)
  for (const range of ranges) {
    const name = range.set.trim()
    if (name === "") problems.push(`${describe(range)}: give it a set name.`)
    else if (name.length > MaxSetName) problems.push(`${describe(range)}: shorten the set name to ${MaxSetName} characters.`)
    if (range.firstPage < 1 || range.lastPage < 1) {
      problems.push(`${describe(range)}: pages are numbered from 1.`)
    } else if (range.firstPage > range.lastPage) {
      problems.push(`${describe(range)}: the first page comes after the last.`)
    } else if (range.lastPage > pageCount) {
      problems.push(`${describe(range)}: the Book has ${pageCount} pages.`)
    }
  }
  const questionSets = new Set(ranges.filter((range) => range.role === "questions").map((range) => setKey(range.set)))
  for (const range of ranges) {
    if (range.role !== "questions" && range.set.trim() !== "" && !questionSets.has(setKey(range.set))) {
      problems.push(
        `${describe(range)}: the set "${range.set.trim()}" has no questions. Use the set name of the questions it belongs to.`
      )
    }
  }
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i]!
      const b = ranges[j]!
      if (a.role !== b.role || a.firstPage > b.lastPage || b.firstPage > a.lastPage) continue
      if (setKey(a.set) === setKey(b.set)) {
        problems.push(
          `Two ranges of ${MapRoleLabels[a.role].toLowerCase()} in the set "${a.set.trim()}" share pages: ${pagesOf(a)} and ${
            pagesOf(b)
          }.`
        )
      } else if (a.role === "questions") {
        // A page is read once, so both sets would get all its questions.
        const first = Math.max(a.firstPage, b.firstPage)
        const last = Math.min(a.lastPage, b.lastPage)
        problems.push(
          `The sets "${a.set.trim()}" and "${b.set.trim()}" both have questions on ${
            first === last ? `page ${first}` : `pages ${first} to ${last}`
          }. Give each page of questions to one set.`
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

// Sets with questions but no answer key: their Questions would be held for
// want of a key. A hint, not a problem.
export const setsWithoutKeys = (ranges: ReadonlyArray<MapRangeInput>): ReadonlyArray<string> => {
  const keyed = new Set(ranges.filter((range) => range.role === "answer-key").map((range) => setKey(range.set)))
  const names = new Map<string, string>()
  for (const range of ranges) {
    if (range.role === "questions" && !keyed.has(setKey(range.set))) names.set(setKey(range.set), range.set.trim())
  }
  return [...names.values()]
}
