import { parseCell } from "../../api/dataset.ts"
import type { DatasetColumn } from "../../api/dataset.ts"
import type { PartKind } from "../../api/Practice.ts"
import type { ReasonCode } from "../../api/Review.ts"
import { normalizeText, renderProblem } from "../../api/richText.ts"
import type { ChartReading, GiItem, MsrQuestion, MsrSource, TableReading, TaItem, TpaItem } from "./diReadings.ts"
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

// One way a Question is answered, with its options and, once linked, the
// label of the right one.
export interface CandidatePart {
  readonly kind: PartKind
  // A statement, a sentence with {{blank}}, or a column heading; null for a
  // single choice, whose question is the stem.
  readonly prompt: string | null
  readonly options: ReadonlyArray<{ readonly label: string; readonly text: string }>
  readonly key: string | null
}

// A table as printed, its cells typed when it is written.
export interface TableDraft {
  readonly columns: ReadonlyArray<DatasetColumn>
  readonly rows: ReadonlyArray<ReadonlyArray<string>>
}

export type ContentDraft =
  | { readonly kind: "passage"; readonly body: string }
  | { readonly kind: "table"; readonly body: string; readonly table: TableDraft }
  | { readonly kind: "chart"; readonly body: string; readonly table: TableDraft; readonly spec: unknown }
  // A figure that cannot become data: the band of its page is kept as an
  // image when it is written.
  | { readonly kind: "figure"; readonly body: string }

export type StimulusDraft =
  | ContentDraft
  | { readonly kind: "tabs"; readonly tabs: ReadonlyArray<ContentDraft & { readonly title: string }> }

export interface Candidate {
  readonly _tag: "Candidate"
  readonly number: number
  readonly page: number
  // The Section and Question Type it is extracted as.
  readonly section: string
  readonly questionType: string
  // What it asks about: an RC passage, a table, a chart, a figure or the
  // tabs of an MSR set; null when it stands alone, or when the readings do
  // not give what an RC question asks about.
  readonly stimulus: StimulusDraft | null
  readonly stem: string
  readonly parts: ReadonlyArray<CandidatePart>
  readonly figure: boolean
  // The answer key's answer, the explanation's, and the one the Question
  // takes: the key's, else the explanation's. An answer names the right
  // option of each Part, in order, joined with commas, such as C or A,B,A.
  readonly answerKey: string | null
  readonly explanationAnswer: string | null
  readonly key: string | null
  // Different answers the answer key, or the explanations, give for the
  // number; empty when they agree.
  readonly keyAnswers: ReadonlyArray<string>
  readonly explanationAnswers: ReadonlyArray<string>
  // Answers the answer key prints that match no option.
  readonly unmatched: ReadonlyArray<string>
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

const lettered = (texts: ReadonlyArray<string>) =>
  texts.map((text, index) => ({ label: String.fromCharCode(65 + index), text: text.trim() }))

const comparable = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.:]$/, "")

// The option a printed answer names: its letter, its words, or the start of
// its words when only one option starts so, as Y for Yes.
export const optionNamed = (
  options: ReadonlyArray<{ readonly label: string; readonly text: string }>,
  printed: string
): string | undefined => {
  const text = printed.trim()
  const letter = /^\(?([A-Za-z])\)?\.?$/.exec(text)?.[1]?.toUpperCase()
  const wanted = comparable(text)
  const byText = options.find((option) => comparable(option.text) === wanted)
  if (byText !== undefined) return byText.label
  // A one-letter answer names a lettered option when there is one.
  if (letter !== undefined && options.some((option) => option.label === letter)) return letter
  // Otherwise the start of exactly one option's words names it, as Y for Yes.
  const starting = options.filter((option) => wanted !== "" && comparable(option.text).startsWith(wanted))
  return starting.length === 1 ? starting[0]!.label : undefined
}

// A Vega-Lite field reference: a dot or a bracket in a column's name would
// otherwise read as a path into the data.
const field = (name: string) => name.replace(/[.[\]]/g, (char) => `\\${char}`)

const encodingType = (columns: ReadonlyArray<DatasetColumn>, name: string) => {
  const type = columns.find((column) => column.name === name)?.type
  return type === "text" ? "nominal" : type === "date" ? "ordinal" : "quantitative"
}

