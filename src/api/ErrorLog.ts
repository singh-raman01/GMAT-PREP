import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Day } from "./day.ts"
import { DifficultyBand } from "./difficulty.ts"
import { MissedPartView, Named, PartChoice, ServedView, SessionId } from "./Practice.ts"
import { ProfileSession } from "./Profiles.ts"
import { QuestionId } from "./Review.ts"

// The Error Log: each Question a Profile answered wrong, slowly or by a
// guess, one entry per Question holding every Response to it.

export const ErrorReason = Schema.Literals(["wrong", "slow", "guessed"])
export type ErrorReason = typeof ErrorReason.Type

// Resolved once its Retry Ladder is done; withdrawn with its Question.
export const ErrorStatus = Schema.Literals(["open", "resolved", "withdrawn"])
export type ErrorStatus = typeof ErrorStatus.Type

export class LadderStepView extends Schema.Class<LadderStepView>("gmat-prep/api/LadderStepView")({
  step: Schema.Int,
  // The Study Day it was taken, or skipped.
  on: Day,
  outcome: Schema.Literals(["passed", "missed", "skipped"]),
  note: Schema.NullOr(Schema.String)
}) {}

// Where an entry's Retry Ladder stands: the step due next and its Study Day,
// none once Resolved, and the steps of this run so far.
export class LadderView extends Schema.Class<LadderView>("gmat-prep/api/LadderView")({
  step: Schema.NullOr(Schema.Int),
  dueOn: Schema.NullOr(Day),
  steps: Schema.Array(LadderStepView)
}) {}

export class ErrorLogEntry extends Schema.Class<ErrorLogEntry>("gmat-prep/api/ErrorLogEntry")({
  questionId: QuestionId,
  section: Named,
  questionType: Named,
  primarySkill: Schema.NullOr(Named),
  difficulty: Schema.Number,
  band: DifficultyBand,
  // The Books it comes from.
  books: Schema.Array(Named),
  stem: Schema.String,
  status: ErrorStatus,
  // The latest miss: why, its wrong Parts, and the Response they belong to.
  reasons: Schema.Array(ErrorReason),
  parts: Schema.Array(MissedPartView),
  responseId: Schema.String,
  misses: Schema.Int,
  firstMissedAt: Schema.Number,
  lastMissedAt: Schema.Number,
  ladder: Schema.NullOr(LadderView)
}) {}

const Counted = Schema.Struct({ id: Schema.String, name: Schema.String, entries: Schema.Int })

// What each filter can take, with how many entries have it.
export class ErrorLogFacets extends Schema.Class<ErrorLogFacets>("gmat-prep/api/ErrorLogFacets")({
  sections: Schema.Array(Counted),
  skills: Schema.Array(Counted),
  questionTypes: Schema.Array(Counted),
  mistakeTypes: Schema.Array(Counted),
  trapPatterns: Schema.Array(Counted),
  bands: Schema.Array(Counted),
  books: Schema.Array(Counted),
  statuses: Schema.Array(Counted)
}) {}

// How many entries a page lists, unless asked for more.
export const ErrorLogPageSize = 50
export const ErrorLogPageMax = 200

export class ErrorLogView extends Schema.Class<ErrorLogView>("gmat-prep/api/ErrorLogView")({
  // A page of those the filters keep, the latest miss first.
  entries: Schema.Array(ErrorLogEntry),
  // How many the filters keep.
  matching: Schema.Int,
  // How many of those come after this page.
  more: Schema.Int,
  // Every entry, before the filters.
  total: Schema.Int,
  // Entries left out while a running Sectional or Mock holds their
  // Questions, as Practice leaves those out; they come back when it ends.
  held: Schema.Int,
  facets: ErrorLogFacets,
  // The Profile's time zone, which the day filters and the times shown use.
  timeZone: Schema.String
}) {}

// Where a page starts: after the entry with this latest miss and Question,
// as the entries run from the latest miss back, Question id breaking ties.
export const ErrorLogCursor = Schema.String.check(Schema.isPattern(/^\d+\.\S+$/))
export const cursorOf = (entry: { readonly lastMissedAt: number; readonly questionId: string }) =>
  `${entry.lastMissedAt}.${entry.questionId}`
