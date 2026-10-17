import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Dataset } from "../src/api/dataset.ts"
import { renderChart } from "../src/server/charts/charts.ts"

const sales: Dataset = {
  columns: [{ name: "Year", type: "date", unit: "" }, { name: "Sales", type: "currency", unit: "$ thousands" }],
  rows: [
    [{ text: "2019", value: "2019" }, { text: "$1,200", value: 1200 }],
    [{ text: "2020", value: "2020" }, { text: "$980", value: 980 }]
  ]
}

const bars = {
  $schema: "https://vega.github.io/schema/vega-lite/v6.json",
  data: { name: "dataset" },
  mark: "bar",
  encoding: { x: { field: "Year", type: "ordinal" }, y: { field: "Sales", type: "quantitative" } }
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect))

describe("Charts", () => {
  test("a Vega-Lite spec draws its Dataset as SVG on the server", async () => {
    const drawn = await run(renderChart(bars, sales))
    expect(drawn._tag).toBe("Success")
    const svg = drawn._tag === "Success" ? drawn.success : ""
    expect(svg).toStartWith("<svg")
    expect(svg).toContain("2019")
    expect(svg).not.toContain("style=")
  })

  test("a Venn diagram draws its regions with their counts", async () => {
    const regions: Dataset = {
      columns: [{ name: "In", type: "text", unit: "" }, { name: "People", type: "number", unit: "" }],
      rows: [["Car", "12"], ["Bike", "7"], ["Bike & Car", "5"], ["none", "3"]].map(([where, count]) => [
        { text: where!, value: null },
        { text: count!, value: Number(count) }
      ])
    }
    const drawn = await run(renderChart({ venn: { sets: ["Car", "Bike"], region: "In", value: "People" } }, regions))
    const svg = drawn._tag === "Success" ? drawn.success : ""
    expect(svg).toContain("Venn diagram of Car, Bike")
    for (const count of ["12", "7", "5", "3"]) expect(svg).toContain(`>${count}</text>`)
  })

  test("a spec that cannot render, or would load data from elsewhere, fails with the reason", async () => {
    const broken = await run(renderChart({ ...bars, mark: "no-such-mark" }, sales))
    expect(broken).toMatchObject({ _tag: "Failure", failure: { _tag: "ChartRenderFailed" } })
    const elsewhere = await run(renderChart({ ...bars, data: { url: "https://example.com/data.csv" } }, sales))
    expect(elsewhere).toMatchObject({ failure: { detail: "A chart takes its data from its Dataset only." } })
    const venn = await run(renderChart({ venn: { sets: ["Car", "Bike"], region: "In", value: "Missing" } }, sales))
    expect(venn).toMatchObject({ failure: { detail: "The Venn diagram names a column the data lacks." } })
  })
})
