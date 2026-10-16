import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { BookId, BookNotFound } from "./Books.ts"
import { DifficultyBand } from "./difficulty.ts"
import { ProfileSession } from "./Profiles.ts"
import { QuestionId } from "./Review.ts"

// Practice Sets: Questions chosen by Section, Question Type, Skill,
// Difficulty Band and status, or a Book's items in book order, answered one
// at a time. An untimed set shows the Debrief after each Question.

export const SessionId = Schema.String.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

export const MaxSetSize = 50
export const DefaultSetSize = 10
export const SimilarCount = 3

export const StatusFilter = Schema.Literals(["any", "unseen", "missed", "bookmarked"])
export type StatusFilter = typeof StatusFilter.Type

const SetSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MaxSetSize }))
const ItemNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

// Every filter left out matches everything. Skill matches a primary or a
// secondary Skill, primary first.
// A timed set gets the sum of its Questions' Target Times and shows the
// Debriefs at the end; an untimed one shows each Debrief straight away.
const Timed = Schema.optional(Schema.Boolean)

export const FilterChoice = Schema.Struct({
  kind: Schema.Literal("filters"),
  timed: Timed,
  section: Schema.optional(Schema.String),
  questionType: Schema.optional(Schema.String),
  skill: Schema.optional(Schema.String),
  band: Schema.optional(DifficultyBand),
  status: StatusFilter,
  size: SetSize
})
export type FilterChoice = typeof FilterChoice.Type

// A Book's items in the order it prints them: one set, or the whole Book,
// optionally from one item number to another.
export const BookChoice = Schema.Struct({
  kind: Schema.Literal("book"),
  timed: Timed,
  bookId: BookId,
  set: Schema.optional(Schema.String),
  from: Schema.optional(ItemNumber),
  to: Schema.optional(ItemNumber)
})
export type BookChoice = typeof BookChoice.Type

export const PracticeChoice = Schema.Union([FilterChoice, BookChoice])
export type PracticeChoice = typeof PracticeChoice.Type

// One selection per Part, by option label.
export const PartChoice = Schema.Struct({
  part: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  choice: Schema.String
})
export const Selection = Schema.Array(PartChoice).check(Schema.isMinLength(1))
export type Selection = typeof Selection.Type

export class Named extends Schema.Class<Named>("gmat-prep/api/Named")({
  id: Schema.String,
  name: Schema.String
}) {}

// A Book's item a set skips, and why: its Question is in the Mock Reserve or
// waits for that decision, or it is not in the Question Bank, being checked
// or withdrawn.
export const SkipReason = Schema.Literals(["reserve", "undecided", "checking", "withdrawn"])

export class ItemRef extends Schema.Class<ItemRef>("gmat-prep/api/ItemRef")({
  set: Schema.String,
  number: Schema.Int,
  reason: SkipReason
}) {}

export class PracticePart extends Schema.Class<PracticePart>("gmat-prep/api/PracticePart")({
  position: Schema.Int,
  prompt: Schema.NullOr(Schema.String),
  options: Schema.Array(Schema.Struct({ label: Schema.String, text: Schema.String }))
}) {}

export class PracticeQuestion extends Schema.Class<PracticeQuestion>("gmat-prep/api/PracticeQuestion")({
  id: QuestionId,
  section: Named,
  questionType: Named,
  // Markdown with LaTeX; see richText.ts.
  stem: Schema.String,
  parts: Schema.Array(PracticePart),
  // Where a Book prints it: the Book the set follows, else its first Source.
  source: Schema.NullOr(Schema.Struct({
    bookTitle: Schema.String,
    set: Schema.String,
    number: Schema.Int,
    page: Schema.Int
  }))
}) {}

// Why a wrong option picked tempts, and what picking it most likely signals.
export class TrapNoteView extends Schema.Class<TrapNoteView>("gmat-prep/api/TrapNoteView")({
  part: Schema.Int,
  label: Schema.String,
  note: Schema.String,
  mistakeType: Named,
  trapPattern: Schema.NullOr(Named)
}) {}

