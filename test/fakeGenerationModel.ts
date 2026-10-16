import type { Predicate } from "../src/server/generation/predicates.ts"
import type { GiOutput, MsrOutput, TaOutput, TpaOutput } from "../src/server/generation/prompts.ts"
import type { FakeOutcome, TransportRequest } from "../src/server/llm/LlmTransport.ts"
import { FakeTokens, makeFakeBookModel } from "./fakeBookModel.ts"
import {
  all,
  any,
  choice,
  compare,
  count,
  filter,
  label,
  not,
  percentChange,
  pick,
  predicate,
  row,
  sameRow,
  sort,
  sum,
  value
} from "./predicateSteps.ts"

// A stand-in for the generator and the second reading: one fixed item of
// each Data Insights Question Type, with the keys code should compute from
// it, and for each statement the predicate a second reading gives back.
// Everything else goes to the fake book model, whose solves give the keys.

export const taItem: TaOutput = {
  intro: "The table shows each region's sales, growth over the year and number of stores. For each statement, select Yes if it is true of the table; otherwise select No.",
  table: {
    columns: [
      { name: "Region", type: "text", unit: "" },
      { name: "Sales", type: "currency", unit: "$ thousands" },
      { name: "Growth", type: "percent", unit: "" },
      { name: "Stores", type: "number", unit: "" }
    ],
    rows: [
      ["North", "$420", "3.5%", "12"],
      ["South", "$380", "6%", "10"],
      ["East", "$510", "-1.5%", "15"],
      ["West", "$290", "8%", "7"],
      ["Central", "$460", "2%", "13"],
      ["Coastal", "$350", "4.5%", "9"]
    ]
  },
  pair: "yes-no",
  statements: [
    {
      text: "More than half of the regions grew by over 3%.",
      predicate: predicate(filter("grew", "Growth", ">", { number: 3 }), count("n", "grew"), compare("most", "n", ">", { number: 3 }))
    },
    {
      text: "The region with the most sales also has the most stores.",
      predicate: predicate(
        sort("bySales", "Sales", "descending"),
        pick("top", "bySales", 1),
        sort("byStores", "Stores", "descending"),
        pick("most", "byStores", 1),
        sameRow("same", "top", "most")
      )
    },
    {
      text: "Total sales of the regions that grew by more than 5% exceed $700 thousand.",
      predicate: predicate(
        filter("fast", "Growth", ">", { number: 5 }),
        sum("total", "Sales", "fast"),
        compare("over", "total", ">", { number: 700 })
      )
    }
  ]
}
export const taKeys = "A,A,B"

export const giItem: GiOutput = {
  intro: "The chart shows a museum's visitors each year. Use the drop-down menus to complete each statement so that it is accurate according to the chart.",
  table: {
    columns: [
      { name: "Year", type: "date", unit: "" },
      { name: "Visitors", type: "number", unit: "thousands" },
      { name: "Revenue", type: "currency", unit: "$ millions" }
    ],
    rows: [
      ["2016", "120", "$4.2"],
      ["2017", "135", "$4.8"],
      ["2018", "150", "$5.1"],
      ["2019", "180", "$6.0"],
      ["2020", "90", "$2.7"],
      ["2021", "140", "$4.9"]
    ]
  },
  chart: { kind: "bar", title: "Visitors by year", x: "Year", y: "Visitors", series: "" },
  blanks: [
    {
      text: "Visitors in 2019 were approximately {{blank}} percent more than in 2016.",
      options: ["25", "50", "75", "100"],
      approximate: true,
      predicate: predicate(
        row("first", "2016"),
        row("last", "2019"),
        value("a", "first", "Visitors"),
        value("b", "last", "Visitors"),
        percentChange("change", "a", "b")
      )
    },
    {
      text: "The year with the fewest visitors was {{blank}}.",
      options: ["2016", "2018", "2020", "2021"],
      approximate: false,
      predicate: predicate(sort("byVisitors", "Visitors", "ascending"), pick("fewest", "byVisitors", 1), label("year", "fewest"))
    }
  ]
}
export const giKeys = "B,C"

