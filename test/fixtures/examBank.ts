import { Effect } from "effect"
import { type Blueprint, DefaultBlueprint } from "../../src/api/blueprint.ts"
import { chartSpec } from "../../src/server/books/linking.ts"
import { datasetOf, numbered, seedBook } from "./bank.ts"

// A Question Bank with every group of every Section held for Mocks, twice
// what SmallBlueprint asks, so a Mock can start. Every Question is Medium.

export const SmallBlueprint: Blueprint = { ...DefaultBlueprint, ps: 2, rc: [3], cr: 1, ds: 1, msr: [3], ta: 1, gi: 1, tpa: 1 }

const table = datasetOf(
  [{ name: "Region", type: "text", unit: "" }, { name: "Sales", type: "number", unit: "" }],
  [["North", "120"], ["South", "95"], ["East", "60"]],
  (column, text) => (column === 0 ? null : Number(text))
)
const chartData = {
  columns: [{ name: "Quarter", type: "text" as const, unit: "" }, { name: "Units", type: "number" as const, unit: "" }],
  rows: [["Q1", "120"], ["Q2", "150"], ["Q3", "90"]]
}
const chart = datasetOf(chartData.columns, chartData.rows, (column, text) => (column === 0 ? null : Number(text)))

// The key of each single-option Question is C; of the others, as given.
export const seedExamBank = (books: { readonly quant?: string; readonly verbal?: string; readonly di?: string } = {}) =>
  Effect.gen(function*() {
    const quant = yield* seedBook(books.quant ?? "Quant Review", numbered(4, { reserve: true, seed: 0 }))
    const rc = { questionType: "verbal.rc-detail", primarySkill: "verbal.reading.stated-info", reserve: true, seed: 0 }
    const cr = { questionType: "verbal.cr-weaken", primarySkill: "verbal.arguments.causal", reserve: true, seed: 0 }
    const verbal = yield* seedBook(books.verbal ?? "Verbal Review", [
      ...numbered(3, { ...rc, passage: "The first passage." }, 1),
      ...numbered(3, { ...rc, passage: "The second passage." }, 4),
      ...numbered(2, cr, 7)
    ])
    const msr = (set: number) => ({
      kind: "tabs" as const,
      share: `msr-${set}`,
      tabs: [
        { kind: "passage" as const, title: "Email", body: `Set ${set}. The plant ships on Fridays.` },
        { kind: "table" as const, title: "Orders", dataset: table }
      ]
    })
    const di = yield* seedBook(books.di ?? "Data Insights Review", [
      ...numbered(2, { questionType: "di.ds", primarySkill: "di.sufficiency.value", reserve: true, seed: 0 }, 1),
      ...[1, 2].flatMap((set) =>
        [0, 1, 2].map((q) => ({
          number: 2 + (set - 1) * 3 + q + 1,
          questionType: "di.msr",
          primarySkill: "di.interpretation.combine-sources",
          reserve: true,
          seed: 0,
          stimulus: msr(set)
        }))
      ),
      ...[1, 2].map((n) => ({
        number: 8 + n,
        questionType: "di.ta",
        primarySkill: "di.displays.tables",
        reserve: true,
        seed: 0,
        stimulus: { kind: "table" as const, share: `ta-${n}`, dataset: table },
        parts: ["North sold the most.", "East sold more than South."].map((prompt, i) => ({
          kind: "two-choice" as const,
          prompt,
          options: ["Yes", "No"],
          key: i === 1 ? "B" : "A"
        }))
      })),
      ...[1, 2].map((n) => ({
        number: 10 + n,
        questionType: "di.gi",
        primarySkill: "di.displays.charts",
        reserve: true,
        seed: 0,
        stimulus: {
          kind: "chart" as const,
          share: `gi-${n}`,
          dataset: chart,
          spec: chartSpec({ kind: "bar", title: "Units sold", data: chartData, x: "Quarter", y: "Units", series: "", sets: [] })
        },
        parts: [{ kind: "dropdown" as const, prompt: "The best quarter sold {{blank}} units.", options: ["90", "120", "150"], key: "C" }]
      })),
      ...[1, 2].map((n) => ({
        number: 12 + n,
        questionType: "di.tpa",
        primarySkill: "di.interpretation.conclusions",
        reserve: true,
        seed: 0,
        parts: ["Width", "Height"].map((prompt, i) => ({
          kind: "column-choice" as const,
          prompt,
          options: ["2", "3", "4", "5", "6"],
          key: i === 0 ? "B" : "C"
        }))
      }))
    ])
    return { quant, verbal, di }
  })
