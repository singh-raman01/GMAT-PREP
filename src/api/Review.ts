import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { BookId } from "./Books.ts"
import { CuratorSession } from "./Curator.ts"
import { StimulusView } from "./Stimulus.ts"

// The Review Queue: Questions held for the Curator, each with every reason,
// and pages extraction could not read.

export const ReviewItemId = Schema.String.pipe(Schema.brand("ReviewItemId"))
export type ReviewItemId = typeof ReviewItemId.Type

export const QuestionId = Schema.String.pipe(Schema.brand("QuestionId"))
export type QuestionId = typeof QuestionId.Type

export const ReasonCode = Schema.Literals([
  // Found when the Question is extracted and linked.
  "structure",
  "no-key",
  "key-conflict",
  "render",
  "figure",
  "same-text-other-key",
  "near-match",
  // Another Source of the Question gives another key.
  "source-key",
  // Found by the Publish Gate after enrichment.
  "tags",
  "solver-disagreement",
  "approach-misses-key",
  "option-notes",
  // An Approach or a wrong-option note that cannot be shown: empty, not
  // rendering, or with an expected time out of range.
  "teaching-text",
  "difficulty",
  // Enrichment has not run on it, as for a Question from before the gate.
  "not-enriched",
  // A page, not a Question.
  "unread-page"
])
export type ReasonCode = typeof ReasonCode.Type

export class ReviewReason extends Schema.Class<ReviewReason>("gmat-prep/api/ReviewReason")({
  code: ReasonCode,
  detail: Schema.String
}) {}

// Reasons the Curator may publish past, having checked the Question: that
// the key stands though a solver disagreed, or that the Difficulty estimate
// and the Book Label differ. Publishing never changes the key.
export const PublishableReasons: ReadonlySet<ReasonCode> = new Set(["solver-disagreement", "difficulty"])

export const QuestionStatus = Schema.Literals(["draft", "held", "published", "withdrawn"])
export type QuestionStatus = typeof QuestionStatus.Type

export class SourceView extends Schema.Class<SourceView>("gmat-prep/api/SourceView")({
  bookId: BookId,
  bookTitle: Schema.String,
  set: Schema.String,
  number: Schema.Int,
  page: Schema.Int
}) {}

export class ApproachView extends Schema.Class<ApproachView>("gmat-prep/api/ApproachView")({
  // A Strategy id from the Taxonomy.
  strategy: Schema.String,
  // Markdown with LaTeX.
  steps: Schema.String,
  expectedSeconds: Schema.Int,
  validWhen: Schema.String,
  // book for the Book's own explanation, llm for one the model wrote.
  author: Schema.Literals(["book", "llm"]),
  answer: Schema.NullOr(Schema.String)
}) {}

export class OptionNoteView extends Schema.Class<OptionNoteView>("gmat-prep/api/OptionNoteView")({
  label: Schema.String,
  trapNote: Schema.String,
  mistakeType: Schema.String,
  trapPattern: Schema.NullOr(Schema.String)
}) {}

export class KeyOverrideView extends Schema.Class<KeyOverrideView>("gmat-prep/api/KeyOverrideView")({
  previousKey: Schema.NullOr(Schema.String),
  newKey: Schema.String,
  reason: Schema.String,
  createdAt: Schema.Number
}) {}

export class QuestionView extends Schema.Class<QuestionView>("gmat-prep/api/QuestionView")({
  id: QuestionId,
  section: Schema.String,
  questionType: Schema.String,
  // What it asks about: a passage, a table, a chart, a figure or tabs.
  stimulus: Schema.NullOr(StimulusView),
  stem: Schema.String,
  options: Schema.Array(Schema.Struct({ label: Schema.String, text: Schema.String })),
  key: Schema.NullOr(Schema.String),
  keyBasis: Schema.NullOr(Schema.Literals(["book", "computed", "override"])),
  status: QuestionStatus,
  bookLabel: Schema.NullOr(Schema.String),
  // The explanation its Approaches are written with, as the Book prints it.
  explanation: Schema.NullOr(Schema.String),
  sources: Schema.Array(SourceView),
  // What enrichment gave it: Skill ids, the Difficulty estimate, the
  // independent solves' answers, its Approaches and its wrong-option notes.
  primarySkill: Schema.NullOr(Schema.String),
  secondarySkills: Schema.Array(Schema.String),
  difficultyEstimate: Schema.NullOr(Schema.Number),
  solverAnswers: Schema.Array(Schema.String),
  approaches: Schema.Array(ApproachView),
  optionNotes: Schema.Array(OptionNoteView),
  keyOverrides: Schema.Array(KeyOverrideView),
  // Approved for the golden set.
  golden: Schema.Boolean
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
  // Whether enrichment can be tried again for it: tagging, solving, or its
  // Approaches and notes, after an unusable reply.
  checkable: Schema.Boolean,
  createdAt: Schema.Number
}) {}

