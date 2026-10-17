import type { Dataset } from "../../api/dataset.ts"
import type { PartKind } from "../../api/parts.ts"
import { renderProblem } from "../../api/richText.ts"
import {
  chartSpec,
  type ContentDraft,
  datasetOfDraft,
  type Reason,
  type StimulusDraft,
  type TableDraft,
  tableProblems
} from "../books/linking.ts"
import {
  columnKeys,
  describeValue,
  dropdownKey,
  evaluate,
  type KeyOption,
  meetingPairs,
  plainWords,
  type Predicate,
  rowLabels,
  sameValue,
  twoChoiceKey,
  type Value
} from "./predicates.ts"
import {
  type GeneratedTable,
  type GeneratedType,
  type GiOutput,
  type MsrOutput,
  PairOptions,
  type TaOutput,
  type TpaOutput
} from "./prompts.ts"

// A generator reply made into Questions, each Part keyed by code from its
// predicate, or kept as an inference from text for the solves and the
// Curator to confirm. A reply that breaks a rule gives its problems instead,
// for the generator to fix.

export type Statement =
  | {
    readonly kind: "computed"
    // The Dataset it reads, by place in the item's datasets.
    readonly dataset: number
    readonly predicate: Predicate
    readonly approximate: boolean
    readonly result: Value
  }
  | { readonly kind: "inference" }

export interface DraftPart {
  readonly kind: PartKind
  readonly prompt: string
  readonly options: ReadonlyArray<KeyOption>
  readonly key: string
  readonly statement: Statement
}

export interface DraftQuestion {
  readonly stem: string
  readonly parts: ReadonlyArray<DraftPart>
}

export interface DraftItem {
  readonly questionType: GeneratedType
  readonly stimulus: StimulusDraft
  // The Datasets its predicates read: the item's one, or an MSR set's, one
  // for each tab, null for a tab of text.
  readonly datasets: ReadonlyArray<Dataset | null>
  // An MSR set's three Questions; one otherwise.
  readonly questions: ReadonlyArray<DraftQuestion>
}

export type Built = { readonly item: DraftItem } | { readonly problems: ReadonlyArray<string> }

const lettered = (texts: ReadonlyArray<string>): ReadonlyArray<KeyOption> =>
  texts.map((text, index) => ({ label: String.fromCharCode(65 + index), text: text.trim() }))

const tableOf = (table: GeneratedTable): TableDraft => ({
  columns: table.columns.map((column) => ({ name: column.name.trim(), type: column.type, unit: column.unit.trim() })),
  rows: table.rows.map((row) => row.map((cell) => cell.trim()))
})

// A table's problems beyond its cells' types: its size, and names that must
// tell its columns and rows apart.
const tableRules = (table: TableDraft, where: string): ReadonlyArray<string> => {
  const problems = tableProblems(table).map((problem) => `${where}: ${problem}`)
  if (table.columns.length < 2 || table.columns.length > 8) problems.push(`${where} has ${table.columns.length} columns; write 4 to 6.`)
  if (table.rows.length < 3 || table.rows.length > 20) problems.push(`${where} has ${table.rows.length} rows; write 6 to 12.`)
  const names = table.columns.map((column) => plainWords(column.name))
  if (names.some((name) => name === "")) problems.push(`${where} has a column with no name.`)
  if (new Set(names).size !== names.length) problems.push(`${where} has two columns with the same name.`)
  const labels = rowLabels(datasetOfDraft(table))
  if (labels.some((label) => label === "")) problems.push(`${where} has a row whose first column is empty.`)
  if (new Set(labels).size !== labels.length) problems.push(`${where} has two rows with the same name in its first column.`)
  return problems
}

const textProblems = (texts: ReadonlyArray<readonly [string, string]>) =>
  texts.flatMap(([where, text]) => {
    if (text.trim() === "") return [`${where} is empty.`]
    const problem = renderProblem(text)
    return problem === undefined ? [] : [`${where} does not render: ${problem}`]
  })