// A chart's spec, built by code from what the reading says it draws, so the
// spec says only what the data can back (ADR 0006).
export const chartSpec = (chart: ChartReading): unknown => {
  if (chart.kind === "venn") return { venn: { sets: chart.sets, region: chart.x, value: chart.y } }
  const columns = chart.data.columns
  const axis = (name: string) => {
    const type = encodingType(columns, name)
    // Words and dates keep the Book's order rather than an alphabetical one.
    return { field: field(name), type, ...(type === "quantitative" ? {} : { sort: null }), title: name }
  }
  const series = chart.series === "" ? {} : { color: { field: field(chart.series), type: "nominal", title: chart.series } }
  const base = {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { name: "dataset" },
    ...(chart.title === "" ? {} : { title: chart.title })
  }
  switch (chart.kind) {
    case "pie":
      return {
        ...base,
        mark: "arc",
        encoding: {
          theta: { field: field(chart.y), type: "quantitative" },
          color: { field: field(chart.x), type: "nominal", sort: null, title: chart.x }
        }
      }
    case "line":
      return { ...base, mark: { type: "line", point: true }, encoding: { x: axis(chart.x), y: axis(chart.y), ...series } }
    case "scatter":
      return { ...base, mark: "point", encoding: { x: axis(chart.x), y: axis(chart.y), ...series } }
    case "bar":
    case "stacked-bar":
      return { ...base, mark: "bar", encoding: { x: axis(chart.x), y: axis(chart.y), ...series } }
  }
}

const tableDraft = (table: TableReading): TableDraft => ({
  columns: table.columns.map((column) => ({ name: column.name.trim(), type: column.type, unit: column.unit.trim() })),
  rows: table.rows.map((row) => row.map((cell) => cell.trim()))
})

// What a page's reading gives for one question, before its key.
interface ReadItem {
  readonly number: number
  readonly page: number
  readonly section: string
  readonly questionType: string
  readonly stimulus: StimulusDraft | null
  readonly stem: string
  readonly parts: ReadonlyArray<Omit<CandidatePart, "key">>
  readonly figure: boolean
  readonly difficulty: BookLabel | null
}

const statementParts = (statements: ReadonlyArray<string>, pair: ReadonlyArray<string>) =>
  statements.map((statement) => ({ kind: "two-choice" as const, prompt: statement.trim(), options: lettered(pair) }))

const taItem = (item: TaItem, page: number): ReadItem => ({
  number: item.number,
  page,
  section: "di",
  questionType: "di.ta",
  stimulus: { kind: "table", body: "", table: tableDraft(item.table) },
  stem: item.intro,
  parts: statementParts(item.statements, item.pair),
  figure: false,
  difficulty: item.difficulty
})

const giItem = (item: GiItem, page: number): ReadItem => ({
  number: item.number,
  page,
  section: "di",
  questionType: "di.gi",
  stimulus: item.chart !== null && !item.figure
    ? { kind: "chart", body: "", table: tableDraft(item.chart.data), spec: chartSpec(item.chart) }
    : { kind: "figure", body: "" },
  stem: item.intro,
  parts: item.statements.map((statement) => ({
    kind: "dropdown" as const,
    prompt: statement.text.trim(),
    options: lettered(statement.options)
  })),
  figure: item.chart === null || item.figure,
  difficulty: item.difficulty
})

const tpaItem = (item: TpaItem, page: number): ReadItem => ({
  number: item.number,
  page,
  section: "di",
  questionType: "di.tpa",
  stimulus: null,
  stem: item.stem,
  parts: item.columns.map((column) => ({ kind: "column-choice" as const, prompt: column.trim(), options: lettered(item.options) })),
  figure: false,
  difficulty: item.difficulty
})

const msrItem = (item: MsrQuestion, page: number, tabs: StimulusDraft | null): ReadItem => ({
  number: item.number,
  page,
  section: "di",
  questionType: "di.msr",
  stimulus: tabs,
  stem: item.stem,
  parts: item.options.length > 0
    ? [{ kind: "single-choice" as const, prompt: null, options: item.options.map((option) => ({ ...option, text: option.text.trim() })) }]
    : statementParts(item.statements, item.pair),
  figure: false,
  difficulty: item.difficulty
})

// Each MSR set's tabs, by the numbers of the questions about it, from every
// question page of the set, in page order.
const msrTabs = (sources: ReadonlyArray<MsrSource>) => {
  const sets = new Map<string, Array<MsrSource>>()
  for (const source of sources) {
    const key = [...source.questions].toSorted((a, b) => a - b).join(",")
    sets.set(key, [...(sets.get(key) ?? []), source])
  }
  const byQuestion = new Map<number, StimulusDraft>()
  for (const members of sets.values()) {
    const tabs: StimulusDraft = {
      kind: "tabs",
      tabs: members.map((source) =>
        source.kind === "table" && source.table !== null
          ? { kind: "table" as const, title: source.title.trim(), body: source.text.trim(), table: tableDraft(source.table) }
          : { kind: "passage" as const, title: source.title.trim(), body: source.text.trim() }
      )
    }
    for (const number of members[0]!.questions) if (!byQuestion.has(number)) byQuestion.set(number, tabs)
  }
  return byQuestion
}

