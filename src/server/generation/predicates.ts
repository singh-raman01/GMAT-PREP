import { Schema } from "effect"
import type { CellValue, ColumnType, Dataset } from "../../api/dataset.ts"
import { compareCells, parseDate } from "../../api/dataset.ts"

// The DI evaluator (ADR 0003): a small query language over a Dataset, and the
// rules that turn its result into a Generated Question's key. A predicate is
// a list of steps, each naming its result, that refer to earlier steps by
// name; the last step's result is the predicate's. Rows are named by their
// first column, the Dataset's labels.

export const Comparison = Schema.Literals(["<", "<=", ">", ">=", "=", "!="])
export type Comparison = typeof Comparison.Type

export const Order = Schema.Literals(["ascending", "descending"])
export type Order = typeof Order.Type

const name = Schema.String
const ref = Schema.String
const optionalRef = Schema.NullOr(Schema.String)

// Each kind of step. Fields a step leaves unused are null, so every step has
// the strict JSON form models are asked for.
export const Step = Schema.Union([
  // The rows, of all of them or of an earlier list, whose cell in the column
  // compares so with a number (number, percent and currency columns) or a
  // text (text columns take = and != only; date columns take any comparison).
  Schema.Struct({
    op: Schema.Literal("filter"),
    name,
    from: optionalRef,
    column: Schema.String,
    comparison: Comparison,
    number: Schema.NullOr(Schema.Finite),
    text: Schema.NullOr(Schema.String)
  }),
  // The rows, of all or of an earlier list, ordered by a column; missing
  // values go last.
  Schema.Struct({ op: Schema.Literal("sort"), name, from: optionalRef, column: Schema.String, order: Order }),
  // The row at a place, from 1, in an earlier list, such as the first of a sort.
  Schema.Struct({ op: Schema.Literal("pick"), name, from: ref, position: Schema.Int }),
  // The row with this label.
  Schema.Struct({ op: Schema.Literal("row"), name, label: Schema.String }),
  Schema.Struct({ op: Schema.Literal("count"), name, rows: optionalRef }),
  Schema.Struct({ op: Schema.Literal("sum"), name, rows: optionalRef, column: Schema.String }),
  Schema.Struct({ op: Schema.Literal("average"), name, rows: optionalRef, column: Schema.String }),
  // A row's cell: a number, or for text and date columns its words.
  Schema.Struct({ op: Schema.Literal("value"), name, row: ref, column: Schema.String }),
  // A row's place, from 1, among all rows ordered by a column; tied rows
  // share the better place.
  Schema.Struct({ op: Schema.Literal("rank"), name, row: ref, column: Schema.String, order: Order }),
  // A row's label.
  Schema.Struct({ op: Schema.Literal("label"), name, row: ref }),
  Schema.Struct({ op: Schema.Literal("ratio"), name, of: ref, to: ref }),
  // The change from one number to another, in percent of the first.
  Schema.Struct({ op: Schema.Literal("percent-change"), name, from: ref, to: ref }),
  Schema.Struct({ op: Schema.Literal("difference"), name, of: ref, minus: ref }),
  // Yes or no: a number against another or a constant, or words against
  // other words or a constant text.
  Schema.Struct({
    op: Schema.Literal("compare"),
    name,
    left: ref,
    comparison: Comparison,
    right: optionalRef,
    number: Schema.NullOr(Schema.Finite),
    text: Schema.NullOr(Schema.String)
  }),
  // How one number stands to another: greater than, less than or equal to.
  Schema.Struct({ op: Schema.Literal("relation"), name, left: ref, right: ref }),
  // Yes when two rows are the same row.
  Schema.Struct({ op: Schema.Literal("same-row"), name, left: ref, right: ref }),
  Schema.Struct({ op: Schema.Literal("all"), name, of: Schema.Array(ref) }),
  Schema.Struct({ op: Schema.Literal("any"), name, of: Schema.Array(ref) }),
  Schema.Struct({ op: Schema.Literal("not"), name, of: ref }),
  // In a Two-Part Analysis, the option chosen in column 1 or 2: the row it
  // names, else its number, else its words.
  Schema.Struct({ op: Schema.Literal("choice"), name, column: Schema.Int })
])
export type Step = typeof Step.Type

export const Predicate = Schema.Struct({ steps: Schema.Array(Step) })
export type Predicate = typeof Predicate.Type

export const MaxSteps = 12