const distinct = (texts: ReadonlyArray<string>) => new Set(texts.map(plainWords)).size === texts.length

// A statement's key and how it was reached.
const keyed = (
  where: string,
  predicate: Predicate,
  dataset: Dataset,
  dataIndex: number,
  options: ReadonlyArray<KeyOption>,
  kind: "two-choice" | "dropdown",
  approximate: boolean
): { readonly part: Omit<DraftPart, "kind" | "prompt" | "options"> } | { readonly problem: string } => {
  const outcome = evaluate(predicate, dataset)
  if ("problem" in outcome) return { problem: `${where}'s predicate cannot be evaluated: ${outcome.problem}.` }
  const key = kind === "two-choice" ? twoChoiceKey(outcome.value, options) : dropdownKey(outcome.value, options, approximate)
  if ("problem" in key) return { problem: `${where}: ${key.problem}.` }
  return {
    part: {
      key: key.key,
      statement: { kind: "computed", dataset: dataIndex, predicate, approximate, result: outcome.value }
    }
  }
}

const build = (problems: ReadonlyArray<string>, item: () => DraftItem): Built =>
  problems.length > 0 ? { problems } : { item: item() }

export const buildTa = (output: TaOutput): Built => {
  const table = tableOf(output.table)
  const problems: Array<string> = [...tableRules(table, "The table")]
  problems.push(...textProblems([["The intro", output.intro], ...output.statements.map((each, i) => [`Statement ${i + 1}`, each.text] as const)]))
  if (output.statements.length !== 3) problems.push(`There are ${output.statements.length} statements; write exactly 3.`)
  if (problems.length > 0) return { problems }
  const dataset = datasetOfDraft(table)
  const options = lettered(PairOptions[output.pair])
  const parts: Array<DraftPart> = []
  for (const [index, statement] of output.statements.entries()) {
    const found = keyed(`Statement ${index + 1}`, statement.predicate, dataset, 0, options, "two-choice", false)
    if ("problem" in found) problems.push(found.problem)
    else parts.push({ kind: "two-choice", prompt: statement.text.trim(), options, ...found.part })
  }
  if (parts.length === 3 && new Set(parts.map((part) => part.key)).size === 1) {
    problems.push("All three statements have the same answer; make at least one answer differ.")
  }
  return build(problems, () => ({
    questionType: "di.ta",
    stimulus: { kind: "table", body: "", table },
    datasets: [dataset],
    questions: [{ stem: output.intro.trim(), parts }]
  }))
}

