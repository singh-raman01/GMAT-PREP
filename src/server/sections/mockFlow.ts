import { BreakMinutes, KeepBreakSeconds } from "../../api/Mocks.ts"

// How a Mock moves from Section to Section (docs/design.md, "Sessions"): the
// one optional 10-minute break comes after Section 1 or Section 2. It begins
// as soon as Section 1 closes; going on within its first minute keeps it for
// after Section 2, and going on later ends it early. When it runs out, the
// next Section starts. With the break used, the next Section starts at once.

export const BreakMs = BreakMinutes * 60 * 1000
export const KeepBreakMs = KeepBreakSeconds * 1000

export interface MockFlow {
  // How many Sections have started.
  readonly started: number
  // The Section the break came after, once used.
  readonly breakAfter: number | null
  // When the break now running began.
  readonly breakStartedAt: number | null
  readonly stage: "section" | "break" | "finished"
}

export const NewMock: MockFlow = { started: 1, breakAfter: null, breakStartedAt: null, stage: "section" }

// What comes after the Section now running closes.
export const afterSection = (flow: MockFlow, closedAt: number): MockFlow => {
  if (flow.started >= 3) return { ...flow, stage: "finished" }
  if (flow.breakAfter === null) return { ...flow, stage: "break", breakStartedAt: closedAt }
  return { ...flow, started: flow.started + 1 }
}

// Whether going on now keeps the break for after Section 2.
export const keepsBreak = (flow: MockFlow, now: number) =>
  flow.stage === "break" && flow.started === 1 && flow.breakStartedAt !== null && now - flow.breakStartedAt < KeepBreakMs

export const breakLeftMs = (flow: MockFlow, now: number) =>
  flow.stage !== "break" || flow.breakStartedAt === null ? 0 : Math.max(0, BreakMs - (now - flow.breakStartedAt))

// Going on from the break, or the break running out: the next Section starts.
export const nextSection = (flow: MockFlow, now: number): MockFlow => {
  if (flow.stage !== "break") return flow
  return {
    started: flow.started + 1,
    breakAfter: keepsBreak(flow, now) ? null : flow.started,
    breakStartedAt: null,
    stage: "section"
  }
}
