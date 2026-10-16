import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Named, SessionId } from "./Practice.ts"
import { ProfileSession } from "./Profiles.ts"
import { TotalScoreView } from "./Scores.ts"
import { MockRunning, SectionalReport, SectionalRunning, SectionReadiness } from "./Sectionals.ts"

// Mocks: the whole exam. Its three Sections run as Sectionals do, in the
// order the Learner chooses, with one optional 10-minute break after the
// first or second.

export const BreakMinutes = 10

export class MockOptions extends Schema.Class<MockOptions>("gmat-prep/api/MockOptions")({
  // Each Section's start check; a Mock needs all three to pass.
  sections: Schema.Array(SectionReadiness),
  ready: Schema.Boolean,
  sectionMinutes: Schema.Int,
  breakMinutes: Schema.Int,
  // The Mock this Profile has running, if any.
  running: Schema.NullOr(SessionId),
  // The Sectional this Profile has running, if any: no Mock starts until it ends.
  sectional: Schema.NullOr(SessionId)
}) {}

export const MockStage = Schema.Literals(["section", "break", "finished"])
export type MockStage = typeof MockStage.Type

export class MockSectionView extends Schema.Class<MockSectionView>("gmat-prep/api/MockSectionView")({
  section: Named,
  // Its place in the Mock's order, from 1.
  place: Schema.Int,
  // Its own Session, once it has started.
  sessionId: Schema.NullOr(SessionId),
  status: Schema.Literals(["waiting", "running", "closed"]),
  // Time was lost to a stop while it ran.
  interrupted: Schema.Boolean
}) {}

export class MockBreak extends Schema.Class<MockBreak>("gmat-prep/api/MockBreak")({
  // The Section it comes after, from 1.
  after: Schema.Int,
  remainingMs: Schema.Int,
  // Going on now keeps the break for after Section 2.
  keepsBreak: Schema.Boolean
}) {}

export class MockSectionReport extends Schema.Class<MockSectionReport>("gmat-prep/api/MockSectionReport")({
  section: Named,
  sessionId: SessionId,
  report: SectionalReport,
  interrupted: Schema.Boolean
}) {}

export class MockReport extends Schema.Class<MockReport>("gmat-prep/api/MockReport")({
  total: TotalScoreView,
  // In the order taken.
  sections: Schema.Array(MockSectionReport),
  // Sections that lost time to a stop.
  interruptions: Schema.Int,
  repeats: Schema.Int,
  // Of the repeats, those a Paper Mark had made Seen.
  paperRepeats: Schema.Int,
  // A key changed since, and the scores follow it.
  rescored: Schema.Boolean
}) {}

export class MockView extends Schema.Class<MockView>("gmat-prep/api/MockView")({
  id: SessionId,
  stage: MockStage,
  sections: Schema.Array(MockSectionView),
  // While a Section runs, its place, from 1.
  current: Schema.NullOr(Schema.Int),
  break: Schema.NullOr(MockBreak),
  // The Section the break came after, once taken.
  breakAfter: Schema.NullOr(Schema.Int),
  // This device holds the Mock; another sees it read-only.
  heldHere: Schema.Boolean,
  report: Schema.NullOr(MockReport),
  createdAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number)
}) {}

export class MockSummary extends Schema.Class<MockSummary>("gmat-prep/api/MockSummary")({
  id: SessionId,
  order: Schema.Array(Named),
  finished: Schema.Boolean,
  total: Schema.NullOr(TotalScoreView),
  rescored: Schema.Boolean,
  createdAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number)
}) {}

export class MockNotFound extends Schema.TaggedError<MockNotFound>()("MockNotFound", {}, { httpApiStatus: 404 }) {}

// An order that does not name each Section once.
export class MockOrderInvalid extends Schema.TaggedError<MockOrderInvalid>()(
  "MockOrderInvalid",
  { problems: Schema.Array(Schema.String) },
  { httpApiStatus: 422 }
) {}

// The Mock Reserve does not hold enough unseen Questions for every Section.
export class MockReserveTooSmall extends Schema.TaggedError<MockReserveTooSmall>()(
  "MockReserveTooSmall",
  { sections: Schema.Array(SectionReadiness) },
  { httpApiStatus: 409 }
) {}

// A request that does not fit where the Mock stands, with the Mock as it
// stands: there is no break to go on from, or the Mock is over.
export class MockOutOfStep extends Schema.TaggedError<MockOutOfStep>()(
  "MockOutOfStep",
  { reason: Schema.Literals(["not-on-break", "finished"]), view: MockView },
  { httpApiStatus: 409 }
) {}

export class MockHeldElsewhere extends Schema.TaggedError<MockHeldElsewhere>()(
  "MockHeldElsewhere",
  { view: MockView },
  { httpApiStatus: 409 }
) {}

const params = { params: { id: SessionId } }

export class MocksApi extends HttpApiGroup.make("mocks")
  .add(
    HttpApiEndpoint.get("options", "/options", { success: MockOptions }),
    // Starts a Mock in the order given, held by this device, with its first
    // Section running.
    HttpApiEndpoint.post("start", "/", {
      payload: Schema.Struct({ order: Schema.Array(Schema.String) }),
      success: MockView,
      error: [MockOrderInvalid, MockReserveTooSmall, SectionalRunning, MockRunning]
    }),
    // The Profile's Mocks, the latest first.
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(MockSummary) }),
    HttpApiEndpoint.get("get", "/:id", { ...params, success: MockView, error: MockNotFound }),
    // Ends the break, or skips it, and starts the next Section.
    HttpApiEndpoint.post("goOn", "/:id/go-on", {
      ...params,
      success: MockView,
      error: [MockNotFound, MockOutOfStep, MockHeldElsewhere]
    }),
    // This device takes the Mock over, with the Section running.
    HttpApiEndpoint.post("claim", "/:id/claim", { ...params, success: MockView, error: MockNotFound })
  )
  .middleware(ProfileSession)
  .prefix("/api/mocks")
{}
