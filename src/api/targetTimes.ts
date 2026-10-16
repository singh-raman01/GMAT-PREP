import { sectionOf } from "./taxonomyRules.ts"

// Target Time: how long a Question should take at exam pace. The defaults
// are the Section's time over its Questions: 45 minutes for 21 Quant, 23
// Verbal and 20 Data Insights Questions, rounded. The Curator can set a
// Question Type's own.

export const DefaultTargetSeconds: Readonly<Record<string, number>> = { quant: 129, verbal: 117, di: 135 }

export const TargetSecondsRange = { minimum: 10, maximum: 900 } as const

export const targetSecondsFor = (questionType: string, overrides: Readonly<Record<string, number>>) =>
  overrides[questionType] ?? DefaultTargetSeconds[sectionOf(questionType)] ?? 120
