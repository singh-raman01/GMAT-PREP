import { asc, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { DayRule } from "../../api/studyDay.ts"
import { Db } from "../db/Database.ts"
import { profileDays, profiles } from "../db/schema.ts"

// A Profile's day rules (decision 92): its own time zone and rollover hour
// from always, then each change from the rollover after it was made. Of two
// changes due at the same rollover, the later one holds. Undefined when the
// Profile is gone.
export const dayRulesOf = (profileId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const [profile] = yield* db.select({ timeZone: profiles.timeZone, rolloverHour: profiles.rolloverHour }).from(profiles)
      .where(eq(profiles.id, profileId)).pipe(Effect.orDie)
    if (profile === undefined) return undefined
    const changes = yield* db.select().from(profileDays).where(eq(profileDays.profileId, profileId))
      .orderBy(asc(profileDays.from), asc(profileDays.setAt), asc(sql`${profileDays}.rowid`)).pipe(Effect.orDie)
    const rules: Array<DayRule> = [{ from: Number.NEGATIVE_INFINITY, timeZone: profile.timeZone, rolloverHour: profile.rolloverHour }]
    for (const change of changes) {
      const rule: DayRule = { from: change.from, timeZone: change.timeZone, rolloverHour: change.rolloverHour }
      if (rules.at(-1)!.from === change.from) rules[rules.length - 1] = rule
      else rules.push(rule)
    }
    return rules as ReadonlyArray<DayRule>
  })

// The rules for a Profile that is gone, or none: UTC with the default
// rollover.
export const DefaultRules: ReadonlyArray<DayRule> = [{ from: Number.NEGATIVE_INFINITY, timeZone: "UTC", rolloverHour: 4 }]
