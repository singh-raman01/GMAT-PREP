import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as vl from "vega-lite"
import type { ChartReading, GiItem, MsrSource, TaItem } from "../src/server/books/diReadings.ts"
import { type Candidate, candidateProblems, chartSpec, datasetOfDraft, linkSet } from "../src/server/books/linking.ts"
import type { PageReading } from "../src/server/books/readings.ts"
import { renderChart } from "../src/server/charts/charts.ts"

// Linking Data Insights items from page readings, without a database.

const grouped = (kind: "bar" | "stacked-bar"): ChartReading => ({
  kind,
  title: "Sales by region",
  data: {
    columns: [
      { name: "Region", type: "text", unit: "" },
      { name: "Year", type: "text", unit: "" },
      { name: "Sales", type: "number", unit: "" }
    ],
    rows: [["North", "2019", "40"], ["North", "2020", "60"], ["South", "2019", "30"], ["South", "2020", "20"]]
  },
  x: "Region",
  y: "Sales",
  series: "Year",
  sets: []
})

describe("Chart specs", () => {
  test("a bar chart with a series sets its bars side by side; a stacked one stacks them", () => {
    const bar = chartSpec(grouped("bar"))
    const stacked = chartSpec(grouped("stacked-bar"))
    expect(bar).toMatchObject({ encoding: { xOffset: { field: "Year" } } })
    expect(JSON.stringify(vl.compile(bar as vl.TopLevelSpec).spec)).not.toContain('"type":"stack"')
    expect(JSON.stringify(vl.compile(stacked as vl.TopLevelSpec).spec)).toContain('"type":"stack"')
  })

  test("axes carry their column's unit, and percents and amounts are labelled as such", async () => {
    const reading: ChartReading = {
      kind: "bar",
      title: "",
      data: {
        columns: [
          { name: "Year", type: "text", unit: "" },
          { name: "Revenue", type: "currency", unit: "millions" },
          { name: "Margin", type: "percent", unit: "" }
        ],
        rows: [["2019", "$120", "12.5%"], ["2020", "$150", "15%"]]
      },
      x: "Year",
      y: "Revenue",
      series: "",
      sets: []
    }
    const spec = chartSpec(reading) as { encoding: { y: { title: string } } }
    expect(spec.encoding.y.title).toBe("Revenue (millions)")
    const svg = await Effect.runPromise(renderChart(spec, datasetOfDraft(reading.data)))
    expect(svg).toContain("Revenue (millions)")
    expect(svg).toContain("$")
    const percents = await Effect.runPromise(renderChart(chartSpec({ ...reading, y: "Margin" }), datasetOfDraft(reading.data)))
    expect(percents).toContain("%")
  })
})

// A bar chart's GI question as read from a page, with the column names as
// the reading spells them.
const giWith = (columns: readonly [string, string], x: string, y: string) =>
  linkSet({
    questions: [{
      page: 3,
      reading: {
        role: "questions",
        group: "gi",
        value: {
          questions: [{
            number: 1,
            intro: "The chart shows units sold by quarter.",
            chart: {
              kind: "bar",
              title: "",
              data: {
                columns: [{ name: columns[0], type: "text", unit: "" }, { name: columns[1], type: "number", unit: "" }],
                rows: [["Q1", "120"], ["Q2", "150"], ["Q3", "90"]]
              },
              x,
              y,
              series: "",
              sets: []
            },
            figure: false,
            statements: [{ text: "The best quarter sold {{blank}} units.", options: ["90", "120", "150"] }],
            difficulty: null
          } satisfies GiItem]
        }
      } as PageReading
    }],
    answers: [{ role: "answer-key", value: { answers: [{ number: 1, parts: ["150"] }] } } as PageReading],
    explanations: [],
    labels: []
  }).find((item): item is Candidate => item._tag === "Candidate")!

describe("A chart bound to its Dataset", () => {
  test("draws from the trimmed names, and holds a chart whose axes name no column", async () => {
    const draws = async (candidate: Candidate) => {
      const stimulus = candidate.stimulus as { table: Parameters<typeof datasetOfDraft>[0]; spec: unknown }
      return Effect.runPromise(renderChart(stimulus.spec, datasetOfDraft(stimulus.table)))
    }
    const bars = (svg: string) =>
      ((/<g class="mark-rect role-mark marks"[^>]*>(.*?)<\/g>/.exec(svg)?.[1] ?? "").match(/<path/g) ?? []).length
    const padded = giWith(["Quarter ", "Units "], "Quarter ", "Units ")
    expect(bars(await draws(padded))).toBe(3)
    expect(candidateProblems(padded)).toEqual([])
    const reworded = giWith(["Quarter", "Units"], "Quarter", "Units sold")
    expect(candidateProblems(reworded)).toEqual([
      { code: "structure", detail: 'Its chart draws "Units sold", which is not a column of its data.' }
    ])
  })
})

// MSR pages: each with sources naming the questions of their set.
const msrPage = (
  sources: ReadonlyArray<{ readonly title: string; readonly text: string; readonly kind?: MsrSource["kind"] }>,
  numbers: ReadonlyArray<number>,
  word: string,
  asked = true
): PageReading => ({
  role: "questions",
  group: "msr",
  value: {
    sources: sources.map((source) => ({
      title: source.title,
      kind: source.kind ?? "text",
      text: source.text,
      table: null,
      questions: [...numbers]
    })),
    questions: (asked ? numbers : []).map((number) => ({
      number,
      stem: `Question ${number} about ${word}?`,
      options: ["A", "B", "C", "D", "E"].map((label) => ({ label: label as "A", text: `${word} ${label}` })),
      statements: [],
      pair: [],
      difficulty: null
    }))
  }
} as PageReading)

