import { and, desc, eq, lt, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { BlueprintSection } from "../../api/blueprint.ts"
import { studyDayStart } from "../../api/studyDay.ts"
import { Db } from "../db/Database.ts"
import { officialScores, profiles, scoreEstimates } from "../db/schema.ts"
import { calibratedLine, type ScoreLine } from "./scale.ts"

// The score lines Official Scores calibrate (docs/design.md, "Ratings and
// scores").

export const DayMs = 24 * 60 * 60 * 1000

// A score line for each Section.
export type ScoreLines = Readonly<Record<BlueprintSection, ScoreLine>>

export const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DayMs

const Sections = ["quant", "verbal", "di"] as const satisfies ReadonlyArray<BlueprintSection>

// Each Section's score line for a Profile, and the Sections each Official
// Score helps fit. An Official Score is paired with the Section Ability as it
// stood at the end of the day it was taken, in the Profile's time zone: the
// latest Score Estimate by then, the last written among those of one moment.
// One taken before any Score Estimate for the Section says nothing about the
// Profile's line, so it is left out there.
export const calibrationOf = (profileId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const official = yield* db.select().from(officialScores).where(eq(officialScores.profileId, profileId))
    const [profile] = official.length === 0 ? [] : yield* db.select({ timeZone: profiles.timeZone }).from(profiles)
      .where(eq(profiles.id, profileId))
    const used = new Map<string, Array<BlueprintSection>>(official.map((score) => [score.id, []]))
    const points = new Map<BlueprintSection, Array<{ readonly ability: number; readonly score: number }>>(
      Sections.map((section) => [section, []])
    )
    for (const score of profile === undefined ? [] : official) {
      const dayEnds = studyDayStart(dayNumber(score.takenOn) + 1, profile!.timeZone, 0)
      for (const section of Sections) {
        const [before] = yield* db.select({ ability: scoreEstimates.ability }).from(scoreEstimates)
          .where(and(
            eq(scoreEstimates.profileId, profileId),
            eq(scoreEstimates.section, section),
            lt(scoreEstimates.at, dayEnds)
          ))
          .orderBy(desc(scoreEstimates.at), desc(sql`${scoreEstimates}.rowid`))
          .limit(1)
        if (before === undefined) continue
        used.get(score.id)!.push(section)
        points.get(section)!.push({ ability: before.ability, score: score[section] })
      }
    }
    const lines = Object.fromEntries(Sections.map((section) => [section, calibratedLine(points.get(section)!)])) as unknown as ScoreLines
    return { lines, used: used as ReadonlyMap<string, ReadonlyArray<BlueprintSection>> }
  })

export const scoreLinesOf = (profileId: string) => calibrationOf(profileId).pipe(Effect.map((found) => found.lines))
