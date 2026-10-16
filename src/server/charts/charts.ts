import { Effect, Schema } from "effect"
import * as vega from "vega"
import * as vl from "vega-lite"
import type { Dataset } from "../../api/dataset.ts"

// Charts are specs bound to typed Datasets (ADR 0006): a Vega-Lite spec whose
// data is named "dataset", or a Venn diagram, which Vega-Lite cannot draw,
// drawn here. The server renders each to SVG, both to serve it and to check
// it renders at all before the Question is published.

export class ChartRenderFailed extends Schema.TaggedError<ChartRenderFailed>()("ChartRenderFailed", {
  detail: Schema.String
}) {}

// A Venn diagram's data: each row a region, named by the sets it lies in
// joined with " & " (or "none" for outside every set), and its count.
export const VennSpec = Schema.Struct({
  venn: Schema.Struct({
    sets: Schema.Array(Schema.String).check(Schema.isMinLength(2), Schema.isMaxLength(3)),
    region: Schema.String,
    value: Schema.String
  })
})
export type VennSpec = typeof VennSpec.Type

const isVenn = Schema.is(VennSpec)

// Each row as an object by column name: a value where the cell has one, else
// the text it prints.
export const datasetValues = (dataset: Dataset) =>
  dataset.rows.map((row) =>
    Object.fromEntries(
      dataset.columns.map((column, index) => {
        const cell = row[index]
        return [column.name, cell === undefined ? null : column.type === "text" ? cell.text : cell.value]
      })
    )
  )

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

// Two or three overlapping circles, each region labelled with its count.
const vennSvg = (spec: VennSpec, dataset: Dataset): string => {
  const { sets, region, value } = spec.venn
  const regionColumn = dataset.columns.findIndex((column) => column.name === region)
  const valueColumn = dataset.columns.findIndex((column) => column.name === value)
  if (regionColumn === -1 || valueColumn === -1) throw new Error("The Venn diagram names a column the data lacks.")
  const counts = new Map<string, string>()
  for (const row of dataset.rows) {
    const key = (row[regionColumn]?.text ?? "").split("&").map((part) => part.trim()).filter((part) => part !== "")
      .toSorted().join(" & ")
    counts.set(key === "" ? "none" : key, row[valueColumn]?.text ?? "")
  }
  for (const key of counts.keys()) {
    const named = key === "none" ? [] : key.split(" & ")
    if (named.some((name) => !sets.includes(name))) throw new Error(`The region "${key}" names a set the diagram lacks.`)
  }
  const three = sets.length === 3
  const width = 420
  const height = three ? 380 : 280
  const radius = 95
  const centres = three
    ? [{ x: 160, y: 140 }, { x: 260, y: 140 }, { x: 210, y: 225 }]
    : [{ x: 165, y: 145 }, { x: 255, y: 145 }]
  const label = (members: ReadonlyArray<number>) => {
    if (members.length === 0) return { x: width - 40, y: height - 20 }
    const inside = members.map((index) => centres[index]!)
    const mean = {
      x: inside.reduce((sum, point) => sum + point.x, 0) / inside.length,
      y: inside.reduce((sum, point) => sum + point.y, 0) / inside.length
    }
    if (members.length === sets.length) return mean
    // A region of fewer sets sits away from the others' centres.
    const others = centres.filter((_, index) => !members.includes(index))
    const away = {
      x: others.reduce((sum, point) => sum + point.x, 0) / others.length,
      y: others.reduce((sum, point) => sum + point.y, 0) / others.length
    }
    const dx = mean.x - away.x
    const dy = mean.y - away.y
    const length = Math.hypot(dx, dy) || 1
    const reach = members.length === 1 ? radius * 0.55 : radius * 0.25
    return { x: mean.x + dx / length * reach, y: mean.y + dy / length * reach }
  }
  const regions = [...counts].map(([key, count]) => {
    const members = key === "none" ? [] : key.split(" & ").map((name) => sets.indexOf(name))
    const at = label(members)
    return `<text x="${at.x.toFixed(1)}" y="${at.y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="16" fill="#1f2328">${
      escape(count)
    }</text>`
  })
  const fills = ["#4c78a8", "#f58518", "#54a24b"]
  const circles = centres.map((centre, index) =>
    `<circle cx="${centre.x}" cy="${centre.y}" r="${radius}" fill="${fills[index]}" fill-opacity="0.18" stroke="${
      fills[index]
    }" stroke-width="2"/>`
  )
  const names = centres.map((centre, index) => {
    const y = three && index === 2 ? centre.y + radius + 18 : centre.y - radius - 8
    return `<text x="${centre.x}" y="${y}" text-anchor="middle" font-size="14" font-weight="bold" fill="#1f2328">${
      escape(sets[index]!)
    }</text>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${
    escape(`Venn diagram of ${sets.join(", ")}`)
  }</title><rect width="${width}" height="${height}" fill="white"/>${circles.join("")}${names.join("")}${regions.join("")}</svg>`
}

// A spec that would load data from anywhere but its Dataset.
const loadsData = (value: unknown): boolean =>
  typeof value === "object" && value !== null &&
  Object.entries(value).some(([key, inner]) => key === "url" || loadsData(inner))

// A chart as SVG, or why it cannot be drawn.
export const renderChart = (spec: unknown, dataset: Dataset): Effect.Effect<string, ChartRenderFailed> =>
  Effect.tryPromise({
    try: async () => {
      if (isVenn(spec)) return vennSvg(spec, dataset)
      if (loadsData(spec)) throw new Error("A chart takes its data from its Dataset only.")
      const compiled = vl.compile(spec as vl.TopLevelSpec).spec
      const view = new vega.View(vega.parse(compiled), { renderer: "none" })
      try {
        view.data("dataset", datasetValues(dataset))
        return await view.toSVG()
      } finally {
        view.finalize()
      }
    },
    catch: (cause) => new ChartRenderFailed({ detail: cause instanceof Error ? cause.message : String(cause) })
  })
