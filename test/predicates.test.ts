import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import type { Dataset } from "../src/api/dataset.ts"
import { datasetOfDraft } from "../src/server/books/linking.ts"
import {
  buildGi,
  buildMsr,
  buildTa,
  buildTpa,
  disagreements,
  type DraftItem,
  type SecondReading
} from "../src/server/generation/items.ts"
import type { TaOutput, TpaOutput } from "../src/server/generation/prompts.ts"
import { giItem, msrItem, taItem, tpaItem } from "./fakeGenerationModel.ts"
import {
  columnKeys,
  dropdownKey,
  evaluate,
  type KeyOption,
  optionNumber,
  type Predicate,
  sameValue,
  twoChoiceKey,
  type Value
} from "../src/server/generation/predicates.ts"
import {
  all,
  average,
  choice,
  compare,
  count,
  difference,
  filter,
  label,
  not,
  percentChange,
  pick,
  predicate,
  rank,
  ratio,
  relation,
  row,
  sameRow,
  sort,
  sum,
  value
} from "./predicateSteps.ts"

const stores = datasetOfDraft({
  columns: [
    { name: "Department", type: "text", unit: "" },
    { name: "Revenue", type: "currency", unit: "$ millions" },
    { name: "Growth", type: "percent", unit: "" },
    { name: "Region", type: "text", unit: "" },
    { name: "Founded", type: "date", unit: "" },
    { name: "Staff", type: "number", unit: "" }
  ],
  rows: [
    ["Apparel", "$120", "4.5%", "West", "1998", "340"],
    ["Books", "$80", "-2%", "East", "2005", "120"],
    ["Garden", "$95", "7%", "West", "2011", "210"],
    ["Toys", "$60", "12.5%", "North", "2015", "90"],
    ["Grocery", "$150", "3%", "East", "1990", "510"]
  ]
})

const result = (given: Predicate, dataset: Dataset = stores, choices?: ReadonlyArray<Value>) => {
  const outcome = evaluate(given, dataset, choices === undefined ? {} : { choices })
  if ("problem" in outcome) throw new Error(outcome.problem)
  return outcome.value
}

const problemOf = (given: Predicate) => {
  const outcome = evaluate(given, stores)
  return "problem" in outcome ? outcome.problem : undefined
}

const yesNo: ReadonlyArray<KeyOption> = [{ label: "A", text: "Yes" }, { label: "B", text: "No" }]
const lettered = (...texts: ReadonlyArray<string>): ReadonlyArray<KeyOption> =>
  texts.map((text, index) => ({ label: "ABCDEFGH"[index]!, text }))