const linkedAll = (pages: ReadonlyArray<{ readonly page: number; readonly reading: PageReading }>) =>
  linkSet({
    questions: pages,
    answers: [{ role: "answer-key", value: { answers: [1, 2].map((number) => ({ number, parts: ["C"] })) } } as PageReading],
    explanations: [],
    labels: []
  })

const linked = (pages: ReadonlyArray<{ readonly page: number; readonly reading: PageReading }>) =>
  linkedAll(pages).filter((item): item is Candidate => item._tag === "Candidate")

const tabTitles = (candidate: Candidate | undefined) =>
  candidate?.stimulus?.kind === "tabs" ? candidate.stimulus.tabs.map((tab) => tab.title) : []

describe("MSR sets", () => {
  test("a set that numbers its questions as an earlier one did keeps its sources to itself", () => {
    const items = linkedAll([
      { page: 10, reading: msrPage([{ title: "Email", text: "Ships leave Friday." }, { title: "Memo", text: "Docks close." }], [1, 2], "ships") },
      { page: 14, reading: msrPage([{ title: "Report", text: "Planes land." }], [1, 2], "planes") }
    ])
    const first = items.filter((item): item is Candidate => item._tag === "Candidate")
    expect(first.map((item) => [item.page, tabTitles(item)])).toEqual([[10, ["Email", "Memo"]], [10, ["Email", "Memo"]]])
    // The later set's questions take numbers the set has used, so they are
    // skipped and counted, as any repeated number is.
    expect(items.filter((item) => item._tag === "Skip").map((item) => [item.page, item.number])).toEqual([[14, 1], [14, 2]])
  })

  test("a set whose sources run over two pages is one set, with a source read on both pages once", () => {
    const items = linked([
      { page: 14, reading: msrPage([{ title: "Report", text: "Planes land." }], [1, 2], "planes", false) },
      { page: 15, reading: msrPage([{ title: "Log", text: "Runways open." }, { title: "Report", text: "Planes land." }], [1, 2], "planes") }
    ])
    expect(items.map((item) => [item.page, tabTitles(item)])).toEqual([[15, ["Report", "Log"]], [15, ["Report", "Log"]]])
  })

  test("a set of one source or of four, or a source with no words, is held; a figure source holds it for its figure", () => {
    const one = linked([{ page: 5, reading: msrPage([{ title: "Email", text: "The plant ships on Fridays." }], [1], "orders") }])[0]!
    expect(candidateProblems(one)).toEqual([
      { code: "structure", detail: "Its set has 1 source; an MSR set has two or three." }
    ])
    const four = linked([{
      page: 5,
      reading: msrPage(["Email", "Memo", "Report", "Log"].map((title) => ({ title, text: `${title} text.` })), [1], "orders")
    }])[0]!
    expect(candidateProblems(four).map((reason) => reason.detail)).toEqual([
      "Its set has 4 sources; an MSR set has two or three."
    ])
    const empty = linked([{
      page: 5,
      reading: msrPage([{ title: "Email", text: "Orders ship that week." }, { title: "Notes", text: "" }], [1], "orders")
    }])[0]!
    expect(candidateProblems(empty).map((reason) => reason.detail)).toEqual(['Its source "Notes" has no words.'])
    const graph = linked([{
      page: 5,
      reading: msrPage([{ title: "Email", text: "Orders ship that week." }, { title: "Graph", text: "", kind: "figure" }], [1], "orders")
    }])[0]!
    expect(graph.figure).toBe(true)
    expect(candidateProblems(graph).map((reason) => reason.code)).toEqual(["figure"])
  })
})

describe("Reasons named for what they are about", () => {
  test("a source whose text does not render is named by its title", () => {
    const [item] = linked([{
      page: 5,
      reading: msrPage([{ title: "Email", text: "Orders ship within \\(1 day." }, { title: "Memo", text: "Docks close." }], [1], "orders")
    }])
    expect(candidateProblems(item!)).toEqual([
      { code: "render", detail: expect.stringMatching(/^The source "Email" does not render: /) }
    ])
  })

  test("an answer key that gives fewer answers than the Question has Parts says so", () => {
    const [item] = linkSet({
      questions: [{
        page: 2,
        reading: {
          role: "questions",
          group: "ta",
          value: {
            questions: [{
              number: 1,
              intro: "The table shows the clubs' members.",
              table: {
                columns: [{ name: "Club", type: "text", unit: "" }, { name: "Members", type: "number", unit: "" }],
                rows: [["Chess", "1,200"], ["Golf", "980"]]
              },
              pair: ["Yes", "No"],
              statements: ["Chess has more members.", "Golf has fewer than 500.", "They have 2,180 in all."],
              difficulty: null
            } satisfies TaItem]
          }
        } as PageReading
      }],
      answers: [{ role: "answer-key", value: { answers: [{ number: 1, parts: ["Yes", "No"] }] } } as PageReading],
      explanations: [],
      labels: []
    }).filter((each): each is Candidate => each._tag === "Candidate")
    expect(candidateProblems(item!)).toEqual([
      { code: "no-key", detail: "The answer key gives 2 answers for its 3 parts: Yes, No." }
    ])
  })
})
