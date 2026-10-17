import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { CuratorSession } from "./Curator.ts"
import { JobView, LlmNotConfigured, SpendCap } from "./Jobs.ts"
import { Named, NoQuestionsMatch, PracticeQuestion, PracticeView, SessionId } from "./Practice.ts"
import { ProfileSession } from "./Profiles.ts"

// Lessons (docs/design.md, decisions 93 to 102): one for each Skill and
// Question Type, written by the worker, approved by the Curator, read by
// Learners, with a 5-Question check.

export const LessonId = Schema.String.pipe(Schema.brand("LessonId"))
export type LessonId = typeof LessonId.Type

export const LessonSubjectKind = Schema.Literals(["skill", "questionType"])
export type LessonSubjectKind = typeof LessonSubjectKind.Type

// The whole Lesson, or its methods part alone, as a Study Plan item for
// Wrong approach opens it.
export const LessonPart = Schema.Literals(["whole", "methods"])
export type LessonPart = typeof LessonPart.Type

// Dollars a Lesson job may spend unless the Curator gives another cap.
export const DefaultLessonSpendCap = 5

export class LessonSubjectView extends Schema.Class<LessonSubjectView>("gmat-prep/api/LessonSubjectView")({
  kind: LessonSubjectKind,
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  section: Named,
  // A Skill's Topic; none for a Question Type.
  topic: Schema.NullOr(Named)
}) {}

export class LessonBody extends Schema.Class<LessonBody>("gmat-prep/api/LessonBody")({
  rules: Schema.Array(Schema.Struct({ title: Schema.String, text: Schema.String })),
  methods: Schema.Array(Schema.Struct({
    name: Schema.String,
    strategy: Schema.NullOr(Named),
    whenValid: Schema.String,
    steps: Schema.String
  })),
  traps: Schema.Array(Schema.Struct({ trapPattern: Schema.NullOr(Named), text: Schema.String })),
  // Each worked example with its right answers and the walkthrough.
  examples: Schema.Array(Schema.Struct({
    question: PracticeQuestion,
    keys: Schema.Array(Schema.Struct({ part: Schema.Int, key: Schema.NullOr(Schema.String) })),
    walkthrough: Schema.String
  }))
}) {}

// The Learner's own record with a Lesson.
export class LessonProgress extends Schema.Class<LessonProgress>("gmat-prep/api/LessonProgress")({
  // The latest check set started from this Lesson, running or finished.
  check: Schema.NullOr(Schema.Struct({
    id: SessionId,
    finishedAt: Schema.NullOr(Schema.Number),
    right: Schema.Int,
    total: Schema.Int
  })),
  // When the methods part, or the whole Lesson, was last marked read.
  methodsRead: Schema.NullOr(Schema.Number),
  read: Schema.NullOr(Schema.Number)
}) {}

export class LessonView extends Schema.Class<LessonView>("gmat-prep/api/LessonView")({
  id: LessonId,
  subject: LessonSubjectView,
  version: Schema.Int,
  status: Schema.Literals(["draft", "approved", "rejected"]),
  body: LessonBody,
  // Minutes to read, at 200 words a minute: the whole Lesson and its methods.
  minutes: Schema.Int,
  methodsMinutes: Schema.Int,
  // How many check Questions can be served now.
  checkQuestions: Schema.Int,
  writtenAt: Schema.Number,
  // The Learner's record; none in the Curator's preview.
  progress: Schema.NullOr(LessonProgress)
}) {}

// An approved Lesson in the Learner's list.
export class LessonListItem extends Schema.Class<LessonListItem>("gmat-prep/api/LessonListItem")({
  id: LessonId,
  subject: LessonSubjectView,
  minutes: Schema.Int
}) {}

// A version in the Curator's list.
const VersionRef = Schema.Struct({ id: LessonId, version: Schema.Int, at: Schema.Number })

