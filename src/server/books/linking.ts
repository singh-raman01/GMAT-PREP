import { normalizeText, renderProblem } from "../../api/richText.ts"
import type { PageReading, QuestionItem } from "./readings.ts"

// Pure rules for turning a question set's page readings into Questions: each
// item linked to its key, explanation and difficulty label by number, then
// checked.

export type Letter = "A" | "B" | "C" | "D" | "E"
export type BookLabel = "easy" | "medium" | "hard"

export type ReasonCode =
  | "structure"
  | "no-key"
  | "key-conflict"
  | "render"
  | "figure"
  | "same-text-other-key"
  | "near-match"
  | "key-changed"
  | "source-key"
  | "unread-page"

export interface Reason {
  readonly code: ReasonCode
  readonly detail: string
}

export interface Candidate {
  readonly _tag: "Candidate"
  readonly number: number
  readonly page: number
  readonly stem: string
  readonly options: ReadonlyArray<{ readonly label: Letter; readonly text: string }>
  readonly figure: boolean
  // The answer key's letter, the explanation's, and the one the Question
  // takes: the key's, else the explanation's.
  readonly answerKey: Letter | null
  readonly explanationAnswer: Letter | null
  readonly key: Letter | null
  // Different answers the answer key, or the explanations, give for the
  // number; empty when they agree.
  readonly keyAnswers: ReadonlyArray<Letter>
  readonly explanationAnswers: ReadonlyArray<Letter>
  readonly explanation: string | null
  readonly label: BookLabel | null
}

export interface Skip {
  readonly _tag: "Skip"
  readonly number: number
  readonly page: number
  // repeated-number: the set already has an item with this number, so the
  // keys and explanations cannot tell them apart.
  readonly reason: "geometry" | "sentence-correction" | "repeated-number"
}

export type LinkedItem = Candidate | Skip

export interface SetReadings {
  // In page order.
  readonly questions: ReadonlyArray<{ readonly page: number; readonly reading: PageReading }>
  readonly answers: ReadonlyArray<PageReading>
  readonly explanations: ReadonlyArray<PageReading>
  readonly labels: ReadonlyArray<PageReading>
}

// Every value given for each number, without repeats.
const byNumber = <A>(entries: ReadonlyArray<{ readonly number: number; readonly value: A }>) => {
  const values = new Map<number, Array<A>>()
  for (const { number, value } of entries) {
    const seen = values.get(number) ?? []
    if (!seen.includes(value)) seen.push(value)
    values.set(number, seen)
  }
  return values
}

// The one value given for a number; a number given two values has none.
const onlyValue = <A>(values: ReadonlyArray<A> | undefined): A | null =>
  values !== undefined && values.length === 1 ? values[0]! : null

export const linkSet = (readings: SetReadings): ReadonlyArray<LinkedItem> => {
  const answers = byNumber(readings.answers.flatMap((reading) =>
    reading.role === "answer-key" ? reading.value.answers.map((a) => ({ number: a.number, value: a.answer })) : []
  ))
  const labels = byNumber(readings.labels.flatMap((reading) =>
    reading.role === "difficulty-labels" ? reading.value.labels.map((l) => ({ number: l.number, value: l.difficulty })) : []
  ))
  const explanations = new Map<number, { readonly text: string; readonly answer: Letter | null; readonly label: BookLabel | null }>()
  const explanationAnswers = byNumber(readings.explanations.flatMap((reading) =>
    reading.role === "explanations"
      ? reading.value.explanations.flatMap((item) => (item.answer === null ? [] : [{ number: item.number, value: item.answer }]))
      : []
  ))
  for (const reading of readings.explanations) {
    if (reading.role !== "explanations") continue
    for (const item of reading.value.explanations) {
      if (!explanations.has(item.number)) {
        explanations.set(item.number, { text: item.explanation, answer: item.answer, label: item.difficulty })
      }
    }
  }

  // A number seen before in the set is a second item with that number, which
  // is skipped and counted rather than linked to the first item's key; the
  // same item read again, as when a question runs onto the next page, is not.
  const seen = new Map<number, string | null>()
  const linked: Array<LinkedItem> = []
  const repeated = (number: number, page: number, stem: string | null) => {
    if (!seen.has(number)) {
      seen.set(number, stem)
      return false
    }
    const first = seen.get(number) ?? null
    const sameItem = first === null || stem === null ||
      similarity(trigrams(normalizeText(first)), trigrams(normalizeText(stem))) >= SameItem
    if (!sameItem) linked.push({ _tag: "Skip", number, page, reason: "repeated-number" })
    return true
  }
  for (const { page, reading } of readings.questions) {
    if (reading.role !== "questions") continue
    if (reading.group === "sc") {
      for (const number of reading.value.numbers) {
        if (!repeated(number, page, null)) linked.push({ _tag: "Skip", number, page, reason: "sentence-correction" })
      }
      continue
    }
    for (const item of reading.value.questions) {
      if (repeated(item.number, page, item.stem)) continue
      if (item.retired !== null) {
        linked.push({ _tag: "Skip", number: item.number, page, reason: item.retired })
        continue
      }
      linked.push(candidateOf(item, page, {
        keyAnswers: answers.get(item.number) ?? [],
        explanation: explanations.get(item.number),
        explanationAnswers: explanationAnswers.get(item.number) ?? [],
        label: onlyValue(labels.get(item.number))
      }))
    }
  }
  return linked
}

