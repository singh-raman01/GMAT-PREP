// Where a chart's axis labels go: few enough to read at the chart's width,
// on steps a reader counts in, such as weeks for days.

// Steps for Question numbers, and for days counted in weeks.
export const QuestionSteps: ReadonlyArray<number> = [1, 2, 5, 10, 20, 50, 100]
export const DaySteps: ReadonlyArray<number> = [1, 7, 14, 28, 56, 91, 182, 364]

// Ticks from the domain's start, on the first step that keeps them to count
// or fewer; the end gets one too when it sits at least half a step past the
// last.
export const ticksAcross = (domain: readonly [number, number], count: number, steps: ReadonlyArray<number>) => {
  const [from, to] = domain
  if (to <= from) return [from]
  const span = to - from
  const gaps = Math.max(1, count - 1)
  const step = steps.find((each) => span / each <= gaps) ?? Math.ceil(span / gaps)
  const ticks: Array<number> = []
  for (let value = from; value <= to; value += step) ticks.push(value)
  if (to - ticks[ticks.length - 1]! >= step / 2) ticks.push(to)
  return ticks
}

// The columns that carry a label, at most about count of them, evenly spaced
// back from the last, which is the latest.
export const labelledColumns = (length: number, count: number): ReadonlySet<number> => {
  const every = Math.max(1, Math.ceil(length / Math.max(1, count)))
  const labelled = new Set<number>()
  for (let index = length - 1; index >= 0; index -= every) labelled.add(index)
  return labelled
}

// Ticks from 0 for a count, on the first step that reaches the largest value
// within count ticks, ending on a whole step at or past it.
export const ticksUpTo = (top: number, steps: ReadonlyArray<number>, count: number) => {
  const step = steps.find((each) => Math.ceil(top / each) <= count - 1) ?? steps[steps.length - 1]!
  const ceiling = Math.max(step, Math.ceil(top / step) * step)
  return Array.from({ length: ceiling / step + 1 }, (_, index) => index * step)
}
