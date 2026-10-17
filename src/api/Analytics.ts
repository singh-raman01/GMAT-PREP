import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Day } from "./day.ts"
import { Named, PracticeChoice, SessionId } from "./Practice.ts"
import { ProfileSession } from "./Profiles.ts"

// The Learner's analytics (docs/design.md, "Analytics"): Weak Areas, the
// Skill map, Timing, Mistakes and Study. Score trend lives with the Scores,
// the Mock report with the Mocks and the Error Log on its own page.

export const ScopeKind = Schema.Literals(["skill", "questionType"])
export type ScopeKind = typeof ScopeKind.Type

// A Skill's or Question Type's Ability against its reference.
export class ScopeView extends Schema.Class<ScopeView>("gmat-prep/api/ScopeView")({
  kind: ScopeKind,
  scope: Named,
  // The Section most of its Rated Responses came from.
  section: Named,
  // Rated Responses carrying it; under 8 is not enough data.
  evidence: Schema.Int,
  enough: Schema.Boolean,
  ability: Schema.Number,
  standardError: Schema.Number,
  reference: Schema.Number,
  // The reference less the Ability: above 0, it lags its Section.
  gap: Schema.Number,
  // The median time over Target Time of its correct Rated Responses.
  pace: Schema.NullOr(Schema.Number),
  slow: Schema.Boolean
}) {}

const Counted = Schema.Struct({ kind: Named, count: Schema.Int })

export class WeakAreaView extends Schema.Class<WeakAreaView>("gmat-prep/api/WeakAreaView")({
  ability: ScopeView,
  // Its share of the exam, and the gap times it.
  frequency: Schema.Number,
  priority: Schema.Number,
  // Its misses' Mistake Types, Slow and Guessed among them, the most first.
  mix: Schema.Array(Counted),
  // The Practice Set its button starts.
  remedy: Schema.Struct({ timed: Schema.Boolean, choice: PracticeChoice })
}) {}

export class WeakAreasView extends Schema.Class<WeakAreasView>("gmat-prep/api/WeakAreasView")({
  areas: Schema.Array(WeakAreaView),
  // Where exam frequency came from: Books marked official, or the whole
  // Question Bank until one is published.
  frequencyBasis: Schema.Literals(["official", "bank"]),
  ratedResponses: Schema.Int,
  // Skills and Question Types answered but still under 8 Rated Responses.
  thin: Schema.Int
}) {}

export class SkillMapView extends Schema.Class<SkillMapView>("gmat-prep/api/SkillMapView")({
  sections: Schema.Array(Schema.Struct({
    section: Named,
    // Null before its first Rated Response.
    ability: Schema.NullOr(Schema.Number),
    topics: Schema.Array(Schema.Struct({
      topic: Named,
      skills: Schema.Array(Schema.Struct({ skill: Named, scope: Schema.NullOr(ScopeView) }))
    })),
    questionTypes: Schema.Array(Schema.Struct({ questionType: Named, scope: Schema.NullOr(ScopeView) }))
  }))
}) {}

const Pace = Schema.Struct({ median: Schema.Number, answers: Schema.Int })
const Accuracy = Schema.Struct({ right: Schema.Int, answered: Schema.Int })

export class PacingPointView extends Schema.Class<PacingPointView>("gmat-prep/api/PacingPointView")({
  question: Schema.Int,
  usedMs: Schema.Int,
  evenMs: Schema.Int
}) {}

export class TimingView extends Schema.Class<TimingView>("gmat-prep/api/TimingView")({
  // Time over Target Time on first answers in timed Sessions.
  questionTypes: Schema.Array(Schema.Struct({ questionType: Named, pace: Pace })),
  // The same, by the Strategy of each Question's fastest Approach.
  strategies: Schema.Array(Schema.Struct({ strategy: Named, pace: Pace })),
  // Sectionals and Mock Sections: the last 5 Questions against the rest.
  ending: Schema.Struct({ last: Accuracy, rest: Accuracy }),
  // Each finished Mock's pacing, Section by Section, the latest first.
  mocks: Schema.Array(Schema.Struct({
    mockId: SessionId,
    finishedAt: Schema.Number,
    sections: Schema.Array(Schema.Struct({
      section: Named,
      limitMs: Schema.Int,
      questions: Schema.Int,
      points: Schema.Array(PacingPointView)
    }))
  }))
}) {}

const Rate = Schema.Struct({ kind: Named, per100: Schema.Number })

export class MistakeTrendView extends Schema.Class<MistakeTrendView>("gmat-prep/api/MistakeTrendView")({
  // 7 Study Days at a time, the oldest first, from the first week with an
  // answer to this one.
  weeks: Schema.Array(Schema.Struct({
    from: Day,
    to: Day,
    questions: Schema.Int,
    mistakeTypes: Schema.Array(Rate),
    trapPatterns: Schema.Array(Rate)
  }))
}) {}

export class StudyView extends Schema.Class<StudyView>("gmat-prep/api/StudyView")({
  today: Day,
  // Each Study Day with work, the oldest first.
  days: Schema.Array(Schema.Struct({
    day: Day,
    minutes: Schema.Int,
    questions: Schema.Int,
    sections: Schema.Array(Schema.Struct({ section: Named, right: Schema.Int, answered: Schema.Int })),
    mocks: Schema.Int
  }))
}) {}

export class AnalyticsApi extends HttpApiGroup.make("analytics")
  .add(
    HttpApiEndpoint.get("weakAreas", "/weak-areas", { success: WeakAreasView }),
    HttpApiEndpoint.get("skillMap", "/skill-map", { success: SkillMapView }),
    HttpApiEndpoint.get("timing", "/timing", { success: TimingView }),
    HttpApiEndpoint.get("mistakes", "/mistakes", { success: MistakeTrendView }),
    HttpApiEndpoint.get("study", "/study", { success: StudyView })
  )
  .middleware(ProfileSession)
  .prefix("/api/analytics")
{}