export type Value =
  // A list of rows, with the column a sort ordered it by, so a pick can tell
  // a tie.
  | { readonly kind: "rows"; readonly rows: ReadonlyArray<number>; readonly sortedBy?: SortKey }
  | { readonly kind: "row"; readonly row: number }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "words"; readonly value: string }

export type Evaluated = { readonly value: Value } | { readonly problem: string }

interface SortKey {
  readonly column: number
  readonly type: ColumnType
  readonly name: string
}

const NumericTypes: ReadonlySet<ColumnType> = new Set(["number", "percent", "currency"])

// Words as compared: case, spacing and a final full stop do not count.
export const plainWords = (text: string) => text.trim().replace(/\.$/, "").replace(/\s+/g, " ").toLowerCase()

// Two numbers are equal when they differ only by floating-point rounding.
export const sameNumber = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))

const compareNumbers = (a: number, comparison: Comparison, b: number) => {
  if (sameNumber(a, b)) return comparison === "=" || comparison === "<=" || comparison === ">="
  switch (comparison) {
    case "<":
    case "<=":
      return a < b
    case ">":
    case ">=":
      return a > b
    case "=":
      return false
    case "!=":
      return true
  }
}

const compareWords = (a: string, comparison: Comparison, b: string) => {
  const order = a < b ? -1 : a > b ? 1 : 0
  switch (comparison) {
    case "<":
      return order < 0
    case "<=":
      return order <= 0
    case ">":
      return order > 0
    case ">=":
      return order >= 0
    case "=":
      return order === 0
    case "!=":
      return order !== 0
  }
}

// The label of each row: its first cell's words.
export const rowLabels = (dataset: Dataset) => dataset.rows.map((row) => plainWords(row[0]?.text ?? ""))

const numberOf = (cell: CellValue | undefined) => (typeof cell?.value === "number" ? cell.value : undefined)

export interface Bindings {
  // A Two-Part Analysis's chosen options, by column from 1.
  readonly choices?: ReadonlyArray<Value>
}

// Evaluates a predicate over a Dataset. A step that cannot be evaluated, such
// as one naming a column the Dataset lacks, gives a problem instead.
export const evaluate = (predicate: Predicate, dataset: Dataset, bindings: Bindings = {}): Evaluated => {
  if (predicate.steps.length === 0) return { problem: "The predicate has no steps." }
  if (predicate.steps.length > MaxSteps) return { problem: `The predicate has more than ${MaxSteps} steps.` }
  const values = new Map<string, Value>()
  const labels = rowLabels(dataset)
  const all: ReadonlyArray<number> = dataset.rows.map((_, index) => index)
  let last: Value | undefined
  for (const step of predicate.steps) {
    if (values.has(step.name)) return { problem: `Two steps are named ${step.name}.` }
    const outcome = evaluateStep(step, { dataset, labels, all, values, bindings })
    if ("problem" in outcome) return { problem: `Step ${step.name}: ${outcome.problem}` }
    values.set(step.name, outcome.value)
    last = outcome.value
  }
  return { value: last! }
}

interface Scope {
  readonly dataset: Dataset
  readonly labels: ReadonlyArray<string>
  readonly all: ReadonlyArray<number>
  readonly values: ReadonlyMap<string, Value>
  readonly bindings: Bindings
}

type Kinded<K extends Value["kind"]> = Extract<Value, { readonly kind: K }>