export const buildGi = (output: GiOutput): Built => {
  const table = tableOf(output.table)
  const problems: Array<string> = [...tableRules(table, "The chart's data")]
  problems.push(...textProblems([
    ["The intro", output.intro],
    ...output.blanks.flatMap((blank, i) => [
      [`Blank ${i + 1}'s sentence`, blank.text.replace("{{blank}}", "")] as const,
      ...blank.options.map((option, j) => [`Blank ${i + 1}'s option ${j + 1}`, option] as const)
    ])
  ]))
  if (output.blanks.length !== 2) problems.push(`There are ${output.blanks.length} blanks; write exactly 2.`)
  for (const [index, blank] of output.blanks.entries()) {
    if (blank.text.split("{{blank}}").length !== 2) problems.push(`Blank ${index + 1}'s sentence needs {{blank}} exactly once.`)
    if (blank.options.length < 3 || blank.options.length > 5) {
      problems.push(`Blank ${index + 1} has ${blank.options.length} options; write 3 to 5.`)
    }
    if (!distinct(blank.options)) problems.push(`Blank ${index + 1} has two options alike.`)
  }
  const column = (name: string) => table.columns.find((each) => plainWords(each.name) === plainWords(name))
  const x = column(output.chart.x)
  const y = column(output.chart.y)
  if (x === undefined) problems.push(`The chart's x, ${output.chart.x}, is not a column of its data.`)
  if (y === undefined) problems.push(`The chart's y, ${output.chart.y}, is not a column of its data.`)
  else if (y.type === "text" || y.type === "date") problems.push(`The chart's y, ${output.chart.y}, is not a column of numbers.`)
  const series = output.chart.series.trim()
  if (series !== "" && column(series) === undefined) problems.push(`The chart's series, ${series}, is not a column of its data.`)
  if (problems.length > 0) return { problems }
  const dataset = datasetOfDraft(table)
  const parts: Array<DraftPart> = []
  for (const [index, blank] of output.blanks.entries()) {
    const options = lettered(blank.options)
    const found = keyed(`Blank ${index + 1}`, blank.predicate, dataset, 0, options, "dropdown", blank.approximate)
    if ("problem" in found) problems.push(found.problem)
    else parts.push({ kind: "dropdown", prompt: blank.text.trim(), options, ...found.part })
  }
  const spec = chartSpec({
    kind: output.chart.kind,
    title: output.chart.title.trim(),
    data: table,
    x: x!.name,
    y: y!.name,
    series: series === "" ? "" : column(series)!.name,
    sets: []
  })
  return build(problems, () => ({
    questionType: "di.gi",
    stimulus: { kind: "chart", body: "", table, spec },
    datasets: [dataset],
    questions: [{ stem: output.intro.trim(), parts }]
  }))
}

export const buildTpa = (output: TpaOutput): Built => {
  const table = tableOf(output.table)
  const problems: Array<string> = [...tableRules(table, "The table")]
  problems.push(...textProblems([
    ["The intro", output.intro],
    ...output.columns.map((column, i) => [`Column ${i + 1}'s heading`, column.heading] as const),
    ...output.options.map((option, i) => [`Option ${i + 1}`, option] as const)
  ]))
  if (output.columns.length !== 2) problems.push(`There are ${output.columns.length} columns; write exactly 2.`)
  if (output.options.length < 5 || output.options.length > 6) {
    problems.push(`There are ${output.options.length} options; write 5 or 6.`)
  }
  if (!distinct(output.options)) problems.push("Two options are alike.")
  if (problems.length > 0) return { problems }
  const dataset = datasetOfDraft(table)
  const options = lettered(output.options)
  const predicates = [output.columns[0]!.predicate, output.columns[1]!.predicate] as const
  const keys = columnKeys(predicates, options, dataset)
  if ("problem" in keys) return { problems: [`The columns: ${keys.problem}.`] }
  const pairs = meetingPairs(predicates, options, dataset)
  const result: Value = { kind: "rows", rows: "pairs" in pairs ? pairs.pairs.flat() : [] }
  return {
    item: {
      questionType: "di.tpa",
      stimulus: { kind: "table", body: "", table },
      datasets: [dataset],
      questions: [{
        stem: output.intro.trim(),
        parts: output.columns.map((column, index) => ({
          kind: "column-choice",
          prompt: column.heading.trim(),
          options,
          key: keys.keys[index]!,
          statement: { kind: "computed", dataset: 0, predicate: column.predicate, approximate: false, result }
        }))
      }]
    }
  }
}