export const linkSet = (readings: SetReadings): ReadonlyArray<LinkedItem> => {
  // Each answer as printed, a part at a time; an answer key for one-answer
  // questions prints a single letter.
  const printed = byNumber(readings.answers.flatMap((reading) =>
    reading.role === "answer-key"
      ? reading.value.answers.map((answer) => ({
        number: answer.number,
        value: "parts" in answer ? answer.parts.map((part) => part.trim()).join("\u0000") : answer.answer
      }))
      : []
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
  const sources: Array<MsrSource> = []
  for (const { reading } of readings.questions) {
    if (reading.role !== "questions") continue
    if (reading.group === "rc") {
      for (const passage of reading.value.passages) {
        for (const number of passage.questions) if (!passages.has(number)) passages.set(number, passage.text.trim())
      }
    }
    if (reading.group === "msr") sources.push(...reading.value.sources)
    if (reading.group === "ir") sources.push(...reading.value.msr.sources)
  }
  const tabs = msrTabs(sources)
  const found = (number: number) => ({
    printed: printed.get(number) ?? [],
    explanation: explanations.get(number),
    explanationAnswers: explanationAnswers.get(number) ?? [],
    label: onlyValue(labels.get(number))
  })
  const add = (item: ReadItem) => {
    if (repeated(item.number, item.page, item.stem)) return
    linked.push(candidateOf(item, found(item.number)))
  }
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
          linked.push(candidateOf({
            number: item.number,
            page,
            section: "quant",
            questionType: "quant.ps",
            stimulus: null,
            stem: item.stem,
            parts: [{ kind: "single-choice", prompt: null, options: item.options }],
            figure: item.figure,
            difficulty: item.difficulty
          }, found(item.number)))
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
            stimulus: null,
            stem,
            parts: [{ kind: "single-choice", prompt: null, options: DsOptions }],
            figure: item.figure,
            difficulty: item.difficulty
          }, found(item.number)))
        }
        break
      case "cr":
      case "rc":
        for (const item of reading.value.questions) {
          const passage = reading.group === "rc" ? passages.get(item.number) : undefined
          add({
            number: item.number,
            page,
            section: "verbal",
            questionType: settledType(reading.group, item.stem, item.type),
            stimulus: passage === undefined ? null : { kind: "passage", body: passage },
            stem: item.stem,
            parts: [{ kind: "single-choice", prompt: null, options: item.options }],
            figure: false,
            difficulty: item.difficulty
          })
        }
        break
      case "ta":
        for (const item of reading.value.questions) add(taItem(item, page))
        break
      case "gi":
        for (const item of reading.value.questions) add(giItem(item, page))
        break
      case "tpa":
        for (const item of reading.value.questions) add(tpaItem(item, page))
        break
      case "msr":
        for (const item of reading.value.questions) add(msrItem(item, page, tabs.get(item.number) ?? null))
        break
      case "ir":
        // An older Book's Integrated Reasoning, each item as the type it maps onto.
        for (const item of reading.value.ta) add(taItem(item, page))
        for (const item of reading.value.gi) add(giItem(item, page))
        for (const item of reading.value.tpa) add(tpaItem(item, page))
        for (const item of reading.value.msr.questions) add(msrItem(item, page, tabs.get(item.number) ?? null))
        break
    }
  }
  return linked
}

// An answer as the Question keeps it: each Part's option label, joined; or
// the printed answers that name no option.
const answerFor = (parts: ReadonlyArray<Omit<CandidatePart, "key">>, printedAnswer: string) => {
  const pieces = printedAnswer.split("\u0000")
  if (pieces.length !== parts.length) return { labels: undefined, unmatched: [printedAnswer.replaceAll("\u0000", ", ")] }
  const labels = parts.map((part, index) => optionNamed(part.options, pieces[index]!))
  const unmatched = pieces.filter((_, index) => labels[index] === undefined)
  return { labels: unmatched.length === 0 ? labels as ReadonlyArray<string> : undefined, unmatched }
}

