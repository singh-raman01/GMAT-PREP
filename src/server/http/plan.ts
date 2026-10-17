import { Effect } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../api/Api.ts"
import { CurrentProfile } from "../../api/Profiles.ts"
import { Plans } from "../plans/Plans.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Exports } from "../snapshots/Exports.ts"
import type { Caller } from "../practice/Practice.ts"
import { DeviceHeader } from "./practice.ts"

// The signed-in Profile's own data: its export, and deleting it.
export const SessionDataHandlers = HttpApiBuilder.group(
  Api,
  "sessionData",
  Effect.fn(function*(handlers) {
    const exports = yield* Exports
    const profiles = yield* Profiles
    const profile = CurrentProfile.pipe(Effect.map((current) => current.id))
    return handlers.handleAll({
      export: () => profile.pipe(Effect.flatMap(exports.profile)),
      remove: ({ payload }) => profile.pipe(Effect.flatMap((id) => profiles.removeOwn(id, payload.pin)))
    })
  })
)

// The signed-in Profile's Study Plan and Daily Log.
export const PlanHandlers = HttpApiBuilder.group(
  Api,
  "plan",
  Effect.fn(function*(handlers) {
    const plans = yield* Plans
    const caller = Effect.gen(function*() {
      const current = yield* CurrentProfile
      const request = yield* HttpServerRequest.HttpServerRequest
      const device = request.headers[DeviceHeader]
      return { profileId: current.id, device: device === undefined || device === "" ? undefined : device } satisfies Caller
    })
    const profile = CurrentProfile.pipe(Effect.map((current) => current.id))
    return handlers.handleAll({
      view: () => profile.pipe(Effect.flatMap(plans.view)),
      saveSettings: ({ payload }) => profile.pipe(Effect.flatMap((id) => plans.saveSettings(id, payload))),
      skipDiagnostic: () => profile.pipe(Effect.flatMap(plans.skipDiagnostic)),
      start: ({ params, payload }) => caller.pipe(Effect.flatMap((who) => plans.start(who, params.id, payload.order))),
      dailyLog: () => profile.pipe(Effect.flatMap(plans.dailyLog)),
      writeNote: ({ params, payload }) => profile.pipe(Effect.flatMap((id) => plans.writeNote(id, params.day, payload.note)))
    })
  })
)