export const tpaItem: TpaOutput = {
  intro: "A buyer needs one supplier for an urgent order and one for a bulk order. The urgent supplier must deliver in under 4 days at a price below $13 a unit. The bulk supplier must have the lowest price among suppliers rated 3.5 or higher. Select a supplier for each order.",
  table: {
    columns: [
      { name: "Supplier", type: "text", unit: "" },
      { name: "Price", type: "currency", unit: "per unit" },
      { name: "Delivery", type: "number", unit: "days" },
      { name: "Rating", type: "number", unit: "" }
    ],
    rows: [
      ["Acme", "$12", "5", "4.1"],
      ["Birch", "$9", "8", "3.6"],
      ["Cobalt", "$11", "3", "4.5"],
      ["Delta", "$8", "10", "3.2"],
      ["Ember", "$14", "2", "4.8"],
      ["Fable", "$10", "6", "4.0"]
    ]
  },
  columns: [
    {
      heading: "Urgent order",
      predicate: predicate(
        choice("x", 1),
        value("days", "x", "Delivery"),
        compare("fast", "days", "<", { number: 4 }),
        value("price", "x", "Price"),
        compare("cheap", "price", "<", { number: 13 }),
        all("ok", "fast", "cheap")
      )
    },
    {
      heading: "Bulk order",
      predicate: predicate(
        choice("y", 2),
        filter("rated", "Rating", ">=", { number: 3.5 }),
        sort("byPrice", "Price", "ascending", "rated"),
        pick("cheapest", "byPrice", 1),
        sameRow("ok", "y", "cheapest")
      )
    }
  ],
  options: ["Acme", "Birch", "Cobalt", "Delta", "Ember", "Fable"]
}
export const tpaKeys = "C,B"

const busy = (branch: string, ...months: ReadonlyArray<string>) => [
  row("b", branch),
  ...months.flatMap((month) => [value(month.toLowerCase(), "b", month), compare(`${month.toLowerCase()}Busy`, month.toLowerCase(), ">", { number: 2000 })])
]

export const msrItem: MsrOutput = {
  tabs: [
    {
      title: "Policy",
      text: "A library branch is rated busy in a month when it lends more than 2,000 items. The council funds an extra librarian at any branch rated busy in at least two of the three months.",
      table: null
    },
    {
      title: "Loans",
      text: "Items each branch lent in the first three months of the year.",
      table: {
        columns: [
          { name: "Branch", type: "text", unit: "" },
          { name: "January", type: "number", unit: "" },
          { name: "February", type: "number", unit: "" },
          { name: "March", type: "number", unit: "" }
        ],
        rows: [
          ["Elm", "2,150", "1,980", "2,300"],
          ["Oak", "1,700", "1,850", "1,900"],
          ["Pine", "2,400", "2,050", "1,950"],
          ["Ash", "1,600", "2,100", "1,750"],
          ["Birch", "2,200", "2,250", "2,050"]
        ]
      }
    },
    {
      title: "Survey",
      text: "A survey of patrons found that most visitors to the Oak branch come for its study rooms rather than to borrow items.",
      table: null
    }
  ],
  questions: [
    {
      intro: "Consider the sources. For each statement, select Yes if it is supported by the sources; otherwise select No.",
      pair: "yes-no",
      statements: [
        {
          text: "Elm was rated busy in January.",
          tab: 2,
          predicate: predicate(...busy("Elm", "January")),
          answer: null
        },
        {
          text: "Oak was rated busy in at least one month.",
          tab: 2,
          predicate: predicate(...busy("Oak", "January", "February", "March"), any("some", "januaryBusy", "februaryBusy", "marchBusy")),
          answer: null
        },
        { text: "Most visitors to Oak do not come to borrow items.", tab: null, predicate: null, answer: "first" }
      ]
    },
    {
      intro: "For each of the following statements about the loan figures, select Yes if it is supported by the sources; otherwise select No.",
      pair: "yes-no",
      statements: [
        {
          text: "Pine lent fewer items in March than in January.",
          tab: 2,
          predicate: predicate(row("p", "Pine"), value("mar", "p", "March"), value("jan", "p", "January"), compare("fewer", "mar", "<", { step: "jan" })),
          answer: null
        },
        {
          text: "More branches lent over 2,000 items in February than in January.",
          tab: 2,
          predicate: predicate(
            filter("feb", "February", ">", { number: 2000 }),
            count("f", "feb"),
            filter("jan", "January", ">", { number: 2000 }),
            count("j", "jan"),
            compare("more", "f", ">", { step: "j" })
          ),
          answer: null
        },
        {
          text: "Birch lent the most items in March.",
          tab: 2,
          predicate: predicate(row("birch", "Birch"), sort("byMarch", "March", "descending"), pick("top", "byMarch", 1), sameRow("same", "birch", "top")),
          answer: null
        }
      ]
    },
    {
      intro: "For each of the following statements about the council's rule, select Yes if it is supported by the sources; otherwise select No.",
      pair: "yes-no",
      statements: [
        {
          text: "Ash lent more items in February than in January.",
          tab: 2,
          predicate: predicate(row("a", "Ash"), value("feb", "a", "February"), value("jan", "a", "January"), compare("more", "feb", ">", { step: "jan" })),
          answer: null
        },
        {
          text: "The council funds an extra librarian at Elm.",
          tab: 2,
          predicate: predicate(
            ...busy("Elm", "January", "February", "March"),
            all("jf", "januaryBusy", "februaryBusy"),
            all("jm", "januaryBusy", "marchBusy"),
            all("fm", "februaryBusy", "marchBusy"),
            any("funded", "jf", "jm", "fm")
          ),
          answer: null
        },
        {
          text: "Total March loans across all branches exceeded 10,000.",
          tab: 2,
          predicate: predicate(sum("total", "March"), compare("over", "total", ">", { number: 10000 })),
          answer: null
        }
      ]
    }
  ]
}
export const msrKeys = ["A,B,A", "A,B,B", "A,A,B"] as const

