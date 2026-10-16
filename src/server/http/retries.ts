import { Effect } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../api/Api.ts"
import { CurrentProfile } from "../../api/Profiles.ts"
import { Retries } from "../learning/Retries.ts"
import type { Caller } from "../practice/Practice.ts"
import { DeviceHeader } from "./practice.ts"

export const RetriesHandlers = HttpApiBuilder.group(
  Api,
  "retries",
  Effect.fn(function*(handlers) {
    const retries = yield* Retries
    const caller = Effect.gen(function*() {
      const current = yield* CurrentProfile
      const request = yield* HttpServerRequest.HttpServerRequest
      const device = request.headers[DeviceHeader]
      return { profileId: current.id, device: device === undefined || device === "" ? undefined : device } satisfies Caller
    })
    return handlers.handleAll({
      due: () => caller.pipe(Effect.flatMap((who) => retries.due(who.profileId))),
      start: ({ payload }) => caller.pipe(Effect.flatMap((who) => retries.start(who, payload.timed)))
    })
  })
)
