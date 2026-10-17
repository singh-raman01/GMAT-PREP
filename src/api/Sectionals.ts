import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { DifficultyBand } from "./difficulty.ts"
import { EndedBy, Named, PracticeClock, Selection, SelectionInvalid, ServedView, SessionId } from "./Practice.ts"
import { ProfileSession } from "./Profiles.ts"
import { QuestionId } from "./Review.ts"

// Sectionals: one Section taken alone under Mock rules. It is adaptive and
// timed at 45 minutes, a Question must be answered before the next appears,
// there is no going back, and Review & Edit allows up to three changed
// answers when time remains after the last Question.

export const SectionMinutes = 45
export const MaxChanges = 3

// How many unseen Questions held for Mocks a group of the Section has, by
// Difficulty Band, against the twice its Blueprint count that a start needs.
export class GroupStockView extends Schema.Class<GroupStockView>("gmat-prep/api/GroupStockView")({
  group: Named,
  needed: Schema.Int,
  unseen: Schema.Int,
  byBand: Schema.Struct({ easy: Schema.Int, medium: Schema.Int, hard: Schema.Int })
}) {}

export class SectionReadiness extends Schema.Class<SectionReadiness>("gmat-prep/api/SectionReadiness")({
  section: Named,
  questions: Schema.Int,
  minutes: Schema.Int,
  ready: Schema.Boolean,
  groups: Schema.Array(GroupStockView)
}) {}

export class SectionalOptions extends Schema.Class<SectionalOptions>("gmat-prep/api/SectionalOptions")({
  sections: Schema.Array(SectionReadiness),
  // The Sectional this Profile has running, if any.
  running: Schema.NullOr(SessionId)
}) {}

// Where a Sectional stands: a Question on screen, Review & Edit, or over.
export const SectionalStage = Schema.Literals(["question", "review", "finished"])
export type SectionalStage = typeof SectionalStage.Type

export class ReviewEntry extends Schema.Class<ReviewEntry>("gmat-prep/api/ReviewEntry")({
  position: Schema.Int,
  questionId: QuestionId,
  questionType: Named,
  bookmarked: Schema.Boolean,
  // Its answer was changed in Review & Edit.
  changed: Schema.Boolean
}) {}

export class SectionalResult extends Schema.Class<SectionalResult>("gmat-prep/api/SectionalResult")({
  position: Schema.Int,
  questionId: QuestionId,
  questionType: Named,
  // As it stood when the Section closed, which the score uses.
  difficulty: Schema.Number,
  band: DifficultyBand,
  correct: Schema.Boolean,
  timedOut: Schema.Boolean,
  // Left on screen when the Section ended, with no answer.
  unanswered: Schema.Boolean,
  timeSpentMs: Schema.Int,
  bookmarked: Schema.Boolean,
  // Seen by the Profile before this Section chose it.
  repeat: Schema.Boolean,
  // A Review & Edit change: whether the first answer and the final one were right.
  change: Schema.NullOr(Schema.Struct({ wasCorrect: Schema.Boolean, isCorrect: Schema.Boolean }))
}) {}

export class SectionalReport extends Schema.Class<SectionalReport>("gmat-prep/api/SectionalReport")({
  score: Schema.Int,
  low: Schema.Int,
  high: Schema.Int,
  ability: Schema.Number,
  standardError: Schema.Number,
  results: Schema.Array(SectionalResult),
  // Slots the Section never reached, counted as wrong.
  unreached: Schema.Int,
  // Slots the Question Bank had nothing left to fill, not scored.
  unfilled: Schema.Int,
  repeats: Schema.Int,
  changes: Schema.Int,
  // The points Review & Edit gained (above 0) or lost (below 0).
  editPoints: Schema.Int,
  // A key changed since the Section closed, and the report follows it.
  rescored: Schema.Boolean
}) {}

export class SectionalView extends Schema.Class<SectionalView>("gmat-prep/api/SectionalView")({
  id: SessionId,
  section: Named,
  stage: SectionalStage,
  // The Questions it serves, as far as known now: those served, and those
  // still to come for the slots open and the passage or set on screen. Fewer
  // than its Blueprint count once a slot is left unfilled.
  total: Schema.Int,
  // Of those, the ones still to come after the Question on screen.
  remaining: Schema.Int,
  // Questions answered so far.
  answered: Schema.Int,
  // The Question on screen, while one is.
  current: Schema.NullOr(ServedView),
  // In Review & Edit: every Question, and the changes left.
  review: Schema.NullOr(Schema.Struct({ entries: Schema.Array(ReviewEntry), changesLeft: Schema.Int })),
  nextSeq: Schema.Int,
  clock: PracticeClock,
  // This device holds the Sectional; another sees it read-only.
  heldHere: Schema.Boolean,
  endedBy: Schema.NullOr(EndedBy),
  report: Schema.NullOr(SectionalReport),
  createdAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number)
}) {}