export const generatedItems = { "di.ta": taItem, "di.gi": giItem, "di.tpa": tpaItem, "di.msr": msrItem } as const

// Sentences that open each later item of a type, so the items read as
// different Questions, as a real generator's do; the first keeps its own
// words.
const Openers = [
  "Shown are a chain's outlets with their takings, yearly change and staff headcount.",
  "The figures cover a ferry company's harbours: fares collected, change in trips and berths in use.",
  "A wholesaler's depots are listed with orders filled, growth since last year and vans on the road.",
  "Each row is a museum branch, with ticket income, change in visits and galleries open.",
  "These numbers come from a bakery's shops: loaves sold, change in footfall and ovens running.",
  "A water utility's districts are set out with meters read, change in usage and crews assigned.",
  "The list covers a cinema group's screens with seats sold, change in showings and staff rostered."
]

// An intro as the n-th item of its type words it: its first sentence gives
// way to that item's opener.
export const introFor = (intro: string, item: number) => {
  if (item <= 1) return intro
  const opener = Openers[(item - 2) % Openers.length]!
  const rest = intro.split(/(?<=\.)\s+/).slice(1).join(" ")
  return rest === "" ? `${opener} ${intro}` : `${opener} ${rest}`
}

// The fixed item for a type, worded as the n-th item of its type.
export const itemFor = (type: keyof typeof generatedItems, item: number): unknown => {
  switch (type) {
    case "di.ta":
      return { ...taItem, intro: introFor(taItem.intro, item) }
    case "di.gi":
      return { ...giItem, intro: introFor(giItem.intro, item) }
    case "di.tpa":
      return { ...tpaItem, intro: introFor(tpaItem.intro, item) }
    case "di.msr":
      return { ...msrItem, questions: msrItem.questions.map((question) => ({ ...question, intro: introFor(question.intro, item) })) }
  }
}

// Each item's stems, however an item words them, with the keys code should
// compute for them.
export const generatedKeys: ReadonlyMap<string, string> = new Map(
  Array.from({ length: Openers.length + 1 }, (_, i) => i + 1).flatMap((item) => [
    [introFor(taItem.intro, item), taKeys] as const,
    [introFor(giItem.intro, item), giKeys] as const,
    [introFor(tpaItem.intro, item), tpaKeys] as const,
    ...msrItem.questions.map((question, index) => [introFor(question.intro, item), msrKeys[index]!] as const)
  ])
)

