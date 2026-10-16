import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { BookId } from "./Books.ts"
import { CuratorSession } from "./Curator.ts"

// The Review Queue: Questions held for the Curator, each with every reason,
// and pages extraction could not read.

export const ReviewItemId = Schema.String.pipe(Schema.brand("ReviewItemId"))
export type ReviewItemId = typeof ReviewItemId.Type

export const QuestionId = Schema.String.pipe(Schema.brand("QuestionId"))
export type QuestionId = typeof QuestionId.Type

export const ReasonCode = Schema.Literals([
  "structure",
  "no-key",
  "key-conflict",
  "render",
  "figure",
  "same-text-other-key",
  "near-match",
  "key-changed",
  "unread-page"
])
export type ReasonCode = typeof ReasonCode.Type

export class ReviewReason extends Schema.Class<ReviewReason>("gmat-prep/api/ReviewReason")({
  code: ReasonCode,
  detail: Schema.String
}) {}

// Reasons the Curator may publish past: a key a Book Map fix changed is
// shown so the Curator looks again, and publishing accepts it.
export const PublishableReasons: ReadonlySet<ReasonCode> = new Set(["key-changed"])

export const QuestionStatus = Schema.Literals(["draft", "held", "published", "withdrawn"])
export type QuestionStatus = typeof QuestionStatus.Type

export class SourceView extends Schema.Class<SourceView>("gmat-prep/api/SourceView")({
  bookId: BookId,
  bookTitle: Schema.String,
  set: Schema.String,
  number: Schema.Int,
  page: Schema.Int
}) {}

export class QuestionView extends Schema.Class<QuestionView>("gmat-prep/api/QuestionView")({
  id: QuestionId,
  section: Schema.String,
  questionType: Schema.String,
  // Markdown with LaTeX; see richText.ts.
  stem: Schema.String,
  options: Schema.Array(Schema.Struct({ label: Schema.String, text: Schema.String })),
  key: Schema.NullOr(Schema.String),
  keyBasis: Schema.NullOr(Schema.Literals(["book", "computed", "override"])),
  status: QuestionStatus,
  bookLabel: Schema.NullOr(Schema.String),
  // The first Source's explanation, as the Book prints it.
  explanation: Schema.NullOr(Schema.String),
  sources: Schema.Array(SourceView)
}) {}

export class ReviewItemView extends Schema.Class<ReviewItemView>("gmat-prep/api/ReviewItemView")({
  id: ReviewItemId,
  // A held Question, or else a page extraction could not read.
  question: Schema.NullOr(QuestionView),
  page: Schema.NullOr(Schema.Struct({ bookId: BookId, bookTitle: Schema.String, number: Schema.Int })),
  reasons: Schema.Array(ReviewReason),
  // The Question this one may repeat, for a near match or the same text.
  related: Schema.NullOr(QuestionView),
  status: Schema.Literals(["open", "decided"]),
  decision: Schema.NullOr(Schema.Literals(["published", "withdrawn", "variant", "merged", "dismissed"])),
  createdAt: Schema.Number
}) {}

export class ReviewItemNotFound extends Schema.TaggedError<ReviewItemNotFound>()(
  "ReviewItemNotFound",
  {},
  { httpApiStatus: 404 }
) {}

// The item was decided meanwhile, or the action does not fit it, such as
// dismissing a Question.
export class ReviewItemNotOpen extends Schema.TaggedError<ReviewItemNotOpen>()(
  "ReviewItemNotOpen",
  { item: ReviewItemView },
  { httpApiStatus: 409 }
) {}

// Publishing waits until every reason that blocks it is resolved.
export class CannotPublish extends Schema.TaggedError<CannotPublish>()(
  "CannotPublish",
  { reasons: Schema.Array(ReviewReason) },
  { httpApiStatus: 409 }
) {}

const itemParams = { params: { id: ReviewItemId } }
const decided = { ...itemParams, success: ReviewItemView }

export class ReviewApi extends HttpApiGroup.make("review")
  .add(
    HttpApiEndpoint.get("list", "/review", {
      success: Schema.Array(ReviewItemView)
    }),
    HttpApiEndpoint.post("publish", "/review/:id/publish", {
      ...decided,
      error: [ReviewItemNotFound, ReviewItemNotOpen, CannotPublish]
    }),
    HttpApiEndpoint.post("withdraw", "/review/:id/withdraw", {
      ...decided,
      error: [ReviewItemNotFound, ReviewItemNotOpen]
    }),
    // A near match or same text: a separate Question after all.
    HttpApiEndpoint.post("keepAsVariant", "/review/:id/variant", {
      ...decided,
      error: [ReviewItemNotFound, ReviewItemNotOpen]
    }),
    // A near match or same text: the same Question, so this one's Sources
    // join the related Question and this one goes.
    HttpApiEndpoint.post("merge", "/review/:id/merge", {
      ...decided,
      error: [ReviewItemNotFound, ReviewItemNotOpen]
    }),
    // A page extraction could not read, once the Curator has dealt with it.
    HttpApiEndpoint.post("dismiss", "/review/:id/dismiss", {
      ...decided,
      error: [ReviewItemNotFound, ReviewItemNotOpen]
    })
  )
  .middleware(CuratorSession)
  .prefix("/api/curator")
{}