export const buildMsr = (output: MsrOutput): Built => {
  const problems: Array<string> = []
  if (output.tabs.length < 2 || output.tabs.length > 3) problems.push(`There are ${output.tabs.length} tabs; write 2 or 3.`)
  if (!distinct(output.tabs.map((tab) => tab.title))) problems.push("Two tabs have the same title.")
  if (!output.tabs.some((tab) => tab.table !== null)) problems.push("No tab has a table; make at least one a data tab.")
  const tables = output.tabs.map((tab) => (tab.table === null ? null : tableOf(tab.table)))
  for (const [index, table] of tables.entries()) {
    if (table !== null) problems.push(...tableRules(table, `Tab ${index + 1}'s table`))
  }
  problems.push(...textProblems([
    ...output.tabs.flatMap((tab, i) => [[`Tab ${i + 1}'s title`, tab.title], [`Tab ${i + 1}'s text`, tab.text]] as const),
    ...output.questions.flatMap((question, i) => [
      [`Question ${i + 1}'s intro`, question.intro] as const,
      ...question.statements.map((statement, j) => [`Question ${i + 1}'s statement ${j + 1}`, statement.text] as const)
    ])
  ]))
  if (output.questions.length !== 3) problems.push(`There are ${output.questions.length} questions; write exactly 3.`)
  for (const [index, question] of output.questions.entries()) {
    if (question.statements.length !== 3) {
      problems.push(`Question ${index + 1} has ${question.statements.length} statements; write exactly 3.`)
    }
    if (question.statements.filter((statement) => statement.predicate === null).length > 1) {
      problems.push(`Question ${index + 1} has more than one inference from text; write at most one.`)
    }
  }
  if (problems.length > 0) return { problems }
  const datasets = tables.map((table) => (table === null ? null : datasetOfDraft(table)))
  const questions: Array<DraftQuestion> = []
  for (const [index, question] of output.questions.entries()) {
    const options = lettered(PairOptions[question.pair])
    const parts: Array<DraftPart> = []
    for (const [place, statement] of question.statements.entries()) {
      const where = `Question ${index + 1}'s statement ${place + 1}`
      const base = { kind: "two-choice" as const, prompt: statement.text.trim(), options }
      if (statement.predicate === null) {
        if (statement.answer === null) {
          problems.push(`${where} has neither a predicate nor an answer.`)
          continue
        }
        parts.push({ ...base, key: options[statement.answer === "first" ? 0 : 1]!.label, statement: { kind: "inference" } })
        continue
      }
      const tab = statement.tab === null ? undefined : statement.tab - 1
      const dataset = tab === undefined ? undefined : datasets[tab]
      if (dataset === undefined || dataset === null) {
        problems.push(`${where} gives tab ${statement.tab ?? "none"}, which is not a data tab.`)
        continue
      }
      const found = keyed(where, statement.predicate, dataset, tab!, options, "two-choice", false)
      if ("problem" in found) problems.push(found.problem)
      else parts.push({ ...base, ...found.part })
    }
    questions.push({ stem: question.intro.trim(), parts })
  }
  return build(problems, () => ({
    questionType: "di.msr",
    stimulus: {
      kind: "tabs",
      tabs: output.tabs.map((tab, index): ContentDraft & { readonly title: string } => {
        const table = tables[index]
        return table === null || table === undefined
          ? { kind: "passage", title: tab.title.trim(), body: tab.text.trim() }
          : { kind: "table", title: tab.title.trim(), body: tab.text.trim(), table }
      })
    },
    datasets,
    questions
  }))
}

export const buildItem = (type: GeneratedType, output: unknown): Built => {
  switch (type) {
    case "di.ta":
      return buildTa(output as TaOutput)
    case "di.gi":
      return buildGi(output as GiOutput)
    case "di.tpa":
      return buildTpa(output as TpaOutput)
    case "di.msr":
      return buildMsr(output as MsrOutput)
  }
}

// How a reason about a Part begins, so a Key Override of that Part can
// settle it: a Two-Part Analysis's columns are read together.
export const partReasonPrefix = (kind: PartKind, index: number) =>
  kind === "dropdown" ? `Blank ${index + 1}:` : kind === "column-choice" ? "The columns:" : `Statement ${index + 1}:`

// A second reading of a Part's words, as generate.ts asks for it: its
// predicate, whether it reads a blank as approximate, and the tab it reads,
// by place from 0, null for an item with one table.
export interface SecondReading {
  readonly predicate: Predicate
  readonly approximate: boolean
  readonly dataset: number | null
}

