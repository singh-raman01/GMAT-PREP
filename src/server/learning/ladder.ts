// The Retry Ladder (docs/design.md, "Learning loop"): three steps that
// clear an Error Log entry, counted in Study Days after the miss. Its state
// is worked out from the entry's events each time, so nothing about it needs
// rebuilding.

export type Step = 1 | 2 | 3

// The Study Days after the miss that each step falls due on.
export const StepDays: Readonly<Record<Step, number>> = { 1: 2, 2: 7, 3: 21 }
// A step missed comes back this many Study Days later.
export const RepeatDays = 2

export type LadderEvent =
  // A miss of the entry's Question outside the ladder: it starts the ladder,
  // or starts it again.
  | { readonly kind: "miss"; readonly day: number; readonly at: number }
  // A step taken, passed or not.
  | { readonly kind: "attempt"; readonly step: Step; readonly day: number; readonly at: number; readonly passed: boolean }
  // A step with no Question to serve, skipped with a note.
  | { readonly kind: "skip"; readonly step: Step; readonly day: number; readonly at: number; readonly note: string }

export interface LadderStep {
  readonly step: Step
  readonly day: number
  readonly outcome: "passed" | "missed" | "skipped"
  readonly note?: string
}

export interface Ladder {
  readonly status: "open" | "resolved"
  // The step to take next and the Study Day it falls due; null once resolved.
  readonly step: Step | null
  readonly dueDay: number | null
  // The Study Day of the miss this run of the ladder began with.
  readonly startDay: number
  // This run's steps, in order.
  readonly history: ReadonlyArray<LadderStep>
}

// The ladder after the events, in the order they happened; null before
// any miss.
export const ladderOf = (events: ReadonlyArray<LadderEvent>): Ladder | null => {
  let ladder: Ladder | null = null
  for (const event of events.toSorted((a, b) => a.at - b.at)) {
    if (event.kind === "miss") {
      ladder = { status: "open", step: 1, dueDay: event.day + StepDays[1], startDay: event.day, history: [] }
      continue
    }
    if (ladder === null || ladder.step !== event.step) continue
    const passed = event.kind === "skip" || event.passed
    const done: LadderStep = event.kind === "skip"
      ? { step: event.step, day: event.day, outcome: "skipped", note: event.note }
      : { step: event.step, day: event.day, outcome: event.passed ? "passed" : "missed" }
    const history = [...ladder.history, done]
    if (!passed) {
      ladder = { ...ladder, dueDay: event.day + RepeatDays, history }
    } else if (event.step === 3) {
      ladder = { ...ladder, status: "resolved", step: null, dueDay: null, history }
    } else {
      const next = (event.step + 1) as Step
      ladder = { ...ladder, step: next, dueDay: Math.max(ladder.startDay + StepDays[next], event.day + 1), history }
    }
  }
  return ladder
}