describe("The DI evaluator", () => {
  test("filters by numbers, words and dates, and counts", () => {
    expect(result(predicate(filter("west", "Region", "=", { text: "west" }), count("n", "west"))))
      .toEqual({ kind: "number", value: 2 })
    expect(result(predicate(filter("growing", "Growth", ">", { number: 4 }), count("n", "growing"))))
      .toEqual({ kind: "number", value: 3 })
    expect(result(predicate(filter("recent", "Founded", ">=", { text: "2005" }), count("n", "recent"))))
      .toEqual({ kind: "number", value: 3 })
    // Filters chain: western departments that grew more than 5%.
    expect(result(predicate(
      filter("west", "Region", "=", { text: "West" }),
      filter("fast", "Growth", ">", { number: 5 }, "west"),
      count("n", "fast")
    ))).toEqual({ kind: "number", value: 1 })
  })

  test("sums, averages, ranks and sorts", () => {
    expect(result(predicate(sum("total", "Revenue")))).toEqual({ kind: "number", value: 505 })
    expect(result(predicate(filter("east", "Region", "=", { text: "East" }), average("mean", "Staff", "east"))))
      .toEqual({ kind: "number", value: 315 })
    expect(result(predicate(row("toys", "Toys"), rank("place", "toys", "Growth", "descending"))))
      .toEqual({ kind: "number", value: 1 })
    expect(result(predicate(row("toys", "Toys"), rank("place", "toys", "Revenue", "descending"))))
      .toEqual({ kind: "number", value: 5 })
    expect(result(predicate(sort("byStaff", "Staff", "ascending"), pick("second", "byStaff", 2), label("name", "second"))))
      .toEqual({ kind: "words", value: "books" })
  })

  test("ratios, percent changes, differences and comparisons", () => {
    const books = row("books", "Books")
    const grocery = row("grocery", "Grocery")
    expect(result(predicate(books, grocery, value("a", "books", "Revenue"), value("b", "grocery", "Revenue"), ratio("r", "b", "a"))))
      .toEqual({ kind: "number", value: 1.875 })
    expect(result(predicate(
      books,
      grocery,
      value("a", "books", "Revenue"),
      value("b", "grocery", "Revenue"),
      percentChange("change", "a", "b")
    ))).toEqual({ kind: "number", value: 87.5 })
    expect(result(predicate(
      books,
      grocery,
      value("a", "books", "Staff"),
      value("b", "grocery", "Staff"),
      difference("d", "b", "a"),
      compare("more", "d", ">", { number: 389 })
    ))).toEqual({ kind: "boolean", value: true })
    expect(result(predicate(books, value("where", "books", "Region"), compare("east", "where", "=", { text: "East" }))))
      .toEqual({ kind: "boolean", value: true })
    expect(result(predicate(books, grocery, value("a", "books", "Staff"), value("b", "grocery", "Staff"), relation("r", "a", "b"))))
      .toEqual({ kind: "words", value: "less than" })
  })

  test("joins yes-or-no steps and compares rows", () => {
    // The department with the most revenue also has the most staff.
    expect(result(predicate(
      sort("byRevenue", "Revenue", "descending"),
      pick("top", "byRevenue", 1),
      sort("byStaff", "Staff", "descending"),
      pick("most", "byStaff", 1),
      sameRow("same", "top", "most")
    ))).toEqual({ kind: "boolean", value: true })
    expect(result(predicate(
      count("n"),
      compare("five", "n", "=", { number: 5 }),
      not("notFive", "five"),
      all("both", "five", "notFive")
    ))).toEqual({ kind: "boolean", value: false })
  })

  test("gives a problem for a step it cannot evaluate", () => {
    expect(problemOf(predicate(sum("total", "Profit")))).toBe("Step total: the Dataset has no column Profit")
    expect(problemOf(predicate(sum("total", "Region")))).toBe("Step total: Region is not a column of numbers")
    expect(problemOf(predicate(row("pets", "Pets")))).toBe("Step pets: no row is labelled Pets")
    expect(problemOf(predicate(count("n", "missing")))).toBe("Step n: it refers to missing, which no earlier step names")
    expect(problemOf(predicate(filter("w", "Region", ">", { text: "West" })))).toBe("Step w: words compare only with = or !=")
    expect(problemOf(predicate(count("n"), count("n")))).toBe("Two steps are named n.")
    expect(problemOf(predicate())).toBe("The predicate has no steps.")
  })
})