// Where a Question's second readings disagree with its predicates: a Part
// whose two predicates give different results, whose second reading reads
// another tab or takes a blank as approximate where the generator did not (or
// the reverse), or whose second reading cannot be run. For a Two-Part
// Analysis, both columns' predicates are read again together and must be met
// by the same pairs. titles names an MSR set's tabs.
export const disagreements = (
  question: DraftQuestion,
  datasets: ReadonlyArray<Dataset | null>,
  seconds: ReadonlyArray<SecondReading | null>,
  titles: ReadonlyArray<string> = []
): ReadonlyArray<Reason> => {
  const reasons: Array<Reason> = []
  const disagree = (detail: string) => reasons.push({ code: "predicate-disagreement", detail })
  if (question.parts.every((part) => part.kind === "column-choice")) {
    const first = question.parts.map((part) => part.statement)
    const dataset = datasets[0]
    if (first.length !== 2 || dataset === null || dataset === undefined) return reasons
    const [a, b] = seconds.map((second) => second?.predicate)
    if (a === undefined || b === undefined) {
      disagree("The columns: the second reading of the problem gave no usable predicates.")
      return reasons
    }
    const predicates = first.map((statement) => (statement.kind === "computed" ? statement.predicate : null))
    if (predicates.includes(null)) return reasons
    const options = question.parts[0]!.options
    const original = meetingPairs([predicates[0]!, predicates[1]!], options, dataset)
    const again = meetingPairs([a, b], options, dataset)
    if ("problem" in again) {
      disagree(`The columns: the second reading of the problem cannot be checked: ${again.problem}.`)
      return reasons
    }
    const named = (pairs: ReadonlyArray<readonly [number, number]>) =>
      pairs.length === 0 ? "no pair" : pairs.map(([x, y]) => `${options[x]!.label} and ${options[y]!.label}`).join("; ")
    if ("pairs" in original && named(original.pairs) !== named(again.pairs)) {
      disagree(`The columns: their predicates are met by ${named(original.pairs)}, but a second reading of the problem is met by ${named(again.pairs)}.`)
    }
    return reasons
  }
  const tabName = (place: number) => (titles[place] === undefined ? `tab ${place + 1}` : `the tab ${titles[place]}`)
  for (const [index, part] of question.parts.entries()) {
    if (part.statement.kind !== "computed") continue
    const where = partReasonPrefix(part.kind, index).replace(/:$/, "")
    const dataset = datasets[part.statement.dataset]
    const second = seconds[index]
    if (dataset === null || dataset === undefined) continue
    if (second === null || second === undefined) {
      disagree(`${where}: the second reading of its words gave no usable predicate.`)
      continue
    }
    // In a set of sources the second reading chooses its own tab.
    if (datasets.length > 1 && second.dataset !== part.statement.dataset) {
      disagree(`${where}: its predicate reads ${tabName(part.statement.dataset)}, but a second reading of its words reads ${
        second.dataset === null ? "no tab" : tabName(second.dataset)
      }.`)
      continue
    }
    if (part.kind === "dropdown" && second.approximate !== part.statement.approximate) {
      const as = (approximate: boolean) => (approximate ? "an approximate value" : "an exact value")
      disagree(`${where}: it is keyed as ${as(part.statement.approximate)}, but a second reading of its words asks for ${
        as(second.approximate)
      }.`)
      continue
    }
    const outcome = evaluate(second.predicate, dataset)
    if ("problem" in outcome) {
      disagree(`${where}: the second reading of its words cannot be checked: ${outcome.problem}.`)
      continue
    }
    if (!sameValue(part.statement.result, outcome.value)) {
      disagree(`${where}: its predicate gives ${describeValue(part.statement.result, dataset)}, but a second reading of its words gives ${
        describeValue(outcome.value, dataset)
      }.`)
    }
  }
  return reasons
}
