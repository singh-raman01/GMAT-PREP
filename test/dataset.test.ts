import { describe, expect, test } from "bun:test"
import { type CellValue, compareCells, parseCell, sortRows } from "../src/api/dataset.ts"

const value = (type: Parameters<typeof parseCell>[0], text: string) => {
  const parsed = parseCell(type, text)
  return "value" in parsed ? parsed.value : parsed
}

describe("Dataset cells", () => {
  test("numbers read as printed, with thousands separators, signs and scale words", () => {
    expect(value("number", "1,200")).toBe(1200)
    expect(value("number", "980")).toBe(980)
    expect(value("number", "−3.5")).toBe(-3.5)
    expect(value("number", "(1,200)")).toBe(-1200)
    expect(value("number", "2.5 million")).toBe(2_500_000)
    expect(value("number", "12*")).toBe(12)
    expect(value("number", "about twelve")).toEqual({ problem: "\"about twelve\" is not a number." })
  })

  test("percents, currency and dates keep a value to sort by", () => {
    expect(value("percent", "12.5%")).toBe(12.5)
    expect(value("percent", "-3")).toBe(-3)
    expect(value("currency", "$1,200.50")).toBe(1200.5)
    expect(value("currency", "€3")).toBe(3)
    expect(value("date", "2019")).toBe("2019")
    expect(value("date", "Jan 2019")).toBe("2019-01")
    expect(value("date", "March 15, 2019")).toBe("2019-03-15")
    expect(value("date", "3/15/2019")).toBe("2019-03-15")
    expect(value("date", "2019-03-15")).toBe("2019-03-15")
    expect(value("date", "Q3 2019")).toBe("2019-07")
    expect(value("date", "Sept")).toBe("0000-09")
    expect(value("date", "the third week")).toEqual({ problem: "\"the third week\" is not a date." })
  })

  test("a blank or a dash is a missing value of any type, and text has none", () => {
    expect(value("number", "")).toBeNull()
    expect(value("currency", "—")).toBeNull()
    expect(value("percent", "n/a")).toBeNull()
    expect(value("text", "Region 4")).toBeNull()
  })

  test("a table sorts by value, so 1,200 comes after 980, with missing values last either way", () => {
    const rows: ReadonlyArray<ReadonlyArray<CellValue>> = [
      [{ text: "North", value: null }, { text: "1,200", value: 1200 }],
      [{ text: "south", value: null }, { text: "980", value: 980 }],
      [{ text: "East", value: null }, { text: "—", value: null }],
      [{ text: "Region 10", value: null }, { text: "15", value: 15 }],
      [{ text: "Region 9", value: null }, { text: "-2", value: -2 }]
    ]
    const names = (sorted: ReadonlyArray<ReadonlyArray<CellValue>>) => sorted.map((row) => row[0]!.text)
    expect(names(sortRows(rows, { column: 1, type: "number", direction: "ascending" })))
      .toEqual(["Region 9", "Region 10", "south", "North", "East"])
    expect(names(sortRows(rows, { column: 1, type: "number", direction: "descending" })))
      .toEqual(["North", "south", "Region 10", "Region 9", "East"])
    // Text sorts as people read it: case aside, and numbers within it by value.
    expect(names(sortRows(rows, { column: 0, type: "text", direction: "ascending" })))
      .toEqual(["East", "North", "Region 9", "Region 10", "south"])
    expect(compareCells("date", { text: "Jan 2019", value: "2019-01" }, { text: "2018", value: "2018" })).toBeGreaterThan(0)
  })
})