const evaluateStep = (step: Step, scope: Scope): Evaluated => {
  const { dataset } = scope
  const get = <K extends Value["kind"]>(reference: string, ...kinds: ReadonlyArray<K>): Kinded<K> | string => {
    const value = scope.values.get(reference)
    if (value === undefined) return `it refers to ${reference}, which no earlier step names`
    if (!(kinds as ReadonlyArray<string>).includes(value.kind)) return `${reference} is not ${kinds.join(" or ")}`
    return value as Kinded<K>
  }
  const listOf = (reference: string | null): Kinded<"rows"> | string =>
    reference === null ? { kind: "rows", rows: scope.all } : get(reference, "rows")
  const rowsOf = (reference: string | null): ReadonlyArray<number> | string => {
    const list = listOf(reference)
    return typeof list === "string" ? list : list.rows
  }
  const columnOf = (column: string) => {
    const index = dataset.columns.findIndex((each) => plainWords(each.name) === plainWords(column))
    return index < 0 ? `the Dataset has no column ${column}` : { index, type: dataset.columns[index]!.type }
  }
  const numericColumn = (column: string) => {
    const found = columnOf(column)
    if (typeof found === "string") return found
    return NumericTypes.has(found.type) ? found : `${column} is not a column of numbers`
  }
  const fail = (problem: string): Evaluated => ({ problem })
  const ok = (value: Value): Evaluated => ({ value })

  switch (step.op) {
    case "filter": {
      const list = listOf(step.from)
      if (typeof list === "string") return fail(list)
      const column = columnOf(step.column)
      if (typeof column === "string") return fail(column)
      if (NumericTypes.has(column.type) && step.number === null) return fail(`a filter on ${step.column} needs a number`)
      // A date compares with a date as the table prints them, at the coarser
      // of the two: "after 2019" leaves out November 2019.
      const date = column.type === "date" ? parseDate((step.text ?? (step.number === null ? "" : String(step.number))).trim()) : undefined
      if (column.type === "date" && date === undefined) {
        return fail(`a filter on ${step.column} needs a date, such as 2019, Mar 2019 or 3/15/2019`)
      }
      if (column.type === "text") {
        if (step.text === null) return fail(`a filter on ${step.column} needs words`)
        if (step.comparison !== "=" && step.comparison !== "!=") return fail(`words compare only with = or !=`)
      }
      // A missing cell never passes a filter.
      const keep = (row: number) => {
        const cell = dataset.rows[row]?.[column.index]
        if (cell === undefined || isMissing(column.type, cell)) return false
        if (NumericTypes.has(column.type)) {
          const value = numberOf(cell)
          return value !== undefined && compareNumbers(value, step.comparison, step.number!)
        }
        if (column.type === "date") {
          const value = cell.value
          if (typeof value !== "string") return false
          const length = Math.min(value.length, date!.length)
          return compareWords(value.slice(0, length), step.comparison, date!.slice(0, length))
        }
        return compareWords(plainWords(cell.text), step.comparison, plainWords(step.text!))
      }
      return ok({
        kind: "rows",
        rows: list.rows.filter(keep),
        ...(list.sortedBy === undefined ? {} : { sortedBy: list.sortedBy })
      })
    }
    case "sort": {
      const rows = rowsOf(step.from)
      if (typeof rows === "string") return fail(rows)
      const column = columnOf(step.column)
      if (typeof column === "string") return fail(column)
      return ok({
        kind: "rows",
        rows: sortedRows(dataset, rows, column.index, column.type, step.order),
        sortedBy: { column: column.index, type: column.type, name: step.column }
      })
    }
    case "pick": {
      const list = listOf(step.from)
      if (typeof list === "string") return fail(list)
      const row = list.rows[step.position - 1]
      if (row === undefined) return fail(`the list has no row at place ${step.position}`)
      // A row that ties with the one before or after it on the sort's column
      // has no place of its own, so the pick would be the table's order.
      const by = list.sortedBy
      if (by !== undefined) {
        const own = dataset.rows[row]?.[by.column]
        const tied = [list.rows[step.position - 2], list.rows[step.position]].some((other) => {
          const cell = other === undefined ? undefined : dataset.rows[other]?.[by.column]
          return own !== undefined && cell !== undefined && !isMissing(by.type, own) && !isMissing(by.type, cell) &&
            sameCell(by.type, own, cell)
        })
        if (tied) return fail(`rows tie on ${by.name} at place ${step.position}, so no one row is there`)
      }
      return ok({ kind: "row", row })
    }
    case "row": {
      const wanted = plainWords(step.label)
      const found = scope.labels.flatMap((label, index) => (label === wanted ? [index] : []))
      if (found.length === 0) return fail(`no row is labelled ${step.label}`)
      if (found.length > 1) return fail(`several rows are labelled ${step.label}`)
      return ok({ kind: "row", row: found[0]! })
    }
    case "count": {
      const rows = rowsOf(step.rows)
      return typeof rows === "string" ? fail(rows) : ok({ kind: "number", value: rows.length })
    }
    case "sum":
    case "average": {
      const rows = rowsOf(step.rows)
      if (typeof rows === "string") return fail(rows)
      const column = numericColumn(step.column)
      if (typeof column === "string") return fail(column)
      const numbers = rows.flatMap((row) => {
        const value = numberOf(dataset.rows[row]?.[column.index])
        return value === undefined ? [] : [value]
      })
      const total = numbers.reduce((sum, value) => sum + value, 0)
      if (step.op === "sum") return ok({ kind: "number", value: total })
      return numbers.length === 0 ? fail(`no row has a value of ${step.column}`) : ok({
        kind: "number",
        value: total / numbers.length
      })
    }
    case "value": {
      const row = get(step.row, "row")
      if (typeof row === "string") return fail(row)
      const column = columnOf(step.column)
      if (typeof column === "string") return fail(column)
      const cell = dataset.rows[row.row]?.[column.index]
      if (NumericTypes.has(column.type)) {
        const value = numberOf(cell)
        return value === undefined ? fail(`the row has no value of ${step.column}`) : ok({ kind: "number", value })
      }
      const words = column.type === "date" ? cell?.value : cell?.text
      return typeof words !== "string" || words.trim() === ""
        ? fail(`the row has no value of ${step.column}`)
        : ok({ kind: "words", value: column.type === "date" ? words : plainWords(words) })
    }
    case "rank": {
      const row = get(step.row, "row")
      if (typeof row === "string") return fail(row)
      const column = columnOf(step.column)
      if (typeof column === "string") return fail(column)
      const own = dataset.rows[row.row]?.[column.index]
      if (own === undefined || isMissing(column.type, own)) return fail(`the row has no value of ${step.column}`)
      const sign = step.order === "ascending" ? 1 : -1
      const better = scope.all.filter((other) => {
        const cell = dataset.rows[other]?.[column.index]
        return cell !== undefined && !isMissing(column.type, cell) && sign * compareCells(column.type, cell, own) < 0 &&
          !sameCell(column.type, cell, own)
      })
      return ok({ kind: "number", value: better.length + 1 })
    }
    case "label": {
      const row = get(step.row, "row")
      return typeof row === "string" ? fail(row) : ok({ kind: "words", value: scope.labels[row.row]! })
    }
    case "ratio":
    case "percent-change":
    case "difference": {
      const [first, second] = step.op === "ratio"
        ? [step.of, step.to]
        : step.op === "percent-change"
        ? [step.from, step.to]
        : [step.of, step.minus]
      const a = get(first, "number")
      if (typeof a === "string") return fail(a)
      const b = get(second, "number")
      if (typeof b === "string") return fail(b)
      if (step.op === "difference") return ok({ kind: "number", value: a.value - b.value })
      if (step.op === "ratio") return b.value === 0 ? fail("it divides by zero") : ok({ kind: "number", value: a.value / b.value })
      return a.value === 0
        ? fail("a change from zero has no percent")
        : ok({ kind: "number", value: (b.value - a.value) / Math.abs(a.value) * 100 })
    }
    case "compare": {
      const left = get(step.left, "number", "words")
      if (typeof left === "string") return fail(left)
      const right = step.right !== null
        ? get(step.right, "number", "words")
        : step.number !== null
        ? { kind: "number" as const, value: step.number }
        : step.text !== null
        ? { kind: "words" as const, value: plainWords(step.text) }
        : "it compares with nothing"
      if (typeof right === "string") return fail(right)
      if (left.kind !== right.kind) return fail("it compares a number with words")
      return ok({
        kind: "boolean",
        value: left.kind === "number"
          ? compareNumbers(left.value, step.comparison, right.value as number)
          : compareWords(left.value, step.comparison, right.value as string)
      })
    }
    case "relation": {
      const a = get(step.left, "number")
      if (typeof a === "string") return fail(a)
      const b = get(step.right, "number")
      if (typeof b === "string") return fail(b)
      return ok({
        kind: "words",
        value: sameNumber(a.value, b.value) ? "equal to" : a.value > b.value ? "greater than" : "less than"
      })
    }
    case "same-row": {
      const a = get(step.left, "row")
      if (typeof a === "string") return fail(a)
      const b = get(step.right, "row")
      if (typeof b === "string") return fail(b)
      return ok({ kind: "boolean", value: a.row === b.row })
    }
    case "all":
    case "any": {
      if (step.of.length === 0) return fail("it joins no steps")
      const found: Array<boolean> = []
      for (const reference of step.of) {
        const value = get(reference, "boolean")
        if (typeof value === "string") return fail(value)
        found.push(value.value)
      }
      return ok({ kind: "boolean", value: step.op === "all" ? found.every(Boolean) : found.some(Boolean) })
    }
    case "not": {
      const value = get(step.of, "boolean")
      return typeof value === "string" ? fail(value) : ok({ kind: "boolean", value: !value.value })
    }
    case "choice": {
      const value = scope.bindings.choices?.[step.column - 1]
      return value === undefined ? fail(`there is no column ${step.column} to choose in`) : ok(value)
    }
  }
}