export class DebriefApproach extends Schema.Class<DebriefApproach>("gmat-prep/api/DebriefApproach")({
  strategy: Named,
  // Markdown with LaTeX.
  steps: Schema.String,
  expectedSeconds: Schema.Int,
  validWhen: Schema.String,
  // The Book's own explanation.
  fromBook: Schema.Boolean
}) {}

// What a Profile sees once a Question is answered, from stored content only.
// Approaches that reach the current key are shown, fastest first.
export class Debrief extends Schema.Class<Debrief>("gmat-prep/api/Debrief")({
  correct: Schema.Boolean,
  keys: Schema.Array(Schema.Struct({ part: Schema.Int, key: Schema.NullOr(Schema.String) })),
  trapNotes: Schema.Array(TrapNoteView),
  approaches: Schema.Array(DebriefApproach),
  skill: Schema.NullOr(Named),
  difficulty: Schema.Number,
  band: DifficultyBand
}) {}

export class ResponseView extends Schema.Class<ResponseView>("gmat-prep/api/ResponseView")({
  selection: Selection,
  guessed: Schema.Boolean,
  timeSpentMs: Schema.Int,
  // Against the current key.
  correct: Schema.Boolean,
  // Whether it moves Difficulty and Ability; never, in an untimed set.
  rated: Schema.Boolean,
  // Time ran out with the Question on screen, so it has no answer.
  timedOut: Schema.Boolean
}) {}

export class ServedView extends Schema.Class<ServedView>("gmat-prep/api/ServedView")({
  position: Schema.Int,
  question: PracticeQuestion,
  bookmarked: Schema.Boolean,
  response: Schema.NullOr(ResponseView),
  // Once the Question is answered, or the set is over.
  debrief: Schema.NullOr(Debrief)
}) {}

export class PracticeResult extends Schema.Class<PracticeResult>("gmat-prep/api/PracticeResult")({
  position: Schema.Int,
  questionId: QuestionId,
  questionType: Named,
  // Null while the Question is unanswered, and in a timed set until it ends.
  correct: Schema.NullOr(Schema.Boolean),
  guessed: Schema.Boolean,
  timedOut: Schema.Boolean,
  timeSpentMs: Schema.NullOr(Schema.Int),
  bookmarked: Schema.Boolean
}) {}

export const PracticeState = Schema.Literals(["active", "paused", "finished"])

// How a set ended: the Learner finished it, or its time ran out.
export const EndedBy = Schema.Literals(["finished", "time"])

// A timed set's clock, as the server counts it.
export class PracticeClock extends Schema.Class<PracticeClock>("gmat-prep/api/PracticeClock")({
  limitMs: Schema.Int,
  elapsedMs: Schema.Int,
  remainingMs: Schema.Int,
  // Time lost to a stop or a sleeping computer, which was not counted.
  interrupted: Schema.Boolean
}) {}

export class PracticeView extends Schema.Class<PracticeView>("gmat-prep/api/PracticeView")({
  id: SessionId,
  title: Schema.String,
  timed: Schema.Boolean,
  status: PracticeState,
  // How many Questions the set holds.
  total: Schema.Int,
  // For similar Questions: how many were asked for.
  requested: Schema.NullOr(Schema.Int),
  // A book-order set's items it skips: unseen Mock Reserve Questions, and
  // items not in the Question Bank.
  heldForMocks: Schema.Array(ItemRef),
  unavailable: Schema.Array(ItemRef),
  // Each Question served so far, in order.
  results: Schema.Array(PracticeResult),
  // The Question on screen, the last one served, while the set is active.
  current: Schema.NullOr(ServedView),
  // The sequence number the next submit carries.
  nextSeq: Schema.Int,
  clock: Schema.NullOr(PracticeClock),
  // Whether this device holds the set; another device can take it over.
  heldHere: Schema.Boolean,
  endedBy: Schema.NullOr(EndedBy),
  createdAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number)
}) {}

