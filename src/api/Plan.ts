import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { BookNotFound } from "./Books.ts"
import { Day } from "./day.ts"
import { MockOrderInvalid, MockReserveTooSmall } from "./Mocks.ts"
import { FiltersInvalid, Named, NoQuestionsMatch, SessionId } from "./Practice.ts"
import { InvalidTimeZone, ProfileSession } from "./Profiles.ts"
import { NoRetriesDue, RetriesRunning } from "./Retries.ts"
import { MockRunning, ReserveTooSmall, SectionalRunning, UnknownSection } from "./Sectionals.ts"

// The Study Plan and the Daily Log (docs/design.md, "Study Plan, Diagnostic
// and Daily Log", decisions 81 to 92).

export const PlanItemId = Schema.String.pipe(Schema.brand("PlanItemId"))
export type PlanItemId = typeof PlanItemId.Type

// Weekly study time, in minutes: 1 to 60 hours.
export const WeeklyMinutes = { minimum: 60, maximum: 3600 } as const
const Weekday = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))

export const PlanSettingsInput = Schema.Struct({
  testDate: Schema.NullOr(Day),
  targetTotal: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 205, maximum: 805 }))),
  weeklyMinutes: Schema.Int.check(Schema.isBetween(WeeklyMinutes)),
  // The weekdays with no study, 0 for Sunday; one at least stays a study day.
  daysOff: Schema.Array(Weekday).check(Schema.isMaxLength(7)),
  timeZone: Schema.String,
  rolloverHour: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 }))
})
export type PlanSettingsInput = typeof PlanSettingsInput.Type

export class PlanSettingsView extends Schema.Class<PlanSettingsView>("gmat-prep/api/PlanSettingsView")({
  testDate: Schema.NullOr(Day),
  targetTotal: Schema.NullOr(Schema.Int),
  weeklyMinutes: Schema.Int,
  daysOff: Schema.Array(Schema.Int),
  diagnosticSkipped: Schema.Boolean
}) {}

// The Profile's time zone and rollover hour now, and a change waiting for
// the next rollover (decision 92).
export class DaySettingsView extends Schema.Class<DaySettingsView>("gmat-prep/api/DaySettingsView")({
  timeZone: Schema.String,
  rolloverHour: Schema.Int,
  pending: Schema.NullOr(Schema.Struct({ timeZone: Schema.String, rolloverHour: Schema.Int, from: Schema.Number }))
}) {}

export const PlanItemStatus = Schema.Literals(["planned", "started", "done", "dropped"])

export class PlanItemView extends Schema.Class<PlanItemView>("gmat-prep/api/PlanItemView")({
  id: PlanItemId,
  day: Day,
  kind: Schema.Literals(["mock", "sectional", "retries", "practice"]),
  diagnostic: Schema.Boolean,
  // What it is, in words: "Percents, 10 Questions, untimed".
  title: Schema.String,
  timed: Schema.Boolean,
  section: Schema.NullOr(Named),
  // How many Questions: a set's size, or the Retries.
  questions: Schema.NullOr(Schema.Int),
  weakArea: Schema.NullOr(Schema.Struct({ kind: Schema.Literals(["skill", "questionType"]), scope: Named, priority: Schema.Number })),
  // What it remedies: a Mistake Type, or Slow.
  remedy: Schema.NullOr(Named),
  minutes: Schema.Int,
  status: PlanItemStatus,
  // Why it was dropped.
  reason: Schema.NullOr(Schema.String),
  // The Session started from it, to go back to.
  sessionId: Schema.NullOr(SessionId)
}) {}

export class PlanDayView extends Schema.Class<PlanDayView>("gmat-prep/api/PlanDayView")({
  day: Day,
  off: Schema.Boolean,
  minutes: Schema.Int,
  phase: Schema.Literals(["diagnostic", "weak-areas", "mixed", "mocks"]),
  items: Schema.Array(PlanItemView)
}) {}

export class DiagnosticView extends Schema.Class<DiagnosticView>("gmat-prep/api/DiagnosticView")({
  state: Schema.Literals(["pending", "done", "skipped", "blocked"]),
  // A full Mock, or the three Sectionals when weekly time is under a Mock.
  form: Schema.Literals(["mock", "sectionals"]),
  // While it is three Sectionals, the Sections still to take.
  sectionsLeft: Schema.Array(Named)
}) {}

