import { Effect } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../api/Api.ts"
import { CurrentProfile } from "../../api/Profiles.ts"
import type { Caller } from "../practice/Practice.ts"
import { Sectionals } from "../sections/Sectionals.ts"
import { DeviceHeader } from "./practice.ts"

export const SectionalsHandlers = HttpApiBuilder.group(
  Api,
  "sectionals",
  Effect.fn(function*(handlers) {
    const sectionals = yield* Sectionals
    const profile = Effect.map(CurrentProfile, (current) => current.id)
    const caller = Effect.gen(function*() {
      const current = yield* CurrentProfile
      const request = yield* HttpServerRequest.HttpServerRequest
      const device = request.headers[DeviceHeader]
      return { profileId: current.id, device: device === undefined || device === "" ? undefined : device } satisfies Caller
    })
    return handlers.handleAll({
      options: () => profile.pipe(Effect.flatMap(sectionals.options)),
      start: ({ payload }) => caller.pipe(Effect.flatMap((who) => sectionals.start(who, payload.section))),
      list: () => profile.pipe(Effect.flatMap(sectionals.list)),
      get: ({ params }) => caller.pipe(Effect.flatMap((who) => sectionals.get(who, params.id))),
      answer: ({ params, payload }) => caller.pipe(Effect.flatMap((who) => sectionals.answer(who, params.id, payload))),
      bookmark: ({ params, payload }) =>
        caller.pipe(Effect.flatMap((who) => sectionals.bookmark(who, params.id, payload.questionId, payload.bookmarked))),
      question: ({ params }) => caller.pipe(Effect.flatMap((who) => sectionals.question(who, params.id, params.position))),
      change: ({ params, payload }) => caller.pipe(Effect.flatMap((who) => sectionals.change(who, params.id, payload))),
      finish: ({ params }) => caller.pipe(Effect.flatMap((who) => sectionals.finish(who, params.id))),
      claim: ({ params }) => caller.pipe(Effect.flatMap((who) => sectionals.claim(who, params.id)))
    })
  })
)
