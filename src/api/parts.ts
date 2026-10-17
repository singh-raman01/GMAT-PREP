import { Schema } from "effect"

// How a Part is answered: one of five options; a statement row with two
// choices, such as Yes or No; a menu filling a blank in a sentence; or one
// column of a two-column grid.
export const PartKind = Schema.Literals(["single-choice", "two-choice", "dropdown", "column-choice"])
export type PartKind = typeof PartKind.Type
