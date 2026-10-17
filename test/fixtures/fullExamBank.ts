import { Effect } from "effect"
import { type Blueprint, DefaultBlueprint, slotsOf } from "../../src/api/blueprint.ts"
import { chartSpec } from "../../src/server/books/linking.ts"
import { datasetOf, type SeedQuestion, seedBook } from "./bank.ts"

// A Question Bank held for Mocks with `copies` times what each group of the
// blueprint asks, so Sectionals and Mocks on the real blueprint can start:
// a start needs twice a Section's count unseen. Difficulties are spread over
// the scale so the adaptive pick has a choice to make. The key of each
// single-option Question is C; TA rows are Yes then No, GI blanks the third
// option, TPA columns B and C.

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
const spec = chartSpec({ kind: "bar", title: "Units sold", data: chartData, x: "Quarter", y: "Units", series: "", sets: [] })

// From -1.5 to 1.5, in an order that mixes hard and easy.
const spread = (n: number) => Math.round((((n * 17) % 31) / 10 - 1.5) * 100) / 100

export const seedFullExamBank = (copies: number, blueprint: Blueprint = DefaultBlueprint) =>
  Effect.gen(function*() {
    let n = 0
    const next = () => ++n
    const item = (settings: Omit<SeedQuestion, "number" | "seed" | "reserve">): SeedQuestion => {
      const number = next()
      return { ...settings, number, seed: spread(number), reserve: true }
    }
    const repeat = <A>(count: number, make: (index: number) => A) => Array.from({ length: count }, (_, index) => make(index))
    const singles = (group: "ps" | "cr" | "ds" | "ta" | "gi" | "tpa") => copies * slotsOf(blueprint, group).length
    const units = (group: "rc" | "msr") => repeat(copies, () => slotsOf(blueprint, group)).flat()

    const quant = yield* seedBook("Quant Reserve", repeat(singles("ps"), () => item({ questionType: "quant.ps" })))

    const rc = { questionType: "verbal.rc-detail", primarySkill: "verbal.reading.stated-info" }
    const cr = { questionType: "verbal.cr-weaken", primarySkill: "verbal.arguments.causal" }
    const verbal = yield* seedBook("Verbal Reserve", [
      ...units("rc").flatMap((size, unit) => {
        const passage = `Passage ${unit + 1}. The council weighed ${size} proposals for the river front before the vote.`
        return repeat(size, () => item({ ...rc, passage }))
      }),
      ...repeat(singles("cr"), () => item(cr))
    ])

    const di = yield* seedBook("Data Insights Reserve", [
      ...repeat(singles("ds"), () => item({ questionType: "di.ds", primarySkill: "di.sufficiency.value" })),
      ...units("msr").flatMap((size, unit) => {
        const stimulus = {
          kind: "tabs" as const,
          share: `msr-${unit}`,
          tabs: [
            { kind: "passage" as const, title: "Email", body: `Set ${unit + 1}. The plant ships on Fridays.` },
            { kind: "table" as const, title: "Orders", dataset: table }
          ]
        }
        return repeat(size, () => item({ questionType: "di.msr", primarySkill: "di.interpretation.combine-sources", stimulus }))
      }),
      ...repeat(singles("ta"), (index) =>
        item({
          questionType: "di.ta",
          primarySkill: "di.displays.tables",
          stimulus: { kind: "table", share: `ta-${index}`, dataset: table },
          parts: ["North sold the most.", "East sold more than South."].map((prompt, row) => ({
            kind: "two-choice" as const,
            prompt,
            options: ["Yes", "No"],
            key: row === 1 ? "B" : "A"
          }))
        })),
      ...repeat(singles("gi"), (index) =>
        item({
          questionType: "di.gi",
          primarySkill: "di.displays.charts",
          stimulus: { kind: "chart", share: `gi-${index}`, dataset: chart, spec },
          parts: [{ kind: "dropdown" as const, prompt: "The best quarter sold {{blank}} units.", options: ["90", "120", "150"], key: "C" }]
        })),
      ...repeat(singles("tpa"), () =>
        item({
          questionType: "di.tpa",
          primarySkill: "di.interpretation.conclusions",
          parts: ["Width", "Height"].map((prompt, column) => ({
            kind: "column-choice" as const,
            prompt,
            options: ["2", "3", "4", "5", "6"],
            key: column === 0 ? "B" : "C"
          }))
        }))
    ])
    return { quant, verbal, di }
  })
