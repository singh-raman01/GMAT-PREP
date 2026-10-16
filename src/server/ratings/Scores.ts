import { and, desc, eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer } from "effect"
import {
  type OfficialScoreInput,
  OfficialScoreInFuture,
  type OfficialScoreKind,
  OfficialScoreNotFound,
  OfficialScoreView,
  ScoreEstimates,
  TotalScoreView
} from "../../api/Scores.ts"
import { studyDayOf } from "../../api/studyDay.ts"
import { Db } from "../db/Database.ts"
import { officialScores, profiles } from "../db/schema.ts"
import { namesOf } from "../practice/content.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { scoreEstimatesOf, scoreEstimateView } from "./estimates.ts"
import { calibrationOf, dayNumber } from "./OfficialScores.ts"

const viewOf = (used: ReadonlyMap<string, ReadonlyArray<string>>) => (row: typeof officialScores.$inferSelect) =>
  new OfficialScoreView({
    id: row.id,
    takenOn: row.takenOn,
    kind: row.kind as OfficialScoreKind,
    total: row.total,
    quant: row.quant,
    verbal: row.verbal,
    di: row.di,
    calibrates: used.get(row.id) ?? [],
    createdAt: row.createdAt
  })

// A Profile's Official Scores, and its Score Estimates on the lines they
// calibrate.
export class Scores extends Context.Service<Scores, {
  estimates(profileId: string): Effect.Effect<ScoreEstimates>
  list(profileId: string): Effect.Effect<ReadonlyArray<OfficialScoreView>>
  add(profileId: string, input: OfficialScoreInput): Effect.Effect<ReadonlyArray<OfficialScoreView>, OfficialScoreInFuture>
  remove(profileId: string, id: string): Effect.Effect<ReadonlyArray<OfficialScoreView>, OfficialScoreNotFound>
}>()("gmat-prep/server/Scores") {
  static readonly layer = Layer.effect(
    Scores,
    Effect.gen(function*() {
      const db = yield* Db
      const names = namesOf((yield* Taxonomy).view)

      const estimates = (profileId: string) =>
        scoreEstimatesOf(profileId).pipe(
          Effect.provideService(Db, db),
          Effect.orDie,
          Effect.map((found) =>
            new ScoreEstimates({
              sections: found.sections.map(scoreEstimateView((id) => names.named(id))),
              total: found.total === null ? null : new TotalScoreView(found.total)
            })
          )
        )

      const list = (profileId: string) =>
        Effect.gen(function*() {
          const rows = yield* db.select().from(officialScores).where(eq(officialScores.profileId, profileId))
            .orderBy(desc(officialScores.takenOn), desc(officialScores.createdAt)).pipe(Effect.orDie)
          const { used } = yield* calibrationOf(profileId).pipe(Effect.provideService(Db, db), Effect.orDie)
          return rows.map(viewOf(used))
        })

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

      return Scores.of({ estimates, list, add, remove })
    })
  )
}