export class PracticeSummary extends Schema.Class<PracticeSummary>("gmat-prep/api/PracticeSummary")({
  id: SessionId,
  title: Schema.String,
  timed: Schema.Boolean,
  status: PracticeState,
  total: Schema.Int,
  answered: Schema.Int,
  correct: Schema.Int,
  endedBy: Schema.NullOr(EndedBy),
  createdAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number)
}) {}

// A Section Score Estimate from the Profile's Rated Responses: uncalibrated
// until an Official Score is entered.
export class ScoreEstimateView extends Schema.Class<ScoreEstimateView>("gmat-prep/api/ScoreEstimateView")({
  section: Named,
  ratedResponses: Schema.Int,
  ability: Schema.Number,
  standardError: Schema.Number,
  score: Schema.Int,
  low: Schema.Int,
  high: Schema.Int,
  calibrated: Schema.Boolean
}) {}

export class PracticePreview extends Schema.Class<PracticePreview>("gmat-prep/api/PracticePreview")({
  // How many Questions the set would hold.
  questions: Schema.Int,
  // How many match, before the set size.
  matching: Schema.Int,
  heldForMocks: Schema.Int,
  unavailable: Schema.Int
}) {}

const Counted = Schema.Struct({ id: Schema.String, name: Schema.String, questions: Schema.Int })

// What a Profile can practise: per Section, its Question Types and Skills
// with how many Questions each has, and the Books with their sets.
export class PracticeOptions extends Schema.Class<PracticeOptions>("gmat-prep/api/PracticeOptions")({
  sections: Schema.Array(Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    questions: Schema.Int,
    questionTypes: Schema.Array(Counted),
    skills: Schema.Array(Counted)
  })),
  books: Schema.Array(Schema.Struct({
    id: BookId,
    title: Schema.String,
    sets: Schema.Array(Schema.Struct({
      name: Schema.String,
      first: Schema.Int,
      last: Schema.Int,
      questions: Schema.Int
    }))
  }))
}) {}

export class PracticeNotFound extends Schema.TaggedError<PracticeNotFound>()(
  "PracticeNotFound",
  {},
  { httpApiStatus: 404 }
) {}

export class QuestionNotFound extends Schema.TaggedError<QuestionNotFound>()(
  "QuestionNotFound",
  {},
  { httpApiStatus: 404 }
) {}

// Filters naming a Section, Question Type or Skill the Taxonomy does not
// have, or a Question Type outside the Section.
export class FiltersInvalid extends Schema.TaggedError<FiltersInvalid>()(
  "FiltersInvalid",
  { problems: Schema.Array(Schema.String) },
  { httpApiStatus: 422 }
) {}

export class NoQuestionsMatch extends Schema.TaggedError<NoQuestionsMatch>()(
  "NoQuestionsMatch",
  { heldForMocks: Schema.Int, unavailable: Schema.Int },
  { httpApiStatus: 409 }
) {}

// A selection that does not give one of the Question's options for each of
// its Parts.
export class SelectionInvalid extends Schema.TaggedError<SelectionInvalid>()(
  "SelectionInvalid",
  { problems: Schema.Array(Schema.String) },
  { httpApiStatus: 422 }
) {}

// A request that does not fit where the set stands: the Question was
// answered already, another Question is on screen, the one on screen is not
// answered yet, no Questions are left, or the set is over. It carries the
// set as it stands.
export class PracticeOutOfStep extends Schema.TaggedError<PracticeOutOfStep>()(
  "PracticeOutOfStep",
  {
    reason: Schema.Literals(["answered", "not-current", "not-answered", "no-more", "finished", "paused", "untimed"]),
    view: PracticeView
  },
  { httpApiStatus: 409 }
) {}

// Another device holds the set. This one sees it read-only until it takes
// it over.
export class HeldElsewhere extends Schema.TaggedError<HeldElsewhere>()(
  "HeldElsewhere",
  { view: PracticeView },
  { httpApiStatus: 409 }
) {}

const setParams = { params: { id: SessionId } }