const candidateOf = (
  item: ReadItem,
  found: {
    readonly printed: ReadonlyArray<string>
    readonly explanation: { readonly text: string; readonly answer: Letter | null; readonly label: BookLabel | null } | undefined
    readonly explanationAnswers: ReadonlyArray<Letter>
    readonly label: BookLabel | null
  }
): Candidate => {
  const answers = found.printed.map((answer) => answerFor(item.parts, answer))
  const mapped = [...new Set(answers.flatMap((answer) => (answer.labels === undefined ? [] : [answer.labels.join(",")])))]
  const unmatched = answers.flatMap((answer) => answer.unmatched)
  // Two answers in the key give no key, rather than the explanation's.
  const conflict = mapped.length > 1 || (found.printed.length > 1 && unmatched.length > 0)
  const answerKey = !conflict && unmatched.length === 0 && mapped.length === 1 ? mapped[0]! : null
  // A Book's explanation states one letter, so it answers a single Part only.
  const single = item.parts.length === 1
  const explanationAnswer = single ? onlyValue(found.explanationAnswers) : null
  const key = conflict ? null : answerKey ?? (found.printed.length === 0 ? explanationAnswer : null)
  const keys = key === null ? item.parts.map(() => null) : key.split(",")
  return {
    _tag: "Candidate",
    number: item.number,
    page: item.page,
    section: item.section,
    questionType: item.questionType,
    stimulus: item.stimulus,
    stem: item.stem.trim(),
    parts: item.parts.map((part, index) => ({
      kind: part.kind,
      prompt: part.prompt,
      options: part.options.map((option) => ({ label: option.label, text: option.text.trim() })),
      key: keys[index] ?? null
    })),
    figure: item.figure,
    answerKey,
    explanationAnswer,
    key,
    keyAnswers: !conflict ? [] : mapped.length > 1 ? mapped : found.printed.map((answer) => answer.replaceAll("\u0000", ", ")),
    explanationAnswers: single && found.explanationAnswers.length > 1 ? found.explanationAnswers : [],
    unmatched,
    explanation: found.explanation?.text.trim() || null,
    label: found.label ?? found.explanation?.label ?? item.difficulty ?? null
  }
}

const Letters: ReadonlyArray<string> = ["A", "B", "C", "D", "E"]

// How many Parts each Question Type has, and how many options each Part.
const PartRules: Readonly<Record<string, { readonly parts: readonly [number, number]; readonly options: readonly [number, number] }>> = {
  "di.ta": { parts: [1, 5], options: [2, 2] },
  "di.gi": { parts: [1, 3], options: [2, 6] },
  "di.tpa": { parts: [2, 2], options: [3, 8] },
  "di.msr": { parts: [1, 5], options: [2, 5] }
}

const partProblems = (candidate: Candidate): ReadonlyArray<Reason> => {
  const reasons: Array<Reason> = []
  const parts = candidate.parts
  const rule = PartRules[candidate.questionType]
  if (rule === undefined || (parts.length === 1 && parts[0]!.kind === "single-choice")) {
    const labels = parts[0]?.options.map((option) => option.label) ?? []
    if (parts.length !== 1 || labels.length !== 5 || labels.some((label, index) => label !== Letters[index])) {
      reasons.push({
        code: "structure",
        detail: `It has ${labels.length === 0 ? "no answer choices" : `the answer choices ${labels.join(", ")}`}; it should have five, A to E.`
      })
    }
    return reasons
  }
  const [fewest, most] = rule.parts
  if (parts.length < fewest || parts.length > most) {
    reasons.push({
      code: "structure",
      detail: `It has ${parts.length} ${parts.length === 1 ? "part" : "parts"}; ${
        fewest === most ? `it should have ${fewest}` : `it should have ${fewest} to ${most}`
      }.`
    })
  }
  for (const [index, part] of parts.entries()) {
    const [least, greatest] = part.kind === "two-choice" ? [2, 2] : part.kind === "single-choice" ? [5, 5] : rule.options
    if (part.options.length < least || part.options.length > greatest) {
      reasons.push({
        code: "structure",
        detail: `Part ${index + 1} has ${part.options.length} options; it should have ${
          least === greatest ? least : `${least} to ${greatest}`
        }.`
      })
    }
    if (part.kind !== "single-choice" && (part.prompt ?? "").trim() === "") {
      reasons.push({ code: "structure", detail: `Part ${index + 1} has no words.` })
    }
    if (part.kind === "dropdown" && (part.prompt ?? "").split("{{blank}}").length !== 2) {
      reasons.push({ code: "structure", detail: `Part ${index + 1} should have one blank for its menu.` })
    }
  }
  if (candidate.questionType === "di.tpa" && parts.length === 2) {
    const [first, second] = parts.map((part) => part.options.map((option) => option.text).join("|"))
    if (first !== second) reasons.push({ code: "structure", detail: "Its two columns do not share one list of choices." })
  }
  return reasons
}

