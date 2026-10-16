import type { ReasonCode } from "../../api/Review.ts"
import { normalizeText, renderProblem } from "../../api/richText.ts"
import type { PageReading } from "./readings.ts"

// Pure rules for turning a question set's page readings into Questions: each
// item linked to its key, explanation and difficulty label by number, then
// checked.

export type Letter = "A" | "B" | "C" | "D" | "E"
export type BookLabel = "easy" | "medium" | "hard"

export type { ReasonCode } from "../../api/Review.ts"

export interface Reason {
  readonly code: ReasonCode
  readonly detail: string
}

export interface Candidate {
  readonly _tag: "Candidate"
  readonly number: number
  readonly page: number
  // The Section and Question Type it is extracted as.
  readonly section: string
  readonly questionType: string
  // The passage a Reading Comprehension question asks about; null for other
  // questions, and for one whose passage the readings do not give.
  readonly passage: string | null
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

// The five answer choices every Data Sufficiency question has.
export const DsOptions: ReadonlyArray<{ readonly label: Letter; readonly text: string }> = [
  { label: "A", text: "Statement (1) ALONE is sufficient, but statement (2) alone is not sufficient." },
  { label: "B", text: "Statement (2) ALONE is sufficient, but statement (1) alone is not sufficient." },
  { label: "C", text: "BOTH statements TOGETHER are sufficient, but NEITHER statement ALONE is sufficient." },
  { label: "D", text: "EACH statement ALONE is sufficient." },
  { label: "E", text: "Statements (1) and (2) TOGETHER are NOT sufficient." }
]

// A Data Sufficiency question's text: what it asks, then its statements.
export const dsStem = (question: string, statements: ReadonlyArray<string>) =>
  [question.trim(), ...statements.map((statement, index) => `(${index + 1}) ${statement.trim()}`)].join("\n\n")

// The Taxonomy's rules for a verbal question's type, where the question's own
// words settle it: a question about portions in boldface or about how an
// argument proceeds is Argument structure; an EXCEPT question takes the task
// its sentence names, so "each strengthens EXCEPT" is a strengthen question;
// and a passage question about what, if true, would strengthen or weaken a
// claim is Application. Otherwise the type the reading gave stands.
export const settledType = (group: "cr" | "rc", stem: string, type: string) => {
  // A Critical Reasoning stem is its argument, then the question asked.
  const asked = stem.split(/\n\s*\n/).at(-1) ?? stem
  if (group === "cr") {
    if (/\bbold\s?faced?\b|\bmethods? of reasoning\b|\bproceeds by\b|\bargumentative (?:technique|strategy)\b/i.test(asked)) {
      return "verbal.cr-structure"
    }
    const except = /[^.?!\n]*\bEXCEPT\b[^.?!\n]*/.exec(asked)?.[0]
    if (except !== undefined && /\b(?:strengthen|support)/i.test(except)) return "verbal.cr-strengthen"
    if (except !== undefined && /\b(?:weaken|undermine|casts? doubt|calls? into question)/i.test(except)) {
      return "verbal.cr-weaken"
    }
  }
  if (
    group === "rc" && /\bif true\b/i.test(asked) &&
    /\b(?:strengthen|weaken|undermine|support|casts? doubt|calls? into question)/i.test(asked)
  ) {
    return "verbal.rc-application"
  }
  return type
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
  // Each passage, by the numbers of the questions about it; a number two
  // passages claim keeps the first.
  const passages = new Map<number, string>()
  for (const { reading } of readings.questions) {
    if (reading.role !== "questions" || reading.group !== "rc") continue
    for (const passage of reading.value.passages) {
      for (const number of passage.questions) if (!passages.has(number)) passages.set(number, passage.text.trim())
    }
  }
  const found = (number: number) => ({
    keyAnswers: answers.get(number) ?? [],
    explanation: explanations.get(number),
    explanationAnswers: explanationAnswers.get(number) ?? [],
    label: onlyValue(labels.get(number))
  })
  for (const { page, reading } of readings.questions) {
    if (reading.role !== "questions") continue
    switch (reading.group) {
      case "sc":
        for (const number of reading.value.numbers) {
          if (!repeated(number, page, null)) linked.push({ _tag: "Skip", number, page, reason: "sentence-correction" })
        }
        break
      case "ps":
        for (const item of reading.value.questions) {
          if (repeated(item.number, page, item.stem)) continue
          if (item.retired !== null) {
            linked.push({ _tag: "Skip", number: item.number, page, reason: item.retired })
            continue
          }
          linked.push(candidateOf({ ...item, page, section: "quant", questionType: "quant.ps", passage: null }, found(item.number)))
        }
        break
      case "ds":
        for (const item of reading.value.questions) {
          const stem = dsStem(item.question, item.statements)
          if (repeated(item.number, page, stem)) continue
          if (item.retired !== null) {
            linked.push({ _tag: "Skip", number: item.number, page, reason: item.retired })
            continue
          }
          linked.push(candidateOf({
            number: item.number,
            page,
            section: "di",
            questionType: "di.ds",
            passage: null,
            stem,
            options: DsOptions,
            figure: item.figure,
            difficulty: item.difficulty
          }, found(item.number)))
        }
        break
      case "cr":
      case "rc":
        for (const item of reading.value.questions) {
          if (repeated(item.number, page, item.stem)) continue
          linked.push(candidateOf({
            ...item,
            page,
            section: "verbal",
            questionType: settledType(reading.group, item.stem, item.type),
            passage: reading.group === "rc" ? passages.get(item.number) ?? null : null,
            figure: false
          }, found(item.number)))
        }
        break
    }
  }
  return linked
}

// What a page's reading gives for one question, whatever its group.
interface ReadItem {
  readonly number: number
  readonly page: number
  readonly section: string
  readonly questionType: string
  readonly passage: string | null
  readonly stem: string
  readonly options: ReadonlyArray<{ readonly label: Letter; readonly text: string }>
  readonly figure: boolean
  readonly difficulty: BookLabel | null
}

const candidateOf = (
  item: ReadItem,
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
    page: item.page,
    section: item.section,
    questionType: item.questionType,
    passage: item.passage,
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

// Every problem a Question has on its own, before it is compared with the
// Question Bank. Each type read so far has five answer choices, A to E.
export const candidateProblems = (candidate: Candidate): ReadonlyArray<Reason> => {
  const reasons: Array<Reason> = []
  const labels = candidate.options.map((option) => option.label)
  if (labels.length !== 5 || labels.some((label, index) => label !== Letters[index])) {
    reasons.push({
      code: "structure",
      detail: `It has ${labels.length === 0 ? "no answer choices" : `the answer choices ${labels.join(", ")}`}; it should have five, A to E.`
    })
  }
  if (candidate.stem === "") reasons.push({ code: "structure", detail: "Its question text is empty." })
  if (candidate.questionType.startsWith("verbal.rc-") && candidate.passage === null) {
    reasons.push({ code: "structure", detail: "The readings do not say which passage it asks about." })
  }
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
    ...(candidate.passage === null ? [] : [["passage", candidate.passage] as const]),
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