// The Section targets the target Total sets (decision 82), against each
// Section's Score Estimate.
export class TargetsView extends Schema.Class<TargetsView>("gmat-prep/api/TargetsView")({
  total: Schema.Int,
  sections: Schema.Array(Schema.Struct({ section: Named, target: Schema.Int, estimate: Schema.NullOr(Schema.Int) }))
}) {}

export class PlanView extends Schema.Class<PlanView>("gmat-prep/api/PlanView")({
  today: Day,
  // None until the Learner saves the plan's settings.
  settings: Schema.NullOr(PlanSettingsView),
  days: DaySettingsView,
  version: Schema.NullOr(Schema.Int),
  builtAt: Schema.NullOr(Schema.Number),
  // Today and the Study Days ahead.
  plan: Schema.Array(PlanDayView),
  dropped: Schema.Array(PlanItemView),
  notes: Schema.Array(Schema.String),
  diagnostic: DiagnosticView,
  targets: Schema.NullOr(TargetsView)
}) {}

// Where an item started: the Session to go to.
export class PlanStarted extends Schema.Class<PlanStarted>("gmat-prep/api/PlanStarted")({
  kind: Schema.Literals(["practice", "sectional", "mock"]),
  id: SessionId
}) {}

export class PlanSettingsInvalid extends Schema.TaggedError<PlanSettingsInvalid>()(
  "PlanSettingsInvalid",
  { problems: Schema.Array(Schema.String) },
  { httpApiStatus: 400 }
) {}

export class PlanItemNotFound extends Schema.TaggedError<PlanItemNotFound>()(
  "PlanItemNotFound",
  {},
  { httpApiStatus: 404 }
) {}

// The item is not one of today's planned ones: from another day or an older
// version of the plan, dropped, or done.
export class PlanItemNotOpen extends Schema.TaggedError<PlanItemNotOpen>()(
  "PlanItemNotOpen",
  { status: PlanItemStatus, day: Day, plan: PlanView },
  { httpApiStatus: 409 }
) {}

export class DailyLogDay extends Schema.Class<DailyLogDay>("gmat-prep/api/DailyLogDay")({
  day: Day,
  minutes: Schema.Int,
  questions: Schema.Int,
  sections: Schema.Array(Schema.Struct({ section: Named, right: Schema.Int, answered: Schema.Int })),
  mocks: Schema.Int,
  // The items planned for the day, as the plan stood when it ended (or
  // stands, for today), with which were done.
  items: Schema.Array(PlanItemView),
  note: Schema.NullOr(Schema.String)
}) {}

export class DailyLogView extends Schema.Class<DailyLogView>("gmat-prep/api/DailyLogView")({
  today: Day,
  // Today first, then each earlier Study Day with work, a plan or a note.
  days: Schema.Array(DailyLogDay)
}) {}

export const NoteText = Schema.String.check(Schema.isMaxLength(2000))

export class PlanApi extends HttpApiGroup.make("plan")
  .add(
    HttpApiEndpoint.get("view", "/", { success: PlanView }),
    HttpApiEndpoint.put("saveSettings", "/settings", {
      payload: PlanSettingsInput,
      success: PlanView,
      error: [PlanSettingsInvalid, InvalidTimeZone]
    }),
    HttpApiEndpoint.post("skipDiagnostic", "/diagnostic/skip", { success: PlanView }),
    // Starts one of today's items. A Mock takes its Sections' order.
    HttpApiEndpoint.post("start", "/items/:id/start", {
      params: { id: PlanItemId },
      payload: Schema.Struct({ order: Schema.optional(Schema.Array(Schema.String)) }),
      success: PlanStarted,
      error: [
        PlanItemNotFound,
        PlanItemNotOpen,
        FiltersInvalid,
        BookNotFound,
        NoQuestionsMatch,
        NoRetriesDue,
        RetriesRunning,
        UnknownSection,
        ReserveTooSmall,
        SectionalRunning,
        MockRunning,
        MockOrderInvalid,
        MockReserveTooSmall
      ]
    }),
    HttpApiEndpoint.get("dailyLog", "/daily-log", { success: DailyLogView }),
    HttpApiEndpoint.put("writeNote", "/daily-log/:day/note", {
      params: { day: Day },
      payload: Schema.Struct({ note: NoteText }),
      success: DailyLogDay
    })
  )
  .middleware(ProfileSession)
  .prefix("/api/plan")
{}
