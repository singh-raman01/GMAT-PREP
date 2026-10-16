// A Stimulus written out as text, for the models that tag, solve and teach
// a Question: a passage as it is, a table as rows, a chart as its data, and
// each tab under its title.

export interface ContentText {
  readonly kind: "passage" | "table" | "chart" | "figure"
  readonly body: string
  readonly title?: string
  readonly columns?: ReadonlyArray<{ readonly name: string; readonly unit: string }>
  readonly rows?: ReadonlyArray<ReadonlyArray<string>>
}

const tableRows = (columns: ReadonlyArray<{ readonly name: string; readonly unit: string }>, rows: ReadonlyArray<ReadonlyArray<string>>) =>
  [
    columns.map((column) => (column.unit === "" ? column.name : `${column.name} (${column.unit})`)).join(" | "),
    ...rows.map((row) => row.join(" | "))
  ].join("\n")

const contentText = (content: ContentText): string => {
  const parts: Array<string> = []
  if (content.body.trim() !== "") parts.push(content.body.trim())
  if ((content.kind === "table" || content.kind === "chart") && content.columns !== undefined) {
    parts.push(
      `${content.kind === "chart" ? "The data the chart draws" : "The table"}:\n${tableRows(content.columns, content.rows ?? [])}`
    )
  }
  if (content.kind === "figure") parts.push("(A figure printed in the book, not available as data.)")
  return parts.join("\n\n")
}

// The label a Stimulus of this kind is quoted under.
export const stimulusLabels = {
  passage: "The passage",
  table: "The table",
  chart: "The chart",
  figure: "The figure",
  tabs: "The sources"
} as const

export const stimulusText = (
  stimulus: ContentText | { readonly kind: "tabs"; readonly tabs: ReadonlyArray<ContentText> }
): string =>
  stimulus.kind === "tabs"
    ? stimulus.tabs.map((tab) => `${tab.title ?? "Source"}:\n${contentText(tab)}`).join("\n\n")
    : contentText(stimulus)

// A Stimulus as linking drafts it, written out the same way, under its label.
export const draftText = (
  draft:
    | { readonly kind: "passage" | "figure"; readonly body: string; readonly title?: string }
    | {
      readonly kind: "table" | "chart"
      readonly body: string
      readonly title?: string
      readonly table: {
        readonly columns: ReadonlyArray<{ readonly name: string; readonly unit: string }>
        readonly rows: ReadonlyArray<ReadonlyArray<string>>
      }
    }
    | { readonly kind: "tabs"; readonly tabs: ReadonlyArray<StimulusDraftContent> }
): { readonly label: string; readonly text: string } => {
  const content = (part: StimulusDraftContent): ContentText =>
    "table" in part
      ? { kind: part.kind, body: part.body, ...(part.title === undefined ? {} : { title: part.title }), columns: part.table.columns, rows: part.table.rows }
      : { kind: part.kind, body: part.body, ...(part.title === undefined ? {} : { title: part.title }) }
  return {
    label: stimulusLabels[draft.kind],
    text: stimulusText(draft.kind === "tabs" ? { kind: "tabs", tabs: draft.tabs.map(content) } : content(draft))
  }
}

type StimulusDraftContent =
  | { readonly kind: "passage" | "figure"; readonly body: string; readonly title?: string }
  | {
    readonly kind: "table" | "chart"
    readonly body: string
    readonly title?: string
    readonly table: {
      readonly columns: ReadonlyArray<{ readonly name: string; readonly unit: string }>
      readonly rows: ReadonlyArray<ReadonlyArray<string>>
    }
  }

// A Dataset's columns and printed cells, for writing it out as text.
export const datasetText = (
  dataset: {
    readonly columns: ReadonlyArray<{ readonly name: string; readonly unit: string }>
    readonly rows: ReadonlyArray<ReadonlyArray<{ readonly text: string }>>
  } | null
) => (dataset === null ? {} : { columns: dataset.columns, rows: dataset.rows.map((row) => row.map((cell) => cell.text)) })
