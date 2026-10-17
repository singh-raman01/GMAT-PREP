import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { ScoreEstimateView } from "./Practice.ts"
import { ProfileSession } from "./Profiles.ts"

// Official Scores: scores from official GMAT practice exams or real sittings,
// which calibrate a Profile's Score Estimates.

export const OfficialScoreKind = Schema.Literals(["practice-exam", "exam"])
export type OfficialScoreKind = typeof OfficialScoreKind.Type

export const OfficialScoreKindNames: Readonly<Record<OfficialScoreKind, string>> = {
  "practice-exam": "Official practice exam",
  exam: "GMAT exam"
}

const SectionScore = Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 90 }))
const TotalScore = Schema.Int.check(
  Schema.makeFilter((total: number) => total >= 205 && total <= 805 && total % 10 === 5, {
    description: "a Total from 205 to 805 that ends in 5"
  })
)
// A date that exists, as YYYY-MM-DD: some engines read 2026-02-30 as 2 March.
const isDay = (day: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const millis = Date.parse(`${day}T00:00:00Z`)
  return !Number.isNaN(millis) && new Date(millis).toISOString().slice(0, 10) === day
}

const Day = Schema.String.check(Schema.makeFilter(isDay, { description: "a date as YYYY-MM-DD" }))

export const OfficialScoreInput = Schema.Struct({
  takenOn: Day,
  kind: OfficialScoreKind,
  total: TotalScore,
  quant: SectionScore,
  verbal: SectionScore,
  di: SectionScore
})
export type OfficialScoreInput = typeof OfficialScoreInput.Type

export class OfficialScoreView extends Schema.Class<OfficialScoreView>("gmat-prep/api/OfficialScoreView")({
  id: Schema.String,
  takenOn: Schema.String,
  kind: OfficialScoreKind,
  total: Schema.Int,
  quant: Schema.Int,
  verbal: Schema.Int,
  di: Schema.Int,
  // The Sections whose score line it helps fit: those with a Score Estimate
  // on or before the day it was taken.
  calibrates: Schema.Array(Schema.String),
  createdAt: Schema.Number
}) {}

export class OfficialScoreNotFound extends Schema.TaggedError<OfficialScoreNotFound>()(
  "OfficialScoreNotFound",
  {},
  { httpApiStatus: 404 }
) {}

// A date still to come cannot have a score.
export class OfficialScoreInFuture extends Schema.TaggedError<OfficialScoreInFuture>()(
  "OfficialScoreInFuture",
  {},
  { httpApiStatus: 422 }
) {}

// The Total with its range, once all three Sections have a Score Estimate.
export class TotalScoreView extends Schema.Class<TotalScoreView>("gmat-prep/api/TotalScoreView")({
  score: Schema.Int,
  low: Schema.Int,
  high: Schema.Int,
  // Every Section's line is calibrated by an Official Score.
  calibrated: Schema.Boolean
}) {}

export class ScoreEstimates extends Schema.Class<ScoreEstimates>("gmat-prep/api/ScoreEstimates")({
  sections: Schema.Array(ScoreEstimateView),
  total: Schema.NullOr(TotalScoreView),
  // Today in the Profile's time zone: the latest day an Official Score can
  // be dated, and the date its form starts with.
  today: Day
}) {}

export class ScoresApi extends HttpApiGroup.make("scores")
  .add(
    // Each Section's Score Estimate now, and the Total once all three have one.
    HttpApiEndpoint.get("estimates", "/estimates", { success: ScoreEstimates }),
    // The Profile's Official Scores, the latest first.
    HttpApiEndpoint.get("official", "/official", { success: Schema.Array(OfficialScoreView) }),
    HttpApiEndpoint.post("addOfficial", "/official", {
      payload: OfficialScoreInput,
      success: Schema.Array(OfficialScoreView),
      error: OfficialScoreInFuture
    }),
    HttpApiEndpoint.delete("removeOfficial", "/official/:id", {
      params: { id: Schema.String },
      success: Schema.Array(OfficialScoreView),
      error: OfficialScoreNotFound
    })
  )
  .middleware(ProfileSession)
  .prefix("/api/scores")
{}