const isMissing = (type: ColumnType, cell: CellValue) => (type === "text" ? cell.text.trim() === "" : cell.value === null)

const sameCell = (type: ColumnType, a: CellValue, b: CellValue) =>
  type === "text"
    ? plainWords(a.text) === plainWords(b.text)
    : typeof a.value === "number" && typeof b.value === "number"
    ? sameNumber(a.value, b.value)
    : a.value === b.value

// Rows in a column's order, keeping the Dataset's order between equal ones,
// with missing values last either way.
const sortedRows = (dataset: Dataset, rows: ReadonlyArray<number>, column: number, type: ColumnType, order: Order) => {
  const sign = order === "ascending" ? 1 : -1
  return rows.toSorted((a, b) => {
    const left = dataset.rows[a]?.[column]
    const right = dataset.rows[b]?.[column]
    const leftMissing = left === undefined || isMissing(type, left)
    const rightMissing = right === undefined || isMissing(type, right)
    if (leftMissing || rightMissing) return leftMissing === rightMissing ? a - b : leftMissing ? 1 : -1
    return sign * compareCells(type, left, right) || a - b
  })
}

// Keys ----------------------------------------------------------------------

export interface KeyOption {
  readonly label: string
  readonly text: string
}

export type Keyed = { readonly key: string } | { readonly problem: string }

