import { Effect } from "effect"
import { type Named, ScoreEstimateView } from "../../api/Practice.ts"
import type { AbilityFit } from "./model.ts"
import { ratedCounts, ratedHistory, sectionFit } from "./history.ts"
import { scoreLinesOf } from "./OfficialScores.ts"
import { studyClockOf } from "./rateSession.ts"
import { type ScoreLine, sectionEstimateOn, type SectionScoreEstimate, totalEstimate, type TotalEstimate } from "./scale.ts"

// The Profile's Score Estimates as they stand now (docs/design.md, "Ratings
// and scores"): each Section's from the Rated Responses of the Sessions that
// have ended, on the Section's current score line, and the Total once all
// three Sections have one.

export interface SectionEstimate {
  readonly section: string
  readonly ratedResponses: number
  readonly fit: AbilityFit
  readonly estimate: SectionScoreEstimate
}

const TotalOrder = ["quant", "verbal", "di"] as const

export const scoreEstimatesOf = (profileId: string) =>
  Effect.gen(function*() {
    const clock = yield* studyClockOf(profileId)
    if (clock === undefined) return { sections: [] as ReadonlyArray<SectionEstimate>, total: null }
    const history = (yield* ratedHistory(profileId)).filter((each) => each.ended)
    const counts = ratedCounts(history)
    const lines = yield* scoreLinesOf(profileId)
    const sections = TotalOrder.filter((section) => counts.has(section)).map((section): SectionEstimate & {
      readonly line: ScoreLine
    } => {
      const fit = sectionFit(history, section, clock)
      return {
        section,
        ratedResponses: counts.get(section)!,
        fit,
        estimate: sectionEstimateOn(lines[section], fit),
        line: lines[section]
      }
    })
    const total: TotalEstimate | null = sections.length < TotalOrder.length ? null : totalEstimate(
      sections.map((each) => ({ score: each.estimate.score, standardError: each.fit.standardError, line: each.line })) as [
        { score: number; standardError: number; line: ScoreLine },
        { score: number; standardError: number; line: ScoreLine },
        { score: number; standardError: number; line: ScoreLine }
      ]
    )
    return { sections: sections as ReadonlyArray<SectionEstimate>, total }
  })

// As the API gives it, with the Section's name.
export const scoreEstimateView = (named: (id: string) => Named) => (each: SectionEstimate) =>
  new ScoreEstimateView({
    section: named(each.section),
    ratedResponses: each.ratedResponses,
    ability: each.fit.ability,
    standardError: each.fit.standardError,
    score: each.estimate.score,
    low: each.estimate.low,
    high: each.estimate.high,
    calibrated: each.estimate.calibrated
  })
