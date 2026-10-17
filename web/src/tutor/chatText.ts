import type { ClosedReason, TutorExchange, TutorState } from "../../../src/api/Tutor.ts"

// What Tutor Chat and Report a problem say to the Learner.

export const capNote =
  "Tutor Chat has reached this month's spending cap. It opens again next month, or when the Curator raises the cap."

export const notSetUpNote = (missing: ReadonlyArray<string>) =>
  missing.length === 0
    ? "Tutor Chat is not set up yet. The Curator sets it up under Settings."
    : `Tutor Chat is not set up yet: the Curator has to set ${missing.join(", ")} under Settings.`

const withdrawnNote = "The Curator has taken this Question out of the Question Bank, so the tutor no longer discusses it."

export const stateNote = (state: TutorState, missing: ReadonlyArray<string>) =>
  state === "cap-reached"
    ? capNote
    : state === "not-set-up"
    ? notSetUpNote(missing)
    : state === "withdrawn"
    ? withdrawnNote
    : undefined

export const closedNote = (reason: ClosedReason, action: "chat" | "report") =>
  reason === "held"
    ? "A Sectional or Mock you are taking holds this Question. Ask about it, or report it, once that ends."
    : reason === "withdrawn"
    ? action === "report"
      ? "The Curator has already taken this Question out of the Question Bank, so there is nothing to report."
      : withdrawnNote
    : "You can ask about this Question, or report it, once you have answered it and its result shows."

// What the panel says for a failure it knows; any other goes to the page.
export const failureNote = (failure: { readonly _tag: string }, action: "chat" | "report"): string | undefined => {
  switch (failure._tag) {
    case "TutorCapReached":
      return capNote
    case "TutorNotSetUp":
      return notSetUpNote("missing" in failure ? (failure.missing as ReadonlyArray<string>) : [])
    case "TutorUnavailable":
      return "The tutor cannot be reached now. Try again in a little while; everything else keeps working."
    case "TutorRefused":
      return "The tutor's model refused the call, so asking again will not help. Tell the Curator: Settings shows what the model's API said."
    case "TutorReplyInvalid":
      return "The tutor's reply could not be shown. Try asking again, perhaps in other words."
    case "TutorQuestionClosed":
      return closedNote("reason" in failure ? (failure.reason as ClosedReason) : "not-answered", action)
    default:
      return undefined
  }
}

export const emptyMessageNote = "Write your question first."
export const emptyReportNote = "Say what you believe is wrong with it."

// Read out once a reply arrives, as the reply is added where focus is not.
export const replyAnnouncement = (latest: TutorExchange | undefined) =>
  latest?.reused === true ? "You asked this before. The tutor's earlier reply is now the last one." : "The tutor replied."

// The latest exchanges replace what was shown of them: one asked again moves
// to the end, and those older than the page stay.
export const withLatest = (shown: ReadonlyArray<TutorExchange>, latest: ReadonlyArray<TutorExchange>) => {
  const ids = new Set(latest.map((exchange) => exchange.id))
  return [...shown.filter((exchange) => !ids.has(exchange.id)), ...latest]
}
