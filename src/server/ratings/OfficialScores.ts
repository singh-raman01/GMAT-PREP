import { asc, eq } from "drizzle-orm"
import { Effect } from "effect"
import type { BlueprintSection } from "../../api/blueprint.ts"
import { studyDayOf } from "../../api/studyDay.ts"
import { Db } from "../db/Database.ts"
import { officialScores, profiles, scoreEstimates } from "../db/schema.ts"
import { calibratedLine, type ScoreLine } from "./scale.ts"

// The score lines Official Scores calibrate (docs/design.md, "Ratings and
// scores").

export const DayMs = 24 * 60 * 60 * 1000

// A score line for each Section.
export type ScoreLines = Readonly<Record<BlueprintSection, ScoreLine>>

export const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DayMs

// Each Section's score line for a Profile. An Official Score is paired with
// the Section Ability as it stood at the end of the day it was taken, in the
// Profile's time zone: the latest Score Estimate by then. One taken before
// any Score Estimate for the Section says nothing about the Profile's line,
// so it is left out there.
export const scoreLinesOf = (profileId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const official = yield* db.select().from(officialScores).where(eq(officialScores.profileId, profileId))
    const [profile] = official.length === 0 ? [] : yield* db.select({ timeZone: profiles.timeZone }).from(profiles)
      .where(eq(profiles.id, profileId))
    const estimates = profile === undefined ? [] : yield* db.select({
      section: scoreEstimates.section,
      at: scoreEstimates.at,
      ability: scoreEstimates.ability
    }).from(scoreEstimates).where(eq(scoreEstimates.profileId, profileId)).orderBy(asc(scoreEstimates.at))
    const dated = estimates.map((estimate) => ({ ...estimate, day: studyDayOf(estimate.at, profile!.timeZone, 0) }))
    const lineFor = (section: BlueprintSection) =>
      calibratedLine(official.flatMap((score) => {
        const before = dated.filter((estimate) => estimate.section === section && estimate.day <= dayNumber(score.takenOn))
          .at(-1)
        return before === undefined ? [] : [{ ability: before.ability, score: score[section] }]
      }))
    return { quant: lineFor("quant"), verbal: lineFor("verbal"), di: lineFor("di") } satisfies ScoreLines
  })