describe("Generated keys", () => {
  test("a statement row is Yes when its predicate holds", () => {
    expect(twoChoiceKey({ kind: "boolean", value: true }, yesNo)).toEqual({ key: "A" })
    expect(twoChoiceKey({ kind: "boolean", value: false }, yesNo)).toEqual({ key: "B" })
    expect(twoChoiceKey({ kind: "number", value: 1 }, yesNo)).toEqual({ problem: "its predicate does not give yes or no" })
  })

  test("a dropdown takes the one option the value rounds to", () => {
    expect(dropdownKey({ kind: "number", value: 87.5 }, lettered("75%", "80%", "87.5%", "90%"), false)).toEqual({ key: "C" })
    // Rounded to the option's printed places.
    expect(dropdownKey({ kind: "number", value: 20.4 }, lettered("10", "15", "20", "25"), false)).toEqual({ key: "C" })
    expect(dropdownKey({ kind: "number", value: 21 }, lettered("10", "15", "20", "25"), false))
      .toEqual({ problem: "no option fits the computed value, 21" })
    expect(dropdownKey({ kind: "number", value: 12.5 }, lettered("12", "13", "14"), false))
      .toEqual({ problem: "options A and B both fit the computed value, 12.5" })
    expect(dropdownKey({ kind: "words", value: "west" }, lettered("East", "West", "North"), false)).toEqual({ key: "B" })
    expect(dropdownKey({ kind: "words", value: "south" }, lettered("East", "West"), false))
      .toEqual({ problem: `no option is "south", the computed answer` })
    expect(dropdownKey({ kind: "number", value: 3 }, lettered("three", "four"), false))
      .toEqual({ problem: "option A is not a number" })
  })

  test("an approximate dropdown takes the nearest option, far enough from the others", () => {
    expect(dropdownKey({ kind: "number", value: 21.3 }, lettered("10%", "20%", "30%", "40%"), true)).toEqual({ key: "B" })
    expect(dropdownKey({ kind: "number", value: 23.7 }, lettered("10%", "20%", "30%", "40%"), true)).toEqual({
      problem: "the computed value, 23.7, is too far from option B for rounding to leave the answer alone"
    })
    expect(dropdownKey({ kind: "number", value: 25 }, lettered("10%", "20%", "30%", "40%"), true))
      .toEqual({ problem: "the computed value, 25, is as near to two options" })
    // The options' order does not matter.
    expect(dropdownKey({ kind: "number", value: 39 }, lettered("40", "10", "30", "20"), true)).toEqual({ key: "A" })
  })

  test("options print numbers as books do", () => {
    expect(optionNumber("$1,200")).toEqual({ value: 1200, places: 0 })
    expect(optionNumber("12.5%")).toEqual({ value: 12.5, places: 1 })
    expect(optionNumber("approximately 0.25")).toEqual({ value: 0.25, places: 2 })
    expect(optionNumber("-3")).toEqual({ value: -3, places: 0 })
    expect(optionNumber("West")).toBeUndefined()
  })

  test("a Two-Part Analysis has exactly one pair that meets every condition", () => {
    // Column 1: a western department with revenue over $100 million; column
    // 2: a department founded after it, with fewer staff, growing over 10%.
    const options = lettered("Apparel", "Books", "Garden", "Toys", "Grocery")
    const first = predicate(
      choice("x", 1),
      value("where", "x", "Region"),
      compare("west", "where", "=", { text: "West" }),
      value("revenue", "x", "Revenue"),
      compare("large", "revenue", ">", { number: 100 }),
      all("ok", "west", "large")
    )
    const second = predicate(
      choice("x", 1),
      choice("y", 2),
      value("fx", "x", "Founded"),
      value("fy", "y", "Founded"),
      compare("later", "fy", ">", { step: "fx" }),
      value("sx", "x", "Staff"),
      value("sy", "y", "Staff"),
      compare("fewer", "sy", "<", { step: "sx" }),
      value("gy", "y", "Growth"),
      compare("fast", "gy", ">", { number: 10 }),
      all("ok", "later", "fewer", "fast")
    )
    expect(columnKeys([first, second], options, stores)).toEqual({ keys: ["A", "D"] })
    // With only the founding condition, Apparel pairs with Books, Garden and Toys.
    const loose = predicate(
      choice("x", 1),
      choice("y", 2),
      value("fx", "x", "Founded"),
      value("fy", "y", "Founded"),
      compare("later", "fy", ">", { step: "fx" })
    )
    expect(columnKeys([first, loose], options, stores)).toEqual({ problem: "3 pairs of options meet every condition" })
    expect(columnKeys([first, predicate(count("n"), compare("none", "n", "<", { number: 0 }))], options, stores))
      .toEqual({ problem: "no pair of options meets every condition" })
  })

  test("two results are the same up to rounding", () => {
    expect(sameValue({ kind: "number", value: 87.5 }, { kind: "number", value: 87.50000001 })).toBe(true)
    expect(sameValue({ kind: "number", value: 87.5 }, { kind: "number", value: 87.6 })).toBe(false)
    expect(sameValue({ kind: "boolean", value: true }, { kind: "number", value: 1 })).toBe(false)
  })
})