export const parseCursor = (cursor: string) => {
  const dot = cursor.indexOf(".")
  return { at: Number(cursor.slice(0, dot)), id: cursor.slice(dot + 1) }
}

export const ErrorLogFilters = {
  section: Schema.optional(Schema.String),
  // A primary or secondary Skill.
  skill: Schema.optional(Schema.String),
  questionType: Schema.optional(Schema.String),
  mistakeType: Schema.optional(Schema.String),
  trapPattern: Schema.optional(Schema.String),
  band: Schema.optional(DifficultyBand),
  book: Schema.optional(Schema.String),
  status: Schema.optional(ErrorStatus),
  // The latest miss's day, in the Profile's time zone, both included.
  from: Schema.optional(Day),
  to: Schema.optional(Day),
  // The page: the entry it follows, and how many to list; none gives only
  // the counts.
  after: Schema.optional(ErrorLogCursor),
  limit: Schema.optional(Schema.FiniteFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: ErrorLogPageMax })))
}
export type ErrorLogFilters = Schema.Struct<typeof ErrorLogFilters>["Type"]

// One Response to the Question, in any Session.
export class HistoryItem extends Schema.Class<HistoryItem>("gmat-prep/api/HistoryItem")({
  sessionId: SessionId,
  // practice, sectional or mock
  sessionKind: Schema.String,
  at: Schema.Number,
  // first, edit or time-out
  kind: Schema.String,
  selection: Schema.Array(PartChoice),
  timeSpentMs: Schema.Int,
  guessed: Schema.Boolean,
  // Against the current key; null while its Session hides how it went.
  correct: Schema.NullOr(Schema.Boolean),
  // Why it entered the Error Log, when it was a Session's final Response.
  reasons: Schema.Array(ErrorReason)
}) {}

export class ErrorLogDetail extends Schema.Class<ErrorLogDetail>("gmat-prep/api/ErrorLogDetail")({
  entry: ErrorLogEntry,
  // The Question as the latest miss answered it, with its Debrief and the
  // Mistake Types to change.
  served: ServedView,
  // Whether the latest miss's Session was timed.
  timed: Schema.Boolean,
  history: Schema.Array(HistoryItem)
}) {}

export class ErrorLogEntryNotFound extends Schema.TaggedError<ErrorLogEntryNotFound>()(
  "ErrorLogEntryNotFound",
  {},
  { httpApiStatus: 404 }
) {}

// A running Sectional or Mock holds the entry's Question, so it opens once
// that ends.
export class ErrorLogEntryHeld extends Schema.TaggedError<ErrorLogEntryHeld>()(
  "ErrorLogEntryHeld",
  {},
  { httpApiStatus: 409 }
) {}

// A Mistake Type the Taxonomy lacks, or a Part that is not a wrong Part of
// one of the entry's misses.
export class MistakeTypeInvalid extends Schema.TaggedError<MistakeTypeInvalid>()(
  "MistakeTypeInvalid",
  { problem: Schema.String },
  { httpApiStatus: 422 }
) {}

const entryParams = { params: { questionId: QuestionId } }

export class ErrorLogApi extends HttpApiGroup.make("errorLog")
  .add(
    HttpApiEndpoint.get("list", "/", { query: ErrorLogFilters, success: ErrorLogView }),
    HttpApiEndpoint.get("get", "/:questionId", {
      ...entryParams,
      success: ErrorLogDetail,
      error: [ErrorLogEntryNotFound, ErrorLogEntryHeld]
    }),
    // Sets a wrong Part's Mistake Type, stored as the Learner's.
    HttpApiEndpoint.post("setMistakeType", "/:questionId/mistake-type", {
      ...entryParams,
      payload: Schema.Struct({ responseId: Schema.String, part: Schema.Int, mistakeType: Schema.String }),
      success: ErrorLogEntry,
      error: [ErrorLogEntryNotFound, MistakeTypeInvalid]
    })
  )
  .middleware(ProfileSession)
  .prefix("/api/error-log")
{}