export class CuratorLessonRow extends Schema.Class<CuratorLessonRow>("gmat-prep/api/CuratorLessonRow")({
  subject: LessonSubjectView,
  approved: Schema.NullOr(VersionRef),
  // A newer version waiting for a decision.
  draft: Schema.NullOr(VersionRef),
  // A newer version turned down, with the Curator's note.
  rejected: Schema.NullOr(Schema.Struct({ id: LessonId, version: Schema.Int, at: Schema.Number, note: Schema.String })),
  // Why the approved Lesson should be written again, if it should.
  marked: Schema.NullOr(Schema.String),
  // Published Questions outside the Mock Reserve that it may teach from.
  questions: Schema.Int
}) {}

export class CuratorLessonsView extends Schema.Class<CuratorLessonsView>("gmat-prep/api/CuratorLessonsView")({
  rows: Schema.Array(CuratorLessonRow),
  // Subjects to write now: no Lesson, or one marked, with enough Questions.
  needed: Schema.Int,
  // The fewest Questions a Lesson needs.
  fewest: Schema.Int,
  // The latest Lesson job.
  job: Schema.NullOr(JobView)
}) {}

export class LessonNotFound extends Schema.TaggedError<LessonNotFound>()("LessonNotFound", {}, { httpApiStatus: 404 }) {}

// A decision on a version that is no longer a draft.
export class LessonNotDraft extends Schema.TaggedError<LessonNotDraft>()(
  "LessonNotDraft",
  { status: Schema.String },
  { httpApiStatus: 409 }
) {}

// Nothing to write: every subject has a Lesson or too few Questions.
export class NothingToWrite extends Schema.TaggedError<NothingToWrite>()("NothingToWrite", {}, { httpApiStatus: 409 }) {}

// The subject has no approved Lesson yet.
export class NoLesson extends Schema.TaggedError<NoLesson>()("NoLesson", {}, { httpApiStatus: 404 }) {}

export class CuratorLessonsApi extends HttpApiGroup.make("curatorLessons")
  .add(
    HttpApiEndpoint.get("overview", "/", { success: CuratorLessonsView }),
    // Queues a job writing the subjects given, or every one without a Lesson
    // or marked for rewriting.
    HttpApiEndpoint.post("write", "/write", {
      payload: Schema.Struct({ subjects: Schema.optional(Schema.Array(Schema.String)), spendCap: SpendCap }),
      success: JobView,
      error: [LlmNotConfigured, NothingToWrite]
    }),
    HttpApiEndpoint.get("lesson", "/:id", { params: { id: LessonId }, success: LessonView, error: LessonNotFound }),
    HttpApiEndpoint.post("approve", "/:id/approve", {
      params: { id: LessonId },
      success: LessonView,
      error: [LessonNotFound, LessonNotDraft]
    }),
    HttpApiEndpoint.post("reject", "/:id/reject", {
      params: { id: LessonId },
      payload: Schema.Struct({ note: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)) }),
      success: LessonView,
      error: [LessonNotFound, LessonNotDraft]
    })
  )
  .middleware(CuratorSession)
  .prefix("/api/curator/lessons")
{}

const Opening = Schema.Struct({ part: LessonPart, planItemId: Schema.optional(Schema.String) })

export class LessonsApi extends HttpApiGroup.make("lessons")
  .add(
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(LessonListItem) }),
    // Opening a Lesson makes its worked examples Seen (decision 99).
    HttpApiEndpoint.post("open", "/:subject/open", {
      params: { subject: Schema.String },
      payload: Opening,
      success: LessonView,
      error: NoLesson
    }),
    HttpApiEndpoint.post("read", "/:subject/read", {
      params: { subject: Schema.String },
      payload: Opening,
      success: LessonView,
      error: NoLesson
    }),
    // Starts the 5-Question check as an untimed Practice Set.
    HttpApiEndpoint.post("check", "/:subject/check", {
      params: { subject: Schema.String },
      payload: Schema.Struct({ planItemId: Schema.optional(Schema.String) }),
      success: PracticeView,
      error: [NoLesson, NoQuestionsMatch]
    })
  )
  .middleware(ProfileSession)
  .prefix("/api/lessons")
{}
