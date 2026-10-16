import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../api/Api.ts"
import { CurrentProfile } from "../../api/Profiles.ts"
import { ErrorLog } from "../learning/ErrorLog.ts"

export const ErrorLogHandlers = HttpApiBuilder.group(
  Api,
  "errorLog",
  Effect.fn(function*(handlers) {
    const errorLog = yield* ErrorLog
    const profile = Effect.map(CurrentProfile, (current) => current.id)
    return handlers.handleAll({
      list: ({ query }) => profile.pipe(Effect.flatMap((id) => errorLog.list(id, query))),
      get: ({ params }) => profile.pipe(Effect.flatMap((id) => errorLog.get(id, params.questionId))),
      setMistakeType: ({ params, payload }) =>
        profile.pipe(Effect.flatMap((id) => errorLog.setMistakeType(id, params.questionId, payload)))
    })
  })
)
