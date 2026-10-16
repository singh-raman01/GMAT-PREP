import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { BookId } from "./Books.ts"
import { CuratorSession } from "./Curator.ts"
import { JobView, LlmNotConfigured, SpendCap } from "./Jobs.ts"
import { QuestionId, QuestionStatus } from "./Review.ts"

// The golden set: the first 100 Questions the Curator approves from the first
// Book, with the text, Parts, key and tags the Curator confirmed. A check
// reads their pages again and tags them again with the current prompts and
// models: every prompt or model change must keep text, Parts and keys exact,
// and the tags must match the Curator's at least 90% of the time.

export const GoldenLimit = 100
export const TagAgreementNeeded = 0.9

export class GoldenCandidate extends Schema.Class<GoldenCandidate>("gmat-prep/api/GoldenCandidate")({
  questionId: QuestionId,
  questionType: Schema.String,
  set: Schema.String,
  number: Schema.Int,
  page: Schema.Int,
  stem: Schema.String,
  options: Schema.Array(Schema.Struct({ label: Schema.String, text: Schema.String })),
  key: Schema.NullOr(Schema.String),
  // The key the Book prints for the item, which a check expects even when
  // the Curator overrode the Question's key.
  bookKey: Schema.NullOr(Schema.String),
  status: QuestionStatus,
  // The model's tags, or once approved, the Curator's.
  primarySkill: Schema.NullOr(Schema.String),
  secondarySkills: Schema.Array(Schema.String),
  approved: Schema.Boolean
}) {}

// One golden Question that a check did not reproduce.
export class GoldenMiss extends Schema.Class<GoldenMiss>("gmat-prep/api/GoldenMiss")({
  questionId: QuestionId,
  set: Schema.String,
  number: Schema.Int,
  text: Schema.Boolean,
  parts: Schema.Boolean,
  key: Schema.Boolean,
  tags: Schema.Boolean,
  // What differed, in words.
  detail: Schema.String
}) {}

export class GoldenReport extends Schema.Class<GoldenReport>("gmat-prep/api/GoldenReport")({
  items: Schema.Int,
  textExact: Schema.Int,
  partsExact: Schema.Int,
  keysExact: Schema.Int,
  // The share of Questions whose tags match the Curator's, 0 to 1.
  tagAgreement: Schema.Number,
  passed: Schema.Boolean,
  misses: Schema.Array(GoldenMiss),
  finishedAt: Schema.Number
}) {}

export class GoldenView extends Schema.Class<GoldenView>("gmat-prep/api/GoldenView")({
  // The first Book; null before any Book is added.
  book: Schema.NullOr(Schema.Struct({ id: BookId, title: Schema.String })),
  limit: Schema.Int,
  approved: Schema.Int,
  // The first Book's own Questions, in book order.
  candidates: Schema.Array(GoldenCandidate),
  // The latest finished check.
  report: Schema.NullOr(GoldenReport),
  // The latest check's job.
  job: Schema.NullOr(JobView)
}) {}

export class NotGoldenCandidate extends Schema.TaggedError<NotGoldenCandidate>()(
  "NotGoldenCandidate",
  {},
  { httpApiStatus: 409 }
) {}

export class GoldenSetFull extends Schema.TaggedError<GoldenSetFull>()(
  "GoldenSetFull",
  { limit: Schema.Int },
  { httpApiStatus: 409 }
) {}

export class GoldenSetEmpty extends Schema.TaggedError<GoldenSetEmpty>()(
  "GoldenSetEmpty",
  {},
  { httpApiStatus: 409 }
) {}

// One check at a time: a check is queued, running or paused already.
export class GoldenCheckRunning extends Schema.TaggedError<GoldenCheckRunning>()(
  "GoldenCheckRunning",
  {},
  { httpApiStatus: 409 }
) {}

// Tags the Curator gave that do not fit the Taxonomy or the Question Type.
export class GoldenTagsInvalid extends Schema.TaggedError<GoldenTagsInvalid>()(
  "GoldenTagsInvalid",
  { problems: Schema.Array(Schema.String) },
  { httpApiStatus: 422 }
) {}

const questionParams = { params: { questionId: QuestionId } }

export class GoldenApi extends HttpApiGroup.make("golden")
  .add(
    HttpApiEndpoint.get("get", "/golden", { success: GoldenView }),
    // The Curator confirms a Question as extracted and gives its tags.
    HttpApiEndpoint.post("approve", "/golden/:questionId/approve", {
      ...questionParams,
      payload: Schema.Struct({
        primarySkill: Schema.String,
        secondarySkills: Schema.Array(Schema.String).check(Schema.isMaxLength(2))
      }),
      success: GoldenView,
      error: [NotGoldenCandidate, GoldenSetFull, GoldenTagsInvalid]
    }),
    HttpApiEndpoint.post("remove", "/golden/:questionId/remove", {
      ...questionParams,
      success: GoldenView,
      error: NotGoldenCandidate
    }),
    // Starts a check of the golden set, with its own spend cap.
    HttpApiEndpoint.post("check", "/golden/check", {
      payload: Schema.Struct({ spendCap: SpendCap }),
      success: GoldenView,
      error: [GoldenSetEmpty, LlmNotConfigured, GoldenCheckRunning]
    })
  )
  .middleware(CuratorSession)
  .prefix("/api/curator")
{}