// A random table: a label column and three columns of whole numbers, some
// cells missing.
const datasets = fc.integer({ min: 2, max: 9 }).chain((size) =>
  fc.array(
    fc.tuple(
      fc.option(fc.integer({ min: -50, max: 200 }), { freq: 8 }),
      fc.option(fc.integer({ min: 0, max: 500 }), { freq: 8 }),
      fc.integer({ min: 1, max: 40 })
    ),
    { minLength: size, maxLength: size }
  ).map((cells) =>
    datasetOfDraft({
      columns: [
        { name: "Name", type: "text", unit: "" },
        { name: "Change", type: "number", unit: "" },
        { name: "Sales", type: "currency", unit: "" },
        { name: "Stores", type: "number", unit: "" }
      ],
      rows: cells.map(([change, sales, stores], index) => [
        `Item ${index + 1}`,
        change === null ? "" : String(change),
        sales === null ? "-" : `$${sales}`,
        String(stores)
      ])
    })
  )
)

const comparisons = fc.constantFrom("<", "<=", ">", ">=", "=", "!=") as fc.Arbitrary<"<" | "<=" | ">" | ">=" | "=" | "!=">
const holds = (a: number, comparison: string, b: number) =>
  comparison === "<" ? a < b : comparison === "<=" ? a <= b : comparison === ">" ? a > b : comparison === ">="
    ? a >= b
    : comparison === "=" ? a === b : a !== b

// Each cell's number, read straight from its text.
const numbersIn = (dataset: Dataset, column: number) =>
  dataset.rows.map((cells) => {
    const text = cells[column]!.text.replace("$", "")
    return text === "" || text === "-" ? undefined : Number(text)
  })

describe("Computed keys match a brute-force reading of the Dataset", () => {
  test("for counts of rows that meet a condition", () => {
    fc.assert(fc.property(
      datasets,
      fc.constantFrom(1, 2),
      comparisons,
      fc.integer({ min: -60, max: 520 }),
      comparisons,
      fc.integer({ min: 0, max: 9 }),
      (dataset, column, inner, threshold, outer, target) => {
        const name = column === 1 ? "Change" : "Sales"
        const given = predicate(
          filter("rows", name, inner, { number: threshold }),
          count("n", "rows"),
          compare("claim", "n", outer, { number: target })
        )
        const expected = holds(
          numbersIn(dataset, column).filter((each) => each !== undefined && holds(each, inner, threshold)).length,
          outer,
          target
        )
        expect(twoChoiceKey(result(given, dataset), yesNo)).toEqual({ key: expected ? "A" : "B" })
      }
    ))
  })

  test("for sums and averages of the rows that meet a condition", () => {
    fc.assert(fc.property(datasets, comparisons, fc.integer({ min: 0, max: 40 }), (dataset, comparison, stores) => {
      const given = (step: typeof sum) => predicate(filter("rows", "Stores", comparison, { number: stores }), step("total", "Sales", "rows"))
      const kept = dataset.rows.map((_, index) => index).filter((index) => holds(numbersIn(dataset, 3)[index]!, comparison, stores))
      const sales = kept.flatMap((index) => {
        const each = numbersIn(dataset, 2)[index]
        return each === undefined ? [] : [each]
      })
      const total = sales.reduce((a, b) => a + b, 0)
      expect(result(given(sum), dataset)).toEqual({ kind: "number", value: total })
      const outcome = evaluate(given(average), dataset)
      if (sales.length === 0) expect("problem" in outcome).toBe(true)
      else expect(sameValue((outcome as { value: Value }).value, { kind: "number", value: total / sales.length })).toBe(true)
    }))
  })

  test("for ranks, and for which row comes first", () => {
    fc.assert(fc.property(datasets, fc.nat(), fc.constantFrom("ascending", "descending") as fc.Arbitrary<"ascending" | "descending">, (dataset, pickRow, order) => {
      const stores = numbersIn(dataset, 3) as ReadonlyArray<number>
      const index = pickRow % dataset.rows.length
      const better = stores.filter((each) => (order === "descending" ? each > stores[index]! : each < stores[index]!)).length
      expect(result(predicate(row("r", `Item ${index + 1}`), rank("place", "r", "Stores", order)), dataset))
        .toEqual({ kind: "number", value: better + 1 })
      // The first row of the sort is the row with the best value, and a tie
      // for the best has no first row.
      const best = order === "descending" ? Math.max(...stores) : Math.min(...stores)
      const first = stores.indexOf(best)
      const top = evaluate(predicate(sort("s", "Stores", order), pick("top", "s", 1), label("name", "top")), dataset)
      if (stores.filter((each) => each === best).length > 1) expect("problem" in top).toBe(true)
      else expect(top).toEqual({ value: { kind: "words", value: `item ${first + 1}` } })
    }))
  })

  test("for a dropdown's percent change between two rows", () => {
    fc.assert(fc.property(datasets, fc.nat(), fc.nat(), (dataset, a, b) => {
      const stores = numbersIn(dataset, 3) as ReadonlyArray<number>
      const [from, to] = [a % stores.length, b % stores.length]
      const change = (stores[to]! - stores[from]!) / stores[from]! * 100
      // Options a fixed gap apart, one of them the nearest to the change.
      const nearest = Math.round(change / 50) * 50
      const options = lettered(...[-100, -50, 0, 50, 100].map((offset) => String(nearest + offset)))
      const given = predicate(
        row("from", `Item ${from + 1}`),
        row("to", `Item ${to + 1}`),
        value("x", "from", "Stores"),
        value("y", "to", "Stores"),
        percentChange("change", "x", "y")
      )
      const key = dropdownKey(result(given, dataset), options, true)
      if (Math.abs(change - nearest) <= 12.5) expect(key).toEqual({ key: "C" })
      else expect("problem" in key).toBe(true)
    }))
  })
})

