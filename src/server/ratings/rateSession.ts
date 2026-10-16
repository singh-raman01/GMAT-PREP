import { eq } from "drizzle-orm"
import { Clock, Effect } from "effect"
import { Db } from "../db/Database.ts"
import { difficulty, profiles, scoreEstimates } from "../db/schema.ts"
import { ratedCounts, ratedHistory, sectionFit, type StudyClock } from "./history.ts"
import { nextDifficulty } from "./model.ts"
import { scoreLinesOf } from "./OfficialScores.ts"
import { type ScoreLine, sectionEstimateOn, UncalibratedLine } from "./scale.ts"

// The Profile's clock for Study Days: now, in its time zone and rollover
// hour. Undefined when the Profile is gone.
export const studyClockOf = (profileId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const [profile] = yield* db.select({ timeZone: profiles.timeZone, rolloverHour: profiles.rolloverHour })
      .from(profiles).where(eq(profiles.id, profileId))
    if (profile === undefined) return undefined
    const now = yield* Clock.currentTimeMillis
    return { now, timeZone: profile.timeZone, rolloverHour: profile.rolloverHour } satisfies StudyClock
  })

// A timed Session's Rated Responses, once it ends, each in turn: one moves
// its Question's Difficulty by the Profile's Section Ability before it, from
// the Sessions that ended earlier and the answers before it in this one, and
// gives the Section a new Score Estimate. Timed Practice Sets, Sectionals
// and Mock Sections all end this way.
export const rateSession = (session: { readonly id: string; readonly profileId: string }) =>
  Effect.gen(function*() {
    const db = yield* Db
    const clock = yield* studyClockOf(session.profileId)
    if (clock === undefined) return
    const history = yield* ratedHistory(session.profileId)
    const lines: Readonly<Record<string, ScoreLine>> = yield* scoreLinesOf(session.profileId)
    const mine = history.filter((each) => each.sessionId === session.id).toSorted((a, b) => a.seq - b.seq)
    let counted = history.filter((each) => each.ended && each.sessionId !== session.id)
    for (const rated of mine) {
      const before = sectionFit(counted, rated.section, clock)
      const [row] = yield* db.select().from(difficulty).where(eq(difficulty.questionId, rated.questionId))
      const earlier = row?.ratedResponses ?? 0
      const value = nextDifficulty(rated.difficulty, earlier, before.ability, rated.correct)
      yield* db.insert(difficulty).values({ questionId: rated.questionId, value, ratedResponses: earlier + 1 })
        .onConflictDoUpdate({ target: difficulty.questionId, set: { value, ratedResponses: earlier + 1 } })
      counted = [
        ...counted.map((each) => (each.questionId === rated.questionId ? { ...each, difficulty: value } : each)),
        { ...rated, difficulty: value }
      ]
      const fit = sectionFit(counted, rated.section, clock)
      const estimate = sectionEstimateOn(lines[rated.section] ?? UncalibratedLine, fit)
      yield* db.insert(scoreEstimates).values({
        id: crypto.randomUUID(),
        profileId: session.profileId,
        section: rated.section,
        at: clock.now,
        ability: fit.ability,
        standardError: fit.standardError,
        score: estimate.score,
        low: estimate.low,
        high: estimate.high,
        calibrated: estimate.calibrated,
        ratedResponses: ratedCounts(counted).get(rated.section) ?? 0
      })
    }
  })