// Questions waiting for enrichment and the Publish Gate: those a job is
// checking, those only a paused job will check, and those no job will check
// until the Curator asks, as after a job was cancelled.
export class DraftsView extends Schema.Class<DraftsView>("gmat-prep/api/DraftsView")({
  checking: Schema.Int,
  paused: Schema.Int,
  stranded: Schema.Int
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

// A Key Override names one of the Question's own options.
export class KeyNotAnOption extends Schema.TaggedError<KeyNotAnOption>()(
  "KeyNotAnOption",
  { options: Schema.Array(Schema.String) },
  { httpApiStatus: 422 }
) {}

export const KeyOverrideReason = Schema.String.check(
  Schema.makeFilter((reason: string) => reason.trim().length >= 3 && reason.trim().length <= 500, {
    description: "a reason of 3 to 500 characters"
  })
)

// Moving a Question to the related Question's passage needs both to ask
// about passages, different ones.
export class NoOtherPassage extends Schema.TaggedError<NoOtherPassage>()("NoOtherPassage", {}, { httpApiStatus: 409 }) {}

// A merge would lose a key the Curator chose: the Question's key is a Key
// Override that the related Question's key does not match.
export class KeysDiffer extends Schema.TaggedError<KeysDiffer>()(
  "KeysDiffer",
  { key: Schema.String, relatedKey: Schema.NullOr(Schema.String) },
  { httpApiStatus: 409 }
) {}

// The Question to merge into is still waiting for its checks, which could
// overwrite what the merge gives it.
export class MergeTargetChecking extends Schema.TaggedError<MergeTargetChecking>()(
  "MergeTargetChecking",
  {},
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
    // A near match whose passage nearly copies the related Question's: the
    // same passage, so the Question keeps its words and moves to that
    // passage, and is checked again.
    HttpApiEndpoint.post("usePassage", "/review/:id/passage", {
      ...decided,
      error: [ReviewItemNotFound, ReviewItemNotOpen, NoOtherPassage]
    }),
    // A near match or same text: the same Question, so this one's Sources
    // join the related Question and this one goes, with any golden-set
    // approval. Its Key Override goes with its Sources.
    HttpApiEndpoint.post("merge", "/review/:id/merge", {
      ...decided,
      error: [ReviewItemNotFound, ReviewItemNotOpen, KeysDiffer, MergeTargetChecking]
    }),
    // Tries again the enrichment an unusable reply left missing or wrong:
    // tagging, solving, or the Approaches and notes. The Question leaves the
    // queue while a job checks it, and comes back if it is held again.
    HttpApiEndpoint.post("checkAgain", "/review/:id/check", {
      ...decided,
      error: [ReviewItemNotFound, ReviewItemNotOpen]
    }),
    HttpApiEndpoint.get("drafts", "/drafts", { success: DraftsView }),
    // Queues a job for the drafts no job would check.
    HttpApiEndpoint.post("checkDrafts", "/drafts/check", { success: DraftsView }),
    // A page extraction could not read, once the Curator has dealt with it.
    HttpApiEndpoint.post("dismiss", "/review/:id/dismiss", {
      ...decided,
      error: [ReviewItemNotFound, ReviewItemNotOpen]
    }),
    // Replaces the key, with the Curator's reason. The Question's Approaches
    // and wrong-option notes are written again for it, and it goes back
    // through the Publish Gate.
    HttpApiEndpoint.post("overrideKey", "/review/:id/key", {
      ...decided,
      payload: Schema.Struct({ key: Schema.Literals(["A", "B", "C", "D", "E"]), reason: KeyOverrideReason }),
      error: [ReviewItemNotFound, ReviewItemNotOpen, KeyNotAnOption]
    })
  )
  .middleware(CuratorSession)
  .prefix("/api/curator")
{}
