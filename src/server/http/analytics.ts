import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../api/Api.ts"
import { CurrentProfile } from "../../api/Profiles.ts"
import { Analytics } from "../analytics/Analytics.ts"

// Each view reads the signed-in Profile's facts only.
export const AnalyticsHandlers = HttpApiBuilder.group(
  Api,
  "analytics",
  Effect.fn(function*(handlers) {
    const analytics = yield* Analytics
    const profile = CurrentProfile.pipe(Effect.map((current) => current.id))
    return handlers.handleAll({
      weakAreas: () => profile.pipe(Effect.flatMap(analytics.weakAreas)),
      skillMap: () => profile.pipe(Effect.flatMap(analytics.skillMap)),
      timing: () => profile.pipe(Effect.flatMap(analytics.timing)),
      mistakes: () => profile.pipe(Effect.flatMap(analytics.mistakes)),
      study: () => profile.pipe(Effect.flatMap(analytics.study))
    })
  })
)