describe("Keys that the data leaves in doubt", () => {
  test("a tie for a place in a sort has no row there, so a statement about it is sent back to the generator", () => {
    const tied: TaOutput = {
      ...taItem,
      table: {
        ...taItem.table,
        rows: [
          ["North", "$510", "3.5%", "12"],
          ["South", "$380", "6%", "10"],
          ["East", "$510", "-1.5%", "15"],
          ["West", "$290", "8%", "7"],
          ["Central", "$460", "2%", "13"],
          ["Coastal", "$350", "4.5%", "9"]
        ]
      }
    }
    const built = buildTa(tied)
    expect("problems" in built && built.problems).toEqual([
      "Statement 2's predicate cannot be evaluated: Step top: rows tie on Sales at place 1, so no one row is there."
    ])
    // A tie further down the sort leaves the top alone.
    const lower = pick("second", "bySales", 2)
    const second = evaluate(predicate(sort("bySales", "Sales", "descending"), lower, label("name", "second")), datasetOfDraft({
      columns: taItem.table.columns,
      rows: [["North", "$510", "3.5%", "12"], ["South", "$380", "6%", "10"], ["East", "$380", "-1.5%", "15"]]
    }))
    expect("problem" in second).toBe(true)
    expect(evaluate(predicate(sort("bySales", "Sales", "descending"), pick("top", "bySales", 1), label("name", "top")), datasetOfDraft({
      columns: taItem.table.columns,
      rows: [["North", "$510", "3.5%", "12"], ["South", "$380", "6%", "10"], ["East", "$380", "-1.5%", "15"]]
    }))).toEqual({ value: { kind: "words", value: "north" } })
  })

  test("a Two-Part Analysis with two rows tied for a column's pick is sent back, not keyed by the table's order", () => {
    const tied: TpaOutput = {
      ...tpaItem,
      table: {
        ...tpaItem.table,
        rows: tpaItem.table.rows.map((cells) => (cells[0] === "Fable" ? ["Fable", "$9", "6", "4.0"] : cells))
      }
    }
    const built = buildTpa(tied)
    expect("problems" in built).toBe(true)
  })

  test("an exact blank compares every option at the finest places any of them prints", () => {
    const options = ["1.5", "2", "2.5", "3"].map((text, index) => ({ label: "ABCD"[index]!, text }))
    expect(dropdownKey({ kind: "number", value: 2.3 }, options, false)).toEqual({
      problem: "no option fits the computed value, 2.3"
    })
    expect(dropdownKey({ kind: "number", value: 2.04 }, options, false)).toEqual({ key: "B" })
    expect(dropdownKey({ kind: "number", value: 2.5 }, options, false)).toEqual({ key: "C" })
  })

  test("a date filter compares dates at the coarser of the two, and refuses words that are no date", () => {
    const months = datasetOfDraft({
      columns: [{ name: "Month", type: "date", unit: "" }, { name: "Sales", type: "number", unit: "" }],
      rows: [["Nov 2019", "10"], ["Dec 2019", "12"], ["Jan 2020", "14"], ["Feb 2020", "9"]]
    })
    const counted = (comparison: "<" | ">" | "=" | ">=", given: { readonly number: number } | { readonly text: string }) =>
      evaluate(predicate(filter("kept", "Month", comparison, given), count("n", "kept")), months)
    expect(counted(">", { text: "2019" })).toEqual({ value: { kind: "number", value: 2 } })
    expect(counted(">", { number: 2019 })).toEqual({ value: { kind: "number", value: 2 } })
    expect(counted("=", { text: "2019" })).toEqual({ value: { kind: "number", value: 2 } })
    expect(counted(">", { text: "Dec 2019" })).toEqual({ value: { kind: "number", value: 2 } })
    expect(counted(">=", { text: "2019-12" })).toEqual({ value: { kind: "number", value: 3 } })
    expect(counted("<", { text: "Q1 2020" })).toEqual({ value: { kind: "number", value: 2 } })
    expect(counted(">", { text: "last winter" })).toMatchObject({ problem: expect.stringContaining("needs a date") })
  })

  test("a missing cell passes no filter, != included", () => {
    const table = datasetOfDraft({
      columns: [{ name: "Store", type: "text", unit: "" }, { name: "Region", type: "text", unit: "" }],
      rows: [["A", "West"], ["B", ""], ["C", "East"]]
    })
    expect(evaluate(predicate(filter("rows", "Region", "!=", { text: "West" }), count("n", "rows")), table))
      .toEqual({ value: { kind: "number", value: 1 } })
  })
})

