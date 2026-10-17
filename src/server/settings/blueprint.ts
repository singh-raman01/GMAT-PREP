import { eq } from "drizzle-orm"
import { Clock, Effect, Option, Schema } from "effect"
import { Blueprint, DefaultBlueprint } from "../../api/blueprint.ts"
import { Db } from "../db/Database.ts"
import { settings } from "../db/schema.ts"

// Where the Section Blueprint the Curator set is kept. The app server and
// the job worker both read it here: the Mock Reserve takes only units that
// fit a slot.

const BlueprintKey = "section-blueprint"
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Blueprint))

// The Blueprint as set, or the defaults when it was never set or cannot be
// read.
export const loadBlueprint = Effect.gen(function*() {
  const db = yield* Db
  const [row] = yield* db.select().from(settings).where(eq(settings.key, BlueprintKey))
  if (row === undefined) return DefaultBlueprint
  return Option.getOrElse(decode(row.value), () => DefaultBlueprint)
})

export const storeBlueprint = (blueprint: Blueprint) =>
  Effect.gen(function*() {
    const db = yield* Db
    const value = JSON.stringify(blueprint)
    const updatedAt = yield* Clock.currentTimeMillis
    yield* db.insert(settings)
      .values({ key: BlueprintKey, value, updatedAt })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } })
  })
