import { Schema } from "effect"
import { Dataset } from "./dataset.ts"

// A Stimulus as screens show it: a passage, a table, a chart, a figure kept
// as a page image, or the tabs of a Multi-Source Reasoning set.

export const StimulusKind = Schema.Literals(["passage", "table", "chart", "figure", "tabs"])
export type StimulusKind = typeof StimulusKind.Type

const ContentFields = {
  // Markdown with LaTeX; see richText.ts. A passage, or the words printed
  // with a table, chart or figure.
  body: Schema.String,
  // A table's rows, or the data a chart draws, which screens also offer as a
  // table for anyone who cannot see the chart.
  dataset: Schema.NullOr(Dataset),
  // Where the app serves a chart (SVG) or a figure (PNG).
  image: Schema.NullOr(Schema.String)
}

export class StimulusTab extends Schema.Class<StimulusTab>("gmat-prep/api/StimulusTab")({
  title: Schema.String,
  kind: Schema.Literals(["passage", "table", "chart", "figure"]),
  ...ContentFields
}) {}

export class StimulusView extends Schema.Class<StimulusView>("gmat-prep/api/StimulusView")({
  kind: StimulusKind,
  ...ContentFields,
  // For tabs, each tab in order; empty otherwise.
  tabs: Schema.Array(StimulusTab)
}) {}

// The path the app serves a chart's or a figure's image at.
export const stimulusImagePath = (id: string) => `/api/media/stimuli/${encodeURIComponent(id)}`