export class PracticeApi extends HttpApiGroup.make("practice")
  .add(
    HttpApiEndpoint.get("options", "/options", { success: PracticeOptions }),
    // How many Questions a set would hold, without starting it.
    HttpApiEndpoint.post("preview", "/preview", {
      payload: Schema.Struct({ choice: PracticeChoice }),
      success: PracticePreview,
      error: [FiltersInvalid, BookNotFound]
    }),
    // Starts a set, held by this device, and serves its first Question.
    HttpApiEndpoint.post("start", "/sets", {
      payload: Schema.Struct({ choice: PracticeChoice }),
      success: PracticeView,
      error: [FiltersInvalid, BookNotFound, NoQuestionsMatch]
    }),
    // The Profile's sets, those in progress first, then the latest.
    HttpApiEndpoint.get("list", "/sets", { success: Schema.Array(PracticeSummary) }),
    HttpApiEndpoint.get("get", "/sets/:id", { ...setParams, success: PracticeView, error: PracticeNotFound }),
    // Records a Response to the Question on screen. A submit sent again with
    // the same sequence number is recorded once. In a timed set the next
    // Question is served at once, and the last one ends the set.
    HttpApiEndpoint.post("answer", "/sets/:id/answer", {
      ...setParams,
      payload: Schema.Struct({
        seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
        questionId: QuestionId,
        selection: Selection,
        guessed: Schema.Boolean
      }),
      success: PracticeView,
      error: [PracticeNotFound, PracticeOutOfStep, SelectionInvalid, HeldElsewhere]
    }),
    // Serves the Question at a position, once the one before it is answered.
    // Asking again for a position already served changes nothing.
    HttpApiEndpoint.post("next", "/sets/:id/next", {
      ...setParams,
      payload: Schema.Struct({ position: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
      success: PracticeView,
      error: [PracticeNotFound, PracticeOutOfStep, HeldElsewhere]
    }),
    HttpApiEndpoint.post("bookmark", "/sets/:id/bookmark", {
      ...setParams,
      payload: Schema.Struct({ questionId: QuestionId, bookmarked: Schema.Boolean }),
      success: PracticeView,
      error: [PracticeNotFound, PracticeOutOfStep, HeldElsewhere]
    }),
    HttpApiEndpoint.post("finish", "/sets/:id/finish", {
      ...setParams,
      success: PracticeView,
      error: [PracticeNotFound, HeldElsewhere]
    }),
    // A timed set's clock stops while it is paused, and the Question is hidden.
    HttpApiEndpoint.post("pause", "/sets/:id/pause", {
      ...setParams,
      success: PracticeView,
      error: [PracticeNotFound, PracticeOutOfStep, HeldElsewhere]
    }),
    HttpApiEndpoint.post("resume", "/sets/:id/resume", {
      ...setParams,
      success: PracticeView,
      error: [PracticeNotFound, PracticeOutOfStep, HeldElsewhere]
    }),
    // This device takes the set over; the one that held it turns read-only.
    HttpApiEndpoint.post("claim", "/sets/:id/claim", { ...setParams, success: PracticeView, error: PracticeNotFound }),
    // The Profile's Section Score Estimates.
    HttpApiEndpoint.get("scores", "/scores", { success: Schema.Array(ScoreEstimateView) }),
    // A served Question with its Response and Debrief, once answered or once
    // the set is over.
    HttpApiEndpoint.get("review", "/sets/:id/review/:position", {
      params: {
        id: SessionId,
        position: Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
      },
      success: ServedView,
      error: [PracticeNotFound, PracticeOutOfStep]
    }),
    // An untimed set of 3 unseen Questions with the Question's primary Skill
    // and Question Type and a Difficulty within 0.5 of its own.
    HttpApiEndpoint.post("similar", "/similar", {
      payload: Schema.Struct({ questionId: QuestionId }),
      success: PracticeView,
      error: [QuestionNotFound, NoQuestionsMatch]
    })
  )
  .middleware(ProfileSession)
  .prefix("/api/practice")
{}
