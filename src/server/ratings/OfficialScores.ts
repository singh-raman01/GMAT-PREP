import { and, asc, desc, eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer } from "effect"
import {
  type OfficialScoreInput,
  OfficialScoreInFuture,
  type OfficialScoreKind,
  OfficialScoreNotFound,
  OfficialScoreView
} from "../../api/Scores.ts"
import type { BlueprintSection } from "../../api/blueprint.ts"
import { studyDayOf } from "../../api/studyDay.ts"
import { Db } from "../db/Database.ts"
import { officialScores, profiles, scoreEstimates } from "../db/schema.ts"
import { calibratedLine, type ScoreLine } from "./scale.ts"

// Official Scores, and the score lines they calibrate (docs/design.md,
// "Ratings and scores").

const DayMs = 24 * 60 * 60 * 1000

// A score line for each Section.
export type ScoreLines = Readonly<Record<BlueprintSection, ScoreLine>>

const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DayMs

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

const viewOf = (row: typeof officialScores.$inferSelect) =>
  new OfficialScoreView({
    id: row.id,
    takenOn: row.takenOn,
    kind: row.kind as OfficialScoreKind,
    total: row.total,
    quant: row.quant,
    verbal: row.verbal,
    di: row.di,
    createdAt: row.createdAt
  })

export class OfficialScores extends Context.Service<OfficialScores, {
  list(profileId: string): Effect.Effect<ReadonlyArray<OfficialScoreView>>
  add(profileId: string, input: OfficialScoreInput): Effect.Effect<ReadonlyArray<OfficialScoreView>, OfficialScoreInFuture>
  remove(profileId: string, id: string): Effect.Effect<ReadonlyArray<OfficialScoreView>, OfficialScoreNotFound>
}>()("gmat-prep/server/OfficialScores") {
  static readonly layer = Layer.effect(
    OfficialScores,
    Effect.gen(function*() {
      const db = yield* Db

      const list = (profileId: string) =>
        db.select().from(officialScores).where(eq(officialScores.profileId, profileId))
          .orderBy(desc(officialScores.takenOn), desc(officialScores.createdAt))
          .pipe(Effect.orDie, Effect.map((rows) => rows.map(viewOf)))

      // A score from a day still to come, in the Profile's own time zone, is
      // a mistake.
      const add = (profileId: string, input: OfficialScoreInput) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const [profile] = yield* db.select({ timeZone: profiles.timeZone }).from(profiles)
            .where(eq(profiles.id, profileId)).pipe(Effect.orDie)
          const today = studyDayOf(now, profile?.timeZone ?? "UTC", 0)
          if (dayNumber(input.takenOn) > today) return yield* new OfficialScoreInFuture()
          yield* db.insert(officialScores).values({
            id: crypto.randomUUID(),
            profileId,
            takenOn: input.takenOn,
            kind: input.kind,
            total: input.total,
            quant: input.quant,
            verbal: input.verbal,
            di: input.di,
            createdAt: now
          }).pipe(Effect.orDie)
          return yield* list(profileId)
        })

      const remove = (profileId: string, id: string) =>
        Effect.gen(function*() {
          const removed = yield* db.delete(officialScores)
            .where(and(eq(officialScores.id, id), eq(officialScores.profileId, profileId)))
            .returning({ id: officialScores.id }).pipe(Effect.orDie)
          if (removed.length === 0) return yield* new OfficialScoreNotFound()
          return yield* list(profileId)
        })

      return OfficialScores.of({ list, add, remove })
    })
  )
}