const candidateOf = (
  item: QuestionItem,
  page: number,
  found: {
    readonly keyAnswers: ReadonlyArray<Letter>
    readonly explanation: { readonly text: string; readonly answer: Letter | null; readonly label: BookLabel | null } | undefined
    readonly explanationAnswers: ReadonlyArray<Letter>
    readonly label: BookLabel | null
  }
): Candidate => {
  const answerKey = onlyValue(found.keyAnswers)
  const explanationAnswer = onlyValue(found.explanationAnswers)
  return {
    _tag: "Candidate",
    number: item.number,
    page,
    stem: item.stem.trim(),
    options: item.options.map((option) => ({ label: option.label, text: option.text.trim() })),
    figure: item.figure,
    answerKey,
    explanationAnswer,
    // Two answers in the key give no key, rather than the explanation's.
    key: found.keyAnswers.length > 1 ? null : answerKey ?? explanationAnswer,
    keyAnswers: found.keyAnswers.length > 1 ? found.keyAnswers : [],
    explanationAnswers: found.explanationAnswers.length > 1 ? found.explanationAnswers : [],
    explanation: found.explanation?.text.trim() || null,
    label: found.label ?? found.explanation?.label ?? item.difficulty ?? null
  }
}

const Letters: ReadonlyArray<Letter> = ["A", "B", "C", "D", "E"]

// Every problem a Problem Solving Question has on its own, before it is
// compared with the Question Bank.
export const candidateProblems = (candidate: Candidate): ReadonlyArray<Reason> => {
  const reasons: Array<Reason> = []
  const labels = candidate.options.map((option) => option.label)
  if (labels.length !== 5 || labels.some((label, index) => label !== Letters[index])) {
    reasons.push({
      code: "structure",
      detail: `It has ${labels.length === 0 ? "no answer choices" : `the answer choices ${labels.join(", ")}`}; a Problem Solving Question has five, A to E.`
    })
  }
  if (candidate.stem === "") reasons.push({ code: "structure", detail: "Its question text is empty." })
  if (candidate.keyAnswers.length > 1) {
    reasons.push({ code: "key-conflict", detail: `The answer key gives more than one answer for it: ${candidate.keyAnswers.join(", ")}.` })
  } else if (candidate.key === null) {
    reasons.push({ code: "no-key", detail: "The Book's answer key and explanations give no answer for it." })
  } else if (!labels.includes(candidate.key)) {
    reasons.push({ code: "structure", detail: `Its key, ${candidate.key}, is not one of its answer choices.` })
  }
  if (candidate.explanationAnswers.length > 1) {
    reasons.push({
      code: "key-conflict",
      detail: `Its explanations give different answers: ${candidate.explanationAnswers.join(", ")}.`
    })
  } else if (
    candidate.answerKey !== null && candidate.explanationAnswer !== null && candidate.answerKey !== candidate.explanationAnswer
  ) {
    reasons.push({
      code: "key-conflict",
      detail: `The answer key says ${candidate.answerKey}, but the explanation says ${candidate.explanationAnswer}.`
    })
  }
  const texts: ReadonlyArray<readonly [string, string]> = [
    ["question", candidate.stem],
    ...candidate.options.map((option) => [`choice ${option.label}`, option.text] as const)
  ]
  for (const [where, text] of texts) {
    const problem = renderProblem(text)
    if (problem !== undefined) {
      reasons.push({ code: "render", detail: `The ${where} does not render: ${problem}` })
      break
    }
  }
  if (candidate.figure) {
    reasons.push({ code: "figure", detail: "It needs a figure that its text does not hold." })
  }
  return reasons
}

// The text compared when looking for the same Question in the Bank.
export const comparableText = (stem: string, options: ReadonlyArray<{ readonly text: string }>) =>
  normalizeText([stem, ...options.map((option) => option.text)].join(" | "))

// Three-character pieces of the text with every number as #, for finding
// near matches. A Variant is a copy with changed numbers or wording, so
// numbers are left out of the comparison.
export const trigrams = (text: string): ReadonlySet<string> => {
  const shape = text.replace(/\d+(?:\.\d+)?/g, "#")
  const pieces = new Set<string>()
  for (let i = 0; i + 3 <= shape.length; i++) pieces.add(shape.slice(i, i + 3))
  return pieces
}

// The share of pieces two texts have in common (Jaccard similarity).
export const similarity = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
  if (a.size === 0 && b.size === 0) return 1
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const piece of small) if (large.has(piece)) shared++
  return shared / (a.size + b.size - shared)
}

// Texts at least this alike are near matches: a possible Variant.
export const NearMatch = 0.85

// Two readings of one number at least this alike are the same item.
const SameItem = 0.6