// A statement row's key: its first option (Yes or True) when the predicate
// holds, else its second.
export const twoChoiceKey = (value: Value, options: ReadonlyArray<KeyOption>): Keyed => {
  if (value.kind !== "boolean") return { problem: "its predicate does not give yes or no" }
  const option = options[value.value ? 0 : 1]
  return option === undefined ? { problem: "it does not have two options" } : { key: option.label }
}

// An option's number as printed, such as 12.5%, $1,200 or -3, and how many
// decimal places it prints; undefined for words.
export const optionNumber = (text: string): { readonly value: number; readonly places: number } | undefined => {
  const plain = text.trim().replace(/^(?:about|approximately|roughly)\s+/i, "").replace(/\s*(?:%|percent)$/i, "")
    .replace(/^([+-]?)\s*[$€£¥₹]\s*/, "$1").replace(/,(?=\d{3}\b)/g, "")
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(plain)) return undefined
  const places = plain.includes(".") ? plain.length - plain.indexOf(".") - 1 : 0
  return { value: Number(plain), places }
}

// In an approximate blank, the value lies within this share of the gap
// between its option and each neighbouring one, so a rounding error smaller
// than that cannot change the answer.
export const ApproximateMargin = 0.25

const lettersOf = (options: ReadonlyArray<KeyOption>) => options.map((option) => option.label).join(" and ")

// A dropdown's key: the one option that fits the computed value. A number
// fits an option it rounds to, at the finest places the options print; for an
// approximate blank the nearest option counts, and it must be near enough
// that rounding cannot change the answer. Words fit the option with the same
// words.
export const dropdownKey = (value: Value, options: ReadonlyArray<KeyOption>, approximate: boolean): Keyed => {
  if (value.kind === "words") {
    const fitting = options.filter((option) => plainWords(option.text) === value.value)
    if (fitting.length === 1) return { key: fitting[0]!.label }
    return fitting.length === 0
      ? { problem: `no option is "${value.value}", the computed answer` }
      : { problem: `options ${lettersOf(fitting)} are both "${value.value}"` }
  }
  if (value.kind !== "number") return { problem: "its predicate does not give a number or words" }
  const numbers = options.map((option) => ({ option, number: optionNumber(option.text) }))
  const unreadable = numbers.filter((each) => each.number === undefined)
  if (unreadable.length > 0) return { problem: `option ${unreadable[0]!.option.label} is not a number` }
  const read = numbers.map((each) => ({ option: each.option, ...each.number! }))
  const shown = Number(value.value.toPrecision(6))
  if (!approximate) {
    // Every option at the finest places any of them prints, so 2.3 fits none
    // of 1.5, 2, 2.5 and 3 rather than the 2 it rounds to.
    const finest = Math.max(...read.map((each) => each.places))
    const fitting = read.filter((each) => Math.abs(each.value - value.value) <= 0.5 * 10 ** -finest + 1e-9)
    if (fitting.length === 1) return { key: fitting[0]!.option.label }
    return fitting.length === 0
      ? { problem: `no option fits the computed value, ${shown}` }
      : { problem: `options ${lettersOf(fitting.map((each) => each.option))} both fit the computed value, ${shown}` }
  }
  const byValue = read.toSorted((a, b) => a.value - b.value)
  const distances = byValue.map((each) => Math.abs(each.value - value.value))
  const nearest = distances.indexOf(Math.min(...distances))
  if (distances.filter((distance) => sameNumber(distance, distances[nearest]!)).length > 1) {
    return { problem: `the computed value, ${shown}, is as near to two options` }
  }
  const own = byValue[nearest]!
  for (const neighbour of [byValue[nearest - 1], byValue[nearest + 1]]) {
    if (neighbour === undefined) continue
    if (distances[nearest]! > ApproximateMargin * Math.abs(neighbour.value - own.value) + 1e-9) {
      return {
        problem: `the computed value, ${shown}, is too far from option ${own.option.label} for rounding to leave the answer alone`
      }
    }
  }
  return { key: own.option.label }
}

