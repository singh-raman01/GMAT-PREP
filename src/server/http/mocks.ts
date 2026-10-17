import { Effect } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../api/Api.ts"
import { CurrentProfile } from "../../api/Profiles.ts"
import type { Caller } from "../practice/Practice.ts"
import { Mocks } from "../sections/Mocks.ts"
import { DeviceHeader } from "./practice.ts"

export const MocksHandlers = HttpApiBuilder.group(
  Api,
  "mocks",
  Effect.fn(function*(handlers) {
    const mocks = yield* Mocks
    const profile = Effect.map(CurrentProfile, (current) => current.id)
    const caller = Effect.gen(function*() {
      const current = yield* CurrentProfile
      const request = yield* HttpServerRequest.HttpServerRequest
      const device = request.headers[DeviceHeader]
      return { profileId: current.id, device: device === undefined || device === "" ? undefined : device } satisfies Caller
    })
    return handlers.handleAll({
      options: () => profile.pipe(Effect.flatMap(mocks.options)),
      start: ({ payload }) => caller.pipe(Effect.flatMap((who) => mocks.start(who, payload.order))),
      list: () => profile.pipe(Effect.flatMap(mocks.list)),
      get: ({ params }) => caller.pipe(Effect.flatMap((who) => mocks.get(who, params.id))),
      goOn: ({ params }) => caller.pipe(Effect.flatMap((who) => mocks.goOn(who, params.id))),
      claim: ({ params }) => caller.pipe(Effect.flatMap((who) => mocks.claim(who, params.id)))
    })
  })
)
