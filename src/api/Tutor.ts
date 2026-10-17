import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { CuratorSession } from "./Curator.ts"
import { ProfileSession } from "./Profiles.ts"
import { QuestionId } from "./Review.ts"

// Tutor Chat and Problem Reports (docs/design.md, decisions 103 to 108): a
// Learner asks about a Question they have answered, or reports one they
// believe is wrong; the Curator sets the monthly cap on chat spend.

export const MessageText = Schema.String.check(
  Schema.makeFilter((text: string) => text.trim().length >= 1 && text.length <= 2000, {
    description: "a message of 1 to 2000 characters"
  })
)

export class TutorExchange extends Schema.Class<TutorExchange>("gmat-prep/api/TutorExchange")({
  id: Schema.String,
  message: Schema.String,
  reply: Schema.String,
  at: Schema.Number,
  // Answered from the same message asked before, with no new call.
  reused: Schema.Boolean
}) {}

// Whether the chat can take a message now: it is set up and under its cap.
export const TutorState = Schema.Literals(["open", "cap-reached", "not-set-up"])
export type TutorState = typeof TutorState.Type

export class TutorView extends Schema.Class<TutorView>("gmat-prep/api/TutorView")({
  questionId: QuestionId,
  exchanges: Schema.Array(TutorExchange),
  state: TutorState
}) {}

export class ProblemReportView extends Schema.Class<ProblemReportView>("gmat-prep/api/ProblemReportView")({
  id: Schema.String,
  questionId: QuestionId,
  text: Schema.String,
  at: Schema.Number,
  // The Curator's decision on it, once made: dismissed keeps the Question as
  // it is; withdrawn takes it out.
  decision: Schema.NullOr(Schema.String),
  decidedAt: Schema.NullOr(Schema.Number)
}) {}

// The Question is not one the Profile can ask about or report now: not
// answered yet, its Session still hides how it went, or a running Sectional
// or Mock holds it.
export class TutorQuestionClosed extends Schema.TaggedError<TutorQuestionClosed>()(
  "TutorQuestionClosed",
  {},
  { httpApiStatus: 409 }
) {}

export class TutorCapReached extends Schema.TaggedError<TutorCapReached>()("TutorCapReached", {}, { httpApiStatus: 429 }) {}

export class TutorNotSetUp extends Schema.TaggedError<TutorNotSetUp>()("TutorNotSetUp", {}, { httpApiStatus: 409 }) {}

// The API is down, rate limited or refused the call.
export class TutorUnavailable extends Schema.TaggedError<TutorUnavailable>()("TutorUnavailable", {}, { httpApiStatus: 503 }) {}

// The model's reply failed its checks twice.
export class TutorReplyInvalid extends Schema.TaggedError<TutorReplyInvalid>()(
  "TutorReplyInvalid",
  {},
  { httpApiStatus: 502 }
) {}

export class TutorApi extends HttpApiGroup.make("tutor")
  .add(
    HttpApiEndpoint.get("conversation", "/questions/:id", {
      params: { id: QuestionId },
      success: TutorView,
      error: TutorQuestionClosed
    }),
    HttpApiEndpoint.post("ask", "/questions/:id", {
      params: { id: QuestionId },
      payload: Schema.Struct({ message: MessageText }),
      success: TutorView,
      error: [TutorQuestionClosed, TutorCapReached, TutorNotSetUp, TutorUnavailable, TutorReplyInvalid]
    }),
    HttpApiEndpoint.post("report", "/questions/:id/report", {
      params: { id: QuestionId },
      payload: Schema.Struct({ text: MessageText }),
      success: ProblemReportView,
      error: TutorQuestionClosed
    }),
    HttpApiEndpoint.get("reports", "/reports", { success: Schema.Array(ProblemReportView) })
  )
  .middleware(ProfileSession)
  .prefix("/api/tutor")
{}

// US dollars a calendar month.
export const TutorCap = Schema.Number.check(
  Schema.makeFilter((cap: number) => Number.isFinite(cap) && cap >= 0 && cap <= 10_000, {
    description: "a monthly cap from 0 to 10000 dollars"
  })
)

export class TutorSpendView extends Schema.Class<TutorSpendView>("gmat-prep/api/TutorSpendView")({
  cap: Schema.Number,
  // Spent on Tutor Chat this month, in the app's time zone, from when.
  spent: Schema.Number,
  monthFrom: Schema.Number
}) {}

export class CuratorTutorApi extends HttpApiGroup.make("curatorTutor")
  .add(
    HttpApiEndpoint.get("spend", "/", { success: TutorSpendView }),
    HttpApiEndpoint.put("saveCap", "/", { payload: Schema.Struct({ cap: TutorCap }), success: TutorSpendView })
  )
  .middleware(CuratorSession)
  .prefix("/api/curator/tutor")
{}