// Each statement's or blank's words, with its predicate, whether the blank
// is approximate, and the tab it reads.
interface Reading {
  readonly predicate: Predicate
  readonly approximate: boolean
  readonly tab: number | null
}
const predicates = new Map<string, Reading>([
  ...taItem.statements.map((each) => [each.text, { predicate: each.predicate, approximate: false, tab: null }] as const),
  ...giItem.blanks.map((each) => [each.text, { predicate: each.predicate, approximate: each.approximate, tab: null }] as const),
  ...msrItem.questions.flatMap((question) =>
    question.statements.flatMap((each) =>
      each.predicate === null ? [] : [[each.text, { predicate: each.predicate, approximate: false, tab: each.tab }] as const]
    )
  )
])

// A reading that gives the opposite answer, or another number.
const otherReading = (given: Predicate): Predicate => {
  const last = given.steps.at(-1)!
  if (last.op === "percent-change") return predicate(...given.steps, { op: "ratio", name: "other", of: last.to, to: last.from })
  if (last.op === "label") return predicate(...given.steps.slice(0, -2), pick("other", "byVisitors", 2), label("year2", "other"))
  return predicate(...given.steps, not("other", last.name))
}

export interface FakeGeneration {
  // Statements, blanks or a Two-Part Analysis's intro that a second reading
  // gets another answer for.
  readonly disagree?: ReadonlySet<string>
  // The generator's reply for an item, by type and attempt, instead of the
  // fixed one.
  readonly reply?: (type: keyof typeof generatedItems, attempt: number) => unknown
  // An independent solve's answers by stem and run; the keys when absent.
  readonly solve?: (stem: string, run: number) => string | undefined
}

const asked = (request: TransportRequest) => request.messages.find((message) => message.role === "user")?.content ?? ""

const typeOf = (system: string): keyof typeof generatedItems | undefined =>
  system.includes("Write one Table Analysis question")
    ? "di.ta"
    : system.includes("Write one Graphics Interpretation question")
    ? "di.gi"
    : system.includes("Write one Two-Part Analysis question")
    ? "di.tpa"
    : system.includes("Write one Multi-Source Reasoning set")
    ? "di.msr"
    : undefined

export const makeFakeGenerationModel = (options: FakeGeneration = {}) => {
  const enrichment = makeFakeBookModel({
    solve: (stem, run) => options.solve?.(stem, run) ?? generatedKeys.get(stem)
  })
  const written = new Map<keyof typeof generatedItems, number>()
  return (request: TransportRequest): FakeOutcome => {
    const system = request.messages[0]?.content ?? ""
    const type = typeOf(system)
    const reply = (value: unknown): FakeOutcome => ({ content: JSON.stringify(value), ...FakeTokens })
    if (type !== undefined) {
      const attempt = asked(request).includes("Your last reply broke these rules") ? 2 : 1
      // Each new item of a type, in any batch, is worded as the next one.
      if (attempt === 1) written.set(type, (written.get(type) ?? 0) + 1)
      return reply(options.reply?.(type, attempt) ?? itemFor(type, written.get(type) ?? 1))
    }
    if (system.includes("You check Two-Part Analysis questions")) {
      const columns = tpaItem.columns.map((column) => column.predicate)
      const problem = /^The problem: (.*)$/m.exec(asked(request))?.[1] ?? ""
      return reply({
        columns: options.disagree?.has(problem) === true
          ? [columns[0], predicate(choice("y", 2), row("e", "Ember"), sameRow("ok", "y", "e"))]
          : columns
      })
    }
    if (system.includes("You check Data Insights questions")) {
      const words = /^The (?:statement to judge|sentence to complete): (.*)$/m.exec(asked(request))?.[1] ?? ""
      const given = predicates.get(words)
      if (given === undefined) return reply({ predicate: predicate(count("n")), approximate: false, tab: null })
      return reply({ ...given, predicate: options.disagree?.has(words) === true ? otherReading(given.predicate) : given.predicate })
    }
    return enrichment(request)
  }
}
