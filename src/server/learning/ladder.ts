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
  // or starts it again. reasons say why it is in the Error Log, "wrong" when
  // left out.
  | { readonly kind: "miss"; readonly day: number; readonly at: number; readonly reasons?: ReadonlyArray<string> }
  // A miss of the entry's own Question in a retry set's step 1 for it: it
  // starts a run when none is open then, and that set takes no step of it;
  // in an open run the set's attempt says how step 1 went.
  | {
    readonly kind: "own-miss"
    readonly day: number
    readonly at: number
    readonly reasons?: ReadonlyArray<string>
    readonly set: string
  }
  // A step taken in a set made at plannedAt: passed or not, or a rule over
  // the reasons of the run it falls in. A set takes at most one step of a
  // run, the first whose step is the one due.
  | {
    readonly kind: "attempt"
    readonly step: Step
    readonly day: number
    readonly at: number
    readonly passed: boolean | ((reasons: ReadonlyArray<string>) => boolean)
    readonly plannedAt: number
    readonly set?: string
  }
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
  // The miss this run of the ladder began with, and its Study Day.
  readonly startAt: number
  readonly startDay: number
  // This run's steps, in order.
  readonly history: ReadonlyArray<LadderStep>
  // Why the entry is in the Error Log, as this run began.
  readonly reasons: ReadonlyArray<string>
}

const Wrong: ReadonlyArray<string> = ["wrong"]

// At one moment, a miss comes before the steps taken.
const orderOf = (event: LadderEvent) => (event.kind === "miss" || event.kind === "own-miss" ? 0 : 1)

// The ladder after the events, in the order they happened; null before
// any miss.
export const ladderOf = (events: ReadonlyArray<LadderEvent>): Ladder | null => {
  let ladder: Ladder | null = null
  // The sets that took a step of this run, or started it.
  let used = new Set<string>()
  const start = (event: { readonly day: number; readonly at: number; readonly reasons?: ReadonlyArray<string> }): Ladder => ({
    status: "open",
    step: 1,
    dueDay: event.day + StepDays[1],
    startAt: event.at,
    startDay: event.day,
    history: [],
    reasons: event.reasons ?? Wrong
  })
  for (const event of events.toSorted((a, b) => a.at - b.at || orderOf(a) - orderOf(b))) {
    if (event.kind === "miss") {
      ladder = start(event)
      used = new Set()
      continue
    }
    if (event.kind === "own-miss") {
      if (ladder === null || ladder.status === "resolved") {
        ladder = start(event)
        used = new Set([event.set])
      }
      continue
    }
    if (ladder === null || ladder.step !== event.step) continue
    // A set made before this run began was planned for an earlier one.
    if (event.kind === "attempt" && event.plannedAt < ladder.startAt) continue
    if (event.kind === "attempt" && event.set !== undefined) {
      if (used.has(event.set)) continue
      used.add(event.set)
    }
    const passed = event.kind === "skip" ||
      (typeof event.passed === "function" ? event.passed(ladder.reasons) : event.passed)
    const done: LadderStep = event.kind === "skip"
      ? { step: event.step, day: event.day, outcome: "skipped", note: event.note }
      : { step: event.step, day: event.day, outcome: passed ? "passed" : "missed" }
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
