import type { TaxonomyView } from "../../src/api/Taxonomy.ts"

// Search over the Taxonomy. Matching ignores case and accents, every term of
// the query must appear, and matches are marked in the original text.

const foldChar = (char: string) => char.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()

const fold = (text: string) => {
  let folded = ""
  // For each folded code unit, where its source character starts and ends.
  const starts: Array<number> = []
  const ends: Array<number> = []
  let index = 0
  for (const char of text) {
    const piece = foldChar(char)
    for (let k = 0; k < piece.length; k++) {
      starts.push(index)
      ends.push(index + char.length)
    }
    folded += piece
    index += char.length
  }
  return { folded, starts, ends }
}

export const searchTerms = (query: string): ReadonlyArray<string> => [
  ...new Set(fold(query).folded.split(/\s+/).filter((term) => term.length > 0))
]

export interface Segment {
  readonly text: string
  readonly marked: boolean
}

export const highlight = (text: string, terms: ReadonlyArray<string>): ReadonlyArray<Segment> => {
  const { folded, starts, ends } = fold(text)
  const ranges: Array<[number, number]> = []
  for (const term of terms) {
    for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + 1)) {
      ranges.push([starts[at]!, ends[at + term.length - 1]!])
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (last !== undefined && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1])
    } else {
      merged.push([range[0], range[1]])
    }
  }
  const segments: Array<Segment> = []
  let cursor = 0
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), marked: false })
    segments.push({ text: text.slice(start, end), marked: true })
    cursor = end
  }
  if (cursor < text.length || segments.length === 0) {
    segments.push({ text: text.slice(cursor), marked: false })
  }
  return segments
}

const matchesAll = (fields: ReadonlyArray<string>, terms: ReadonlyArray<string>) => {
  const haystack = fields.map((field) => fold(field).folded).join("\n")
  return terms.every((term) => haystack.includes(term))
}

export type HitKind = "question-type" | "skill" | "trap-pattern" | "strategy" | "mistake-type"

export interface Hit {
  readonly key: string
  readonly kind: HitKind
  readonly name: string
  // What the entry is, such as "Skill in Number properties".
  readonly context: string
  readonly description: string
  readonly validWhen?: string
}

export interface HitGroup {
  readonly id: string
  readonly name: string
  readonly hits: ReadonlyArray<Hit>
}

export const findInTaxonomy = (view: TaxonomyView, query: string): ReadonlyArray<HitGroup> => {
  const terms = searchTerms(query)
  if (terms.length === 0) return []

  const groups: Array<HitGroup> = []
  for (const section of view.sections) {
    const hits: Array<Hit> = []
    for (const type of section.questionTypes) {
      if (matchesAll([type.name, type.description], terms)) {
        hits.push({ key: type.id, kind: "question-type", name: type.name, context: "Question type", description: type.description })
      }
    }
    for (const topic of section.topics) {
      for (const skill of topic.skills) {
        if (matchesAll([skill.name, skill.description, topic.name], terms)) {
          hits.push({
            key: skill.id,
            kind: "skill",
            name: skill.name,
            context: `Skill in ${topic.name}`,
            description: skill.description
          })
        }
      }
    }
    for (const trap of section.trapPatterns) {
      if (matchesAll([trap.name, trap.description], terms)) {
        hits.push({ key: trap.id, kind: "trap-pattern", name: trap.name, context: "Trap pattern", description: trap.description })
      }
    }
    for (const strategy of section.strategies) {
      if (matchesAll([strategy.name, strategy.description, strategy.validWhen], terms)) {
        hits.push({
          key: strategy.id,
          kind: "strategy",
          name: strategy.name,
          context: "Strategy",
          description: strategy.description,
          validWhen: strategy.validWhen
        })
      }
    }
    if (hits.length > 0) groups.push({ id: section.id, name: section.name, hits })
  }

  const mistakes = view.mistakeTypes
    .filter((mistake) => matchesAll([mistake.name, mistake.description], terms))
    .map((mistake): Hit => ({
      key: mistake.id,
      kind: "mistake-type",
      name: mistake.name,
      context: "Mistake type",
      description: mistake.description
    }))
  if (mistakes.length > 0) groups.push({ id: "mistakes", name: "Mistake types", hits: mistakes })

  return groups
}