// A served Question in Review & Edit, or after the Sectional: the answer
// that stands, while it can still change, and once the Sectional is over its
// Debrief.
export class SectionalQuestion extends Schema.Class<SectionalQuestion>("gmat-prep/api/SectionalQuestion")({
  served: ServedView,
  selection: Schema.NullOr(Selection)
}) {}

export class SectionalSummary extends Schema.Class<SectionalSummary>("gmat-prep/api/SectionalSummary")({
  id: SessionId,
  section: Named,
  finished: Schema.Boolean,
  score: Schema.NullOr(Schema.Int),
  low: Schema.NullOr(Schema.Int),
  high: Schema.NullOr(Schema.Int),
  createdAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number)
}) {}

export class SectionalNotFound extends Schema.TaggedError<SectionalNotFound>()(
  "SectionalNotFound",
  {},
  { httpApiStatus: 404 }
) {}

export class UnknownSection extends Schema.TaggedError<UnknownSection>()(
  "UnknownSection",
  { section: Schema.String },
  { httpApiStatus: 422 }
) {}

// The Mock Reserve does not hold enough unseen Questions for the Section.
export class ReserveTooSmall extends Schema.TaggedError<ReserveTooSmall>()(
  "ReserveTooSmall",
  { readiness: SectionReadiness },
  { httpApiStatus: 409 }
) {}

// A Sectional is running already; it is the one to go back to.
export class SectionalRunning extends Schema.TaggedError<SectionalRunning>()(
  "SectionalRunning",
  { id: SessionId },
  { httpApiStatus: 409 }
) {}

// A request that does not fit where the Sectional stands, with the
// Sectional as it stands: the Question was answered or is not the one on
// screen, Review & Edit has not begun or has no changes left, a change
// gives the answer that stands, or the Sectional is over.
export class SectionalOutOfStep extends Schema.TaggedError<SectionalOutOfStep>()(
  "SectionalOutOfStep",
  {
    reason: Schema.Literals(["answered", "not-current", "not-in-review", "no-changes-left", "same-answer", "finished"]),
    view: SectionalView
  },
  { httpApiStatus: 409 }
) {}

export class SectionalHeldElsewhere extends Schema.TaggedError<SectionalHeldElsewhere>()(
  "SectionalHeldElsewhere",
  { view: SectionalView },
  { httpApiStatus: 409 }
) {}

const params = { params: { id: SessionId } }
const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export class SectionalsApi extends HttpApiGroup.make("sectionals")
  .add(
    // Each Section's start check for this Profile.
    HttpApiEndpoint.get("options", "/options", { success: SectionalOptions }),
    // Starts a Sectional, held by this device, and serves its first Question.
    HttpApiEndpoint.post("start", "/", {
      payload: Schema.Struct({ section: Schema.String }),
      success: SectionalView,
      error: [UnknownSection, ReserveTooSmall, SectionalRunning]
    }),
    // The Profile's Sectionals, the latest first.
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(SectionalSummary) }),
    HttpApiEndpoint.get("get", "/:id", { ...params, success: SectionalView, error: SectionalNotFound }),
    // Answers the Question on screen and serves the next, or opens Review &
    // Edit after the last. A submit sent again with the same sequence
    // number is recorded once.
    HttpApiEndpoint.post("answer", "/:id/answer", {
      ...params,
      payload: Schema.Struct({ seq: Seq, questionId: QuestionId, selection: Selection }),
      success: SectionalView,
      error: [SectionalNotFound, SectionalOutOfStep, SelectionInvalid, SectionalHeldElsewhere]
    }),
    HttpApiEndpoint.post("bookmark", "/:id/bookmark", {
      ...params,
      payload: Schema.Struct({ questionId: QuestionId, bookmarked: Schema.Boolean }),
      success: SectionalView,
      error: [SectionalNotFound, SectionalOutOfStep, SectionalHeldElsewhere]
    }),
    // A served Question: in Review & Edit with the answer that stands, and
    // once the Sectional is over with its Debrief.
    HttpApiEndpoint.get("question", "/:id/questions/:position", {
      params: {
        id: SessionId,
        position: Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
      },
      success: SectionalQuestion,
      error: [SectionalNotFound, SectionalOutOfStep]
    }),
    // Changes an answer in Review & Edit: a new Response that supersedes the
    // one that stood.
    HttpApiEndpoint.post("change", "/:id/change", {
      ...params,
      payload: Schema.Struct({ seq: Seq, questionId: QuestionId, selection: Selection }),
      success: SectionalView,
      error: [SectionalNotFound, SectionalOutOfStep, SelectionInvalid, SectionalHeldElsewhere]
    }),
    // Ends the Sectional; Questions not reached count as wrong.
    HttpApiEndpoint.post("finish", "/:id/finish", {
      ...params,
      success: SectionalView,
      error: [SectionalNotFound, SectionalHeldElsewhere]
    }),
    // This device takes the Sectional over; the one that held it turns read-only.
    HttpApiEndpoint.post("claim", "/:id/claim", { ...params, success: SectionalView, error: SectionalNotFound })
  )
  .middleware(ProfileSession)
  .prefix("/api/sectionals")
{}
