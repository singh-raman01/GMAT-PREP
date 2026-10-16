import type { Comparison, Order, Predicate, Step } from "../src/server/generation/predicates.ts"

// Short ways to write predicate steps in tests and in the fake model, with
// the fields a step leaves unused set to null as the model writes them.

export const filter = (
  name: string,
  column: string,
  comparison: Comparison,
  against: { readonly number: number } | { readonly text: string },
  from: string | null = null
): Step => ({
  op: "filter",
  name,
  from,
  column,
  comparison,
  number: "number" in against ? against.number : null,
  text: "text" in against ? against.text : null
})

export const sort = (name: string, column: string, order: Order, from: string | null = null): Step =>
  ({ op: "sort", name, from, column, order })

export const pick = (name: string, from: string, position: number): Step => ({ op: "pick", name, from, position })

export const row = (name: string, label: string): Step => ({ op: "row", name, label })

export const count = (name: string, rows: string | null = null): Step => ({ op: "count", name, rows })

export const sum = (name: string, column: string, rows: string | null = null): Step => ({ op: "sum", name, rows, column })

export const average = (name: string, column: string, rows: string | null = null): Step =>
  ({ op: "average", name, rows, column })

export const value = (name: string, of: string, column: string): Step => ({ op: "value", name, row: of, column })

export const rank = (name: string, of: string, column: string, order: Order): Step =>
  ({ op: "rank", name, row: of, column, order })

export const label = (name: string, of: string): Step => ({ op: "label", name, row: of })

export const ratio = (name: string, of: string, to: string): Step => ({ op: "ratio", name, of, to })

export const percentChange = (name: string, from: string, to: string): Step => ({ op: "percent-change", name, from, to })

export const difference = (name: string, of: string, minus: string): Step => ({ op: "difference", name, of, minus })

export const compare = (
  name: string,
  left: string,
  comparison: Comparison,
  right: { readonly step: string } | { readonly number: number } | { readonly text: string }
): Step => ({
  op: "compare",
  name,
  left,
  comparison,
  right: "step" in right ? right.step : null,
  number: "number" in right ? right.number : null,
  text: "text" in right ? right.text : null
})

export const relation = (name: string, left: string, right: string): Step => ({ op: "relation", name, left, right })

export const sameRow = (name: string, left: string, right: string): Step => ({ op: "same-row", name, left, right })

export const all = (name: string, ...of: ReadonlyArray<string>): Step => ({ op: "all", name, of })

export const any = (name: string, ...of: ReadonlyArray<string>): Step => ({ op: "any", name, of })

export const not = (name: string, of: string): Step => ({ op: "not", name, of })

export const choice = (name: string, column: number): Step => ({ op: "choice", name, column })

export const predicate = (...steps: ReadonlyArray<Step>): Predicate => ({ steps })
