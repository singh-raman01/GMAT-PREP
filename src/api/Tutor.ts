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
  // When the message was last asked.
  at: Schema.Number,
  // Asked again since, and answered from the stored reply with no new call.
  reused: Schema.Boolean,
  // The key the reply was written for, when the Curator has changed the
  // key since.
  oldKey: Schema.NullOr(Schema.String)
}) {}

// Whether the chat can take a message now: it is set up, under its cap, and
// its Question is still in the Question Bank.
export const TutorState = Schema.Literals(["open", "cap-reached", "not-set-up", "withdrawn"])
export type TutorState = typeof TutorState.Type

// The latest exchanges about a Question, the latest last.
export class TutorView extends Schema.Class<TutorView>("gmat-prep/api/TutorView")({
  questionId: QuestionId,
  exchanges: Schema.Array(TutorExchange),
  // Whether earlier exchanges are kept: ask for them with the first one's id.
  earlier: Schema.Boolean,
  state: TutorState,
  // What the Curator still has to set while Tutor Chat is not set up, in words.
  missing: Schema.Array(Schema.String)
}) {}

export class ProblemReportView extends Schema.Class<ProblemReportView>("gmat-prep/api/ProblemReportView")({
  id: Schema.String,
  questionId: QuestionId,
  // The Question's stem, so that reports on several Questions can be told apart.
  stem: Schema.String,
  text: Schema.String,
  // When the Learner last wrote it.
  at: Schema.Number,
  // The Curator's decision on it, once made: dismissed keeps the Question as
  // it is, key-changed gave it another key, withdrawn takes it out.
  decision: Schema.NullOr(Schema.String),
  decidedAt: Schema.NullOr(Schema.Number)
}) {}

// Why a Question is closed to the chat and to reports: the Profile has no
// answer to it that a Session shows yet, a running Sectional or Mock holds
// it, or the Curator has taken it out of the Question Bank.
export const ClosedReason = Schema.Literals(["not-answered", "held", "withdrawn"])
export type ClosedReason = typeof ClosedReason.Type

export class TutorQuestionClosed extends Schema.TaggedError<TutorQuestionClosed>()(
  "TutorQuestionClosed",
  { reason: ClosedReason },
  { httpApiStatus: 409 }
) {}

export class TutorCapReached extends Schema.TaggedError<TutorCapReached>()("TutorCapReached", {}, { httpApiStatus: 429 }) {}

export class TutorNotSetUp extends Schema.TaggedError<TutorNotSetUp>()(
  "TutorNotSetUp",
  { missing: Schema.Array(Schema.String) },
  { httpApiStatus: 409 }
) {}

// The API is down or rate limited.
export class TutorUnavailable extends Schema.TaggedError<TutorUnavailable>()("TutorUnavailable", {}, { httpApiStatus: 503 }) {}

// The API refused the call for a reason trying again cannot fix, such as a
// wrong key or an unknown model; the Curator's Settings show what it said.
export class TutorRefused extends Schema.TaggedError<TutorRefused>()("TutorRefused", {}, { httpApiStatus: 502 }) {}

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
      // The exchanges before this one, for an earlier page.
      query: { before: Schema.optional(Schema.String) },
      success: TutorView,
      error: TutorQuestionClosed
    }),
    HttpApiEndpoint.post("ask", "/questions/:id", {
      params: { id: QuestionId },
      payload: Schema.Struct({ message: MessageText }),
      success: TutorView,
      error: [TutorQuestionClosed, TutorCapReached, TutorNotSetUp, TutorUnavailable, TutorRefused, TutorReplyInvalid]
    }),
    // The Profile's report on the Question while the Curator has not decided
    // it, which a new report replaces.
    HttpApiEndpoint.get("myReport", "/questions/:id/report", {
      params: { id: QuestionId },
      success: Schema.NullOr(ProblemReportView)
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
  monthFrom: Schema.Number,
  // The latest Tutor Chat call, when the API refused it, with what it said.
  refused: Schema.NullOr(Schema.Struct({ at: Schema.Number, detail: Schema.String }))
}) {}

export class CuratorTutorApi extends HttpApiGroup.make("curatorTutor")
  .add(
    HttpApiEndpoint.get("spend", "/", { success: TutorSpendView }),
    HttpApiEndpoint.put("saveCap", "/", { payload: Schema.Struct({ cap: TutorCap }), success: TutorSpendView })
  )
  .middleware(CuratorSession)
  .prefix("/api/curator/tutor")
{}
