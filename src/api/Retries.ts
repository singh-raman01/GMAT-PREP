import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Day } from "./day.ts"
import { ErrorReason } from "./ErrorLog.ts"
import { Named, PracticeView, SessionId } from "./Practice.ts"
import { ProfileSession } from "./Profiles.ts"
import { QuestionId } from "./Review.ts"

// Retries: the Retry Ladder steps due, and the sets that take them.

export class RetryDue extends Schema.Class<RetryDue>("gmat-prep/api/RetryDue")({
  // The Error Log entry, by its Question.
  questionId: QuestionId,
  step: Schema.Int,
  questionType: Named,
  primarySkill: Schema.NullOr(Named),
  // Why the entry is in the Error Log, as its ladder began.
  reasons: Schema.Array(ErrorReason),
  // Step 1 of a wrong or guessed entry is untimed; the rest are timed.
  timed: Schema.Boolean,
  // The Study Day it fell due.
  dueOn: Day,
  // Step 1 waits while a running Sectional or Mock holds its Question.
  held: Schema.Boolean
}) {}

export class RetriesView extends Schema.Class<RetriesView>("gmat-prep/api/RetriesView")({
  // Due today or before, the longest waiting first.
  due: Schema.Array(RetryDue),
  // How many fall due on each of the next 7 Study Days.
  upcoming: Schema.Array(Schema.Struct({ day: Day, steps: Schema.Int })),
  // A retry set not finished yet, to go back to.
  running: Schema.NullOr(SessionId)
}) {}

// Nothing to serve with that timing: none was due, or each step due was a
// Sibling step with no Sibling left, skipped now with a note, or a Question a
// running Sectional or Mock holds.
export class NoRetriesDue extends Schema.TaggedError<NoRetriesDue>()(
  "NoRetriesDue",
  { skipped: Schema.Int, held: Schema.Int },
  { httpApiStatus: 409 }
) {}

// A retry set is running; it is the one to go back to.
export class RetriesRunning extends Schema.TaggedError<RetriesRunning>()(
  "RetriesRunning",
  { id: SessionId },
  { httpApiStatus: 409 }
) {}

export class RetriesApi extends HttpApiGroup.make("retries")
  .add(
    HttpApiEndpoint.get("due", "/", { success: RetriesView }),
    // Starts a set of the steps due, untimed or timed. Sibling steps pick
    // their Siblings now; one with none left is skipped with a note.
    HttpApiEndpoint.post("start", "/start", {
      payload: Schema.Struct({ timed: Schema.Boolean }),
      success: PracticeView,
      error: [NoRetriesDue, RetriesRunning]
    })
  )
  .middleware(ProfileSession)
  .prefix("/api/retries")
{}