// A table's problems: a table with nothing in it, a row of the wrong length,
// or a cell whose text is not of its column's type.
export const tableProblems = (table: TableDraft): ReadonlyArray<string> => {
  if (table.columns.length === 0 || table.rows.length === 0) return ["The table is empty."]
  const problems: Array<string> = []
  for (const [index, row] of table.rows.entries()) {
    if (row.length !== table.columns.length) {
      problems.push(`Row ${index + 1} has ${row.length} cells for ${table.columns.length} columns.`)
      continue
    }
    for (const [column, text] of row.entries()) {
      const parsed = parseCell(table.columns[column]!.type, text)
      if ("problem" in parsed) problems.push(`In the column ${table.columns[column]!.name}, ${parsed.problem}`)
    }
  }
  return problems
}

const contents = (stimulus: StimulusDraft | null): ReadonlyArray<ContentDraft & { readonly title?: string }> =>
  stimulus === null ? [] : stimulus.kind === "tabs" ? stimulus.tabs : [stimulus]

// Every problem a Question has on its own, before it is compared with the
// Question Bank.
export const candidateProblems = (candidate: Candidate): ReadonlyArray<Reason> => {
  const reasons: Array<Reason> = [...partProblems(candidate)]
  if (candidate.stem === "") reasons.push({ code: "structure", detail: "Its question text is empty." })
  if (candidate.questionType.startsWith("verbal.rc-") && candidate.stimulus === null) {
    reasons.push({ code: "structure", detail: "The readings do not say which passage it asks about." })
  }
  if (candidate.questionType === "di.msr" && candidate.stimulus === null) {
    reasons.push({ code: "structure", detail: "The readings do not give the sources it asks about." })
  }
  for (const content of contents(candidate.stimulus)) {
    if (content.kind !== "table" && content.kind !== "chart") continue
    const problem = tableProblems(content.table)[0]
    if (problem !== undefined) {
      const where = content.title === undefined ? `Its ${content.kind === "table" ? "table" : "chart's data"}` : content.title
      reasons.push({ code: "structure", detail: `${where}: ${problem}` })
    }
  }
  const labelsOf = (index: number) => candidate.parts[index]?.options.map((option) => option.label) ?? []
  if (candidate.keyAnswers.length > 1) {
    reasons.push({
      code: "key-conflict",
      // A Question with several Parts has answers such as A,B,A, so those are
      // set apart with semicolons.
      detail: `The answer key gives more than one answer for it: ${
        candidate.keyAnswers.join(candidate.keyAnswers.some((answer) => answer.includes(",")) ? "; " : ", ")
      }.`
    })
  } else if (candidate.key === null) {
    reasons.push({
      code: "no-key",
      detail: candidate.unmatched.length > 0
        ? `The answer key's ${candidate.unmatched.join(", ")} matches none of its options.`
        : "The Book's answer key and explanations give no answer for it."
    })
  } else {
    const keys = candidate.key.split(",")
    if (keys.length !== candidate.parts.length || keys.some((key, index) => !labelsOf(index).includes(key))) {
      reasons.push({ code: "structure", detail: `Its key, ${candidate.key}, is not one of its answer choices.` })
    }
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
    ...contents(candidate.stimulus).flatMap((content) =>
      content.body === "" ? [] : [[content.kind === "passage" ? "passage" : "text with its figure", content.body] as const]
    ),
    ["question", candidate.stem],
    ...candidate.parts.flatMap((part, index) => [
      ...(part.prompt === null ? [] : [[`part ${index + 1}`, part.prompt.replace("{{blank}}", "")] as const]),
      ...part.options.map((option) =>
        [candidate.parts.length === 1 ? `choice ${option.label}` : `part ${index + 1}'s choice ${option.label}`, option.text] as const
      )
    ])
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

// The text compared when looking for the same Question in the Bank: its
// question, and each Part's words and options.
export const comparableText = (
  stem: string,
  parts: ReadonlyArray<{ readonly prompt: string | null; readonly options: ReadonlyArray<{ readonly text: string }> }>
) =>
  normalizeText(
    [stem, ...parts.flatMap((part) => [...(part.prompt === null ? [] : [part.prompt]), ...part.options.map((option) => option.text)])]
      .join(" | ")
  )

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
