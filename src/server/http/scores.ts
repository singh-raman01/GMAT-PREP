import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../api/Api.ts"
import { CurrentProfile } from "../../api/Profiles.ts"
import { OfficialScores } from "../ratings/OfficialScores.ts"

export const ScoresHandlers = HttpApiBuilder.group(
  Api,
  "scores",
  Effect.fn(function*(handlers) {
    const scores = yield* OfficialScores
    const profile = Effect.map(CurrentProfile, (current) => current.id)
    return handlers.handleAll({
      official: () => profile.pipe(Effect.flatMap(scores.list)),
      addOfficial: ({ payload }) => profile.pipe(Effect.flatMap((id) => scores.add(id, payload))),
      removeOfficial: ({ params }) => profile.pipe(Effect.flatMap((id) => scores.remove(id, params.id)))
    })
  })
)
