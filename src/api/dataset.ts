import { Schema } from "effect"

// Datasets: the tables and chart data of Data Insights Questions, with typed
// columns (ADR 0006). Each cell keeps the text the Book prints, for showing,
// and a value, for sorting and charts: a number for number, percent and
// currency columns (a percent as printed, so 12.5% is 12.5), an ISO date for
// dates (as much of one as the cell gives, such as 2019-03), and none for
// text. Shared with the web app, which sorts tables by these values.

export const ColumnTypes = ["number", "percent", "currency", "date", "text"] as const
export const ColumnType = Schema.Literals(ColumnTypes)
export type ColumnType = typeof ColumnType.Type

export const DatasetColumn = Schema.Struct({
  name: Schema.String,
  type: ColumnType,
  // A unit the cells leave out, such as "$ millions"; empty when none.
  unit: Schema.String
})
export type DatasetColumn = typeof DatasetColumn.Type

export const CellValue = Schema.Struct({
  text: Schema.String,
  value: Schema.NullOr(Schema.Union([Schema.Finite, Schema.String]))
})
export type CellValue = typeof CellValue.Type

export const Dataset = Schema.Struct({
  columns: Schema.Array(DatasetColumn),
  rows: Schema.Array(Schema.Array(CellValue))
})
export type Dataset = typeof Dataset.Type

export type Parsed = { readonly value: number | string | null } | { readonly problem: string }

const Missing = new Set(["", "-", "—", "–", "n/a", "na", "none", "not available"])

const Scales: Readonly<Record<string, number>> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 }

const tidy = (text: string) =>
  text
    .replace(/[   ]/g, " ")
    .replace(/[−–]/g, "-")
    .trim()
    .replace(/[*†‡]+$/, "")
    .trim()

// A number as a Book prints one: thousands separators, a leading sign or an
// accounting bracket for negatives, and a scale word such as million.
const parseNumber = (text: string): number | undefined => {
  let rest = text
  let sign = 1
  const bracketed = /^\((.*)\)$/.exec(rest)
  if (bracketed !== null) {
    rest = bracketed[1]!.trim()
    sign = -1
  }
  let scale = 1
  const scaled = /^(.*?)\s*(thousand|million|billion|trillion)$/i.exec(rest)
  if (scaled !== null) {
    rest = scaled[1]!
    scale = Scales[scaled[2]!.toLowerCase()]!
  }
  if (!/^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?$/.test(rest) || !/\d/.test(rest)) return undefined
  const value = Number(rest.replace(/,/g, "")) * sign * scale
  return Number.isFinite(value) ? value : undefined
}

const two = (digits: string) => digits.padStart(2, "0")

const MonthNumbers: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12
}

const monthOf = (word: string): string | undefined => {
  const number = MonthNumbers[word.toLowerCase().replace(/\.$/, "")]
  return number === undefined ? undefined : two(String(number))
}

// A date as far as the cell gives one: a year, a month of a year, a day, or a
// month alone, which sorts within a year.
const parseDate = (text: string): string | undefined => {
  let match = /^(?:FY\s?)?(\d{4})$/i.exec(text)
  if (match !== null) return match[1]
  match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(text)
  if (match !== null) return text
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text)
  if (match !== null) return `${match[3]}-${two(match[1]!)}-${two(match[2]!)}`
  match = /^Q([1-4])\s+(\d{4})$/i.exec(text) ?? /^(\d{4})\s+Q([1-4])$/i.exec(text)
  if (match !== null) {
    const [year, quarter] = match[1]!.length === 4 ? [match[1]!, match[2]!] : [match[2]!, match[1]!]
    return `${year}-${two(String((Number(quarter) - 1) * 3 + 1))}`
  }
  match = /^([A-Za-z]+\.?)\s+(\d{1,2}),?\s+(\d{4})$/.exec(text)
  if (match !== null) {
    const month = monthOf(match[1]!)
    return month === undefined ? undefined : `${match[3]}-${month}-${two(match[2]!)}`
  }
  match = /^(\d{1,2})\s+([A-Za-z]+\.?)\s+(\d{4})$/.exec(text)
  if (match !== null) {
    const month = monthOf(match[2]!)
    return month === undefined ? undefined : `${match[3]}-${month}-${two(match[1]!)}`
  }
  match = /^([A-Za-z]+\.?)\s+(\d{4})$/.exec(text)
  if (match !== null) {
    const month = monthOf(match[1]!)
    return month === undefined ? undefined : `${match[2]}-${month}`
  }
  match = /^([A-Za-z]+\.?)$/.exec(text)
  if (match !== null) {
    const month = monthOf(match[1]!)
    return month === undefined ? undefined : `0000-${month}`
  }
  return undefined
}

// The value of a cell as printed, for its column's type. A blank or a dash
// is a missing value of any type.
export const parseCell = (type: ColumnType, printed: string): Parsed => {
  const text = tidy(printed)
  if (type === "text" || Missing.has(text.toLowerCase())) return { value: null }
  switch (type) {
    case "number": {
      const value = parseNumber(text)
      return value === undefined ? { problem: `"${printed.trim()}" is not a number.` } : { value }
    }
    case "percent": {
      const value = parseNumber(text.replace(/\s*(?:%|percent)$/i, ""))
      return value === undefined ? { problem: `"${printed.trim()}" is not a percent.` } : { value }
    }
    case "currency": {
      const value = parseNumber(text.replace(/^([+-]?)\s*[$€£¥₹]\s*/, "$1").replace(/\s*[$€£¥₹]$/, ""))
      return value === undefined ? { problem: `"${printed.trim()}" is not an amount of money.` } : { value }
    }
    case "date": {
      const value = parseDate(text)
      return value === undefined ? { problem: `"${printed.trim()}" is not a date.` } : { value }
    }
  }
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" })

// Two cells of a column, in ascending order; missing values are left to the
// caller, which puts them last.
export const compareCells = (type: ColumnType, a: CellValue, b: CellValue): number => {
  if (type === "text") return collator.compare(a.text, b.text)
  if (typeof a.value === "number" && typeof b.value === "number") return a.value - b.value
  return collator.compare(String(a.value), String(b.value))
}

const isMissing = (type: ColumnType, cell: CellValue | undefined) =>
  cell === undefined || (type === "text" ? cell.text.trim() === "" : cell.value === null)

export interface SortBy {
  readonly column: number
  readonly type: ColumnType
  readonly direction: "ascending" | "descending"
}

// A table's rows sorted by one column's values, keeping the Book's order
// between equal ones, with missing values last in either direction.
export const sortRows = <Row extends ReadonlyArray<CellValue>>(rows: ReadonlyArray<Row>, by: SortBy): Array<Row> => {
  const sign = by.direction === "ascending" ? 1 : -1
  return rows
    .map((row, index) => ({ row, index }))
    .toSorted((a, b) => {
      const left = a.row[by.column]
      const right = b.row[by.column]
      const leftMissing = isMissing(by.type, left)
      const rightMissing = isMissing(by.type, right)
      if (leftMissing || rightMissing) return leftMissing === rightMissing ? a.index - b.index : leftMissing ? 1 : -1
      return sign * compareCells(by.type, left!, right!) || a.index - b.index
    })
    .map(({ row }) => row)
}
