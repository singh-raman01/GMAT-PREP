import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../api/Api.ts"
import { CurrentProfile } from "../../api/Profiles.ts"
import { PaperMarks } from "../practice/PaperMarks.ts"

export const PaperMarksHandlers = HttpApiBuilder.group(
  Api,
  "paperMarks",
  Effect.fn(function*(handlers) {
    const marks = yield* PaperMarks
    const profile = Effect.map(CurrentProfile, (current) => current.id)
    return handlers.handleAll({
      list: () => profile.pipe(Effect.flatMap(marks.list)),
      add: ({ payload }) => profile.pipe(Effect.flatMap((id) => marks.add(id, payload))),
      remove: ({ params }) => profile.pipe(Effect.flatMap((id) => marks.remove(id, params.id)))
    })
  })
)
