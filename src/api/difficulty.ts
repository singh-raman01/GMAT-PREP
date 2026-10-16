import { Schema } from "effect"

// Difficulty sits on the scale it shares with Ability. A Band is read off a
// Question's current Difficulty: Easy below -0.5, Hard above +0.5, Medium
// between, both cut points included.

export const DifficultyBand = Schema.Literals(["easy", "medium", "hard"])
export type DifficultyBand = typeof DifficultyBand.Type

export const BandCut = 0.5

export const bandOf = (difficulty: number): DifficultyBand =>
  difficulty < -BandCut ? "easy" : difficulty > BandCut ? "hard" : "medium"

export const bandNames: Record<DifficultyBand, string> = { easy: "Easy", medium: "Medium", hard: "Hard" }

// A Book Label's place on the Difficulty scale.
export const labelDifficulty: Readonly<Record<DifficultyBand, number>> = { easy: -1, medium: 0, hard: 1 }

// A Sibling's Difficulty is within this distance of the missed Question's.
export const SimilarDifficulty = 0.5
