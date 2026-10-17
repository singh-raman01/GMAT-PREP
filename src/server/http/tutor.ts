import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../api/Api.ts"
import { CurrentProfile } from "../../api/Profiles.ts"
import { Tutor } from "../tutor/Tutor.ts"

// The signed-in Profile's Tutor Chat and Problem Reports.
export const TutorHandlers = HttpApiBuilder.group(
  Api,
  "tutor",
  Effect.fn(function*(handlers) {
    const tutor = yield* Tutor
    const profile = CurrentProfile.pipe(Effect.map((current) => current.id))
    return handlers.handleAll({
      conversation: ({ params, query }) => profile.pipe(Effect.flatMap((id) => tutor.conversation(id, params.id, query.before))),
      ask: ({ params, payload }) => profile.pipe(Effect.flatMap((id) => tutor.ask(id, params.id, payload.message))),
      myReport: ({ params }) => profile.pipe(Effect.flatMap((id) => tutor.myReport(id, params.id))),
      report: ({ params, payload }) => profile.pipe(Effect.flatMap((id) => tutor.report(id, params.id, payload.text))),
      reports: () => profile.pipe(Effect.flatMap(tutor.reports))
    })
  })
)

// The Curator's monthly cap on Tutor Chat spend.
export const CuratorTutorHandlers = HttpApiBuilder.group(
  Api,
  "curatorTutor",
  Effect.fn(function*(handlers) {
    const tutor = yield* Tutor
    return handlers.handleAll({
      spend: () => tutor.spend,
      saveCap: ({ payload }) => tutor.saveCap(payload.cap)
    })
  })
)