// What an option stands for when it is chosen in a Two-Part Analysis: the row
// it names, else its number, else its words.
export const choiceValue = (dataset: Dataset, text: string): Value => {
  const labels = rowLabels(dataset)
  const row = labels.indexOf(plainWords(text))
  if (row >= 0 && labels.lastIndexOf(plainWords(text)) === row) return { kind: "row", row }
  const number = optionNumber(text)
  return number === undefined ? { kind: "words", value: plainWords(text) } : { kind: "number", value: number.value }
}

export type Paired =
  | { readonly pairs: ReadonlyArray<readonly [number, number]> }
  | { readonly problem: string }

// Every pair of options, by place in the shared list, for which each column's
// predicate holds.
export const meetingPairs = (
  predicates: readonly [Predicate, Predicate],
  options: ReadonlyArray<KeyOption>,
  dataset: Dataset
): Paired => {
  const values = options.map((option) => choiceValue(dataset, option.text))
  const pairs: Array<readonly [number, number]> = []
  for (const [first, a] of values.entries()) {
    for (const [second, b] of values.entries()) {
      let holds = true
      for (const predicate of predicates) {
        const outcome = evaluate(predicate, dataset, { choices: [a, b] })
        if ("problem" in outcome) return { problem: outcome.problem }
        if (outcome.value.kind !== "boolean") return { problem: "a column's predicate does not give yes or no" }
        holds &&= outcome.value.value
      }
      if (holds) pairs.push([first, second])
    }
  }
  return { pairs }
}

// A Two-Part Analysis's keys: the one pair of options that meets every
// condition.
export const columnKeys = (
  predicates: readonly [Predicate, Predicate],
  options: ReadonlyArray<KeyOption>,
  dataset: Dataset
): { readonly keys: readonly [string, string] } | { readonly problem: string } => {
  const found = meetingPairs(predicates, options, dataset)
  if ("problem" in found) return found
  if (found.pairs.length !== 1) {
    return {
      problem: found.pairs.length === 0
        ? "no pair of options meets every condition"
        : `${found.pairs.length} pairs of options meet every condition`
    }
  }
  const [first, second] = found.pairs[0]!
  return { keys: [options[first]!.label, options[second]!.label] }
}

// Whether two results are the same, as the statement's two predicates must
// give: numbers equal up to rounding in the sixth significant figure.
export const sameValue = (a: Value, b: Value): boolean => {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case "number":
      return Math.abs(a.value - (b as Kinded<"number">).value) <=
        1e-6 * Math.max(1, Math.abs(a.value), Math.abs((b as Kinded<"number">).value))
    case "boolean":
      return a.value === (b as Kinded<"boolean">).value
    case "words":
      return a.value === (b as Kinded<"words">).value
    case "row":
      return a.row === (b as Kinded<"row">).row
    case "rows":
      return a.rows.length === (b as Kinded<"rows">).rows.length &&
        a.rows.every((row, index) => row === (b as Kinded<"rows">).rows[index])
  }
}

// A result as the Curator reads it.
export const describeValue = (value: Value, dataset: Dataset): string => {
  switch (value.kind) {
    case "number":
      return String(Number(value.value.toPrecision(6)))
    case "boolean":
      return value.value ? "yes" : "no"
    case "words":
      return value.value
    case "row":
      return dataset.rows[value.row]?.[0]?.text ?? `row ${value.row + 1}`
    case "rows":
      return `${value.rows.length} rows`
  }
}