describe("The second reading's own choices", () => {
  const readingsOf = (item: DraftItem, change: (reading: SecondReading, part: number) => SecondReading = (reading) => reading) =>
    item.questions.map((question) =>
      question.parts.map((part, index) =>
        part.statement.kind === "computed"
          ? change({
            predicate: part.statement.predicate,
            approximate: part.statement.approximate,
            dataset: item.datasets.length > 1 ? part.statement.dataset : null
          }, index)
          : null
      )
    )
  const built = (result: ReturnType<typeof buildGi>) => {
    if ("problems" in result) throw new Error(result.problems.join(" "))
    return result.item
  }

  test("a blank the generator calls approximate and the second reading calls exact is held", () => {
    const item = built(buildGi(giItem))
    const approximate = giItem.blanks.findIndex((blank) => blank.approximate)
    expect(approximate).toBeGreaterThanOrEqual(0)
    const readings = readingsOf(item, (reading, part) => (part === approximate ? { ...reading, approximate: false } : reading))
    expect(disagreements(item.questions[0]!, item.datasets, readings[0]!)).toEqual([{
      code: "predicate-disagreement",
      detail: `Blank ${approximate + 1}: it is keyed as an approximate value, but a second reading of its words asks for an exact value.`
    }])
    expect(disagreements(item.questions[0]!, item.datasets, readingsOf(item)[0]!)).toEqual([])
  })

  test("an MSR statement whose second reading chooses another tab is held", () => {
    const item = built(buildMsr(msrItem))
    const readings = readingsOf(item, (reading, part) => (part === 0 ? { ...reading, dataset: 0 } : reading))
    expect(disagreements(item.questions[0]!, item.datasets, readings[0]!, ["Policy", "Loans", "Survey"])).toEqual([{
      code: "predicate-disagreement",
      detail: "Statement 1: its predicate reads the tab Loans, but a second reading of its words reads the tab Policy."
    }])
    expect(disagreements(item.questions[0]!, item.datasets, readingsOf(item)[0]!, ["Policy", "Loans", "Survey"])).toEqual([])
  })
})
