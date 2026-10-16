import { Effect, Layer, Redacted } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api, Health } from "../../api/Api.ts"
import { CurrentProfile, ProfileCookie, ProfileSession } from "../../api/Profiles.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { WorkerSupervisor } from "../worker/WorkerSupervisor.ts"

// Plain HTTP on localhost or a trusted LAN, so the cookie is not marked Secure.
const cookieOptions = { httpOnly: true, secure: false, sameSite: "strict", path: "/" } as const

const setUnlockCookie = (token: string) => HttpApiBuilder.securitySetCookie(ProfileCookie, token, cookieOptions)

const clearUnlockCookie = HttpApiBuilder.securitySetCookie(ProfileCookie, "", { ...cookieOptions, maxAge: 0 })

export const ProfileSessionLive = Layer.effect(
  ProfileSession,
  Effect.gen(function*() {
    const profiles = yield* Profiles
    return ProfileSession.of({
      cookie: Effect.fn(function*(httpEffect, { credential }) {
        const profile = yield* profiles.fromToken(Redacted.value(credential))
        return yield* Effect.provideService(httpEffect, CurrentProfile, profile)
      })
    })
  })
)

const SystemHandlers = HttpApiBuilder.group(
  Api,
  "system",
  Effect.fn(function*(handlers) {
    const worker = yield* WorkerSupervisor
    return handlers.handleAll({
      health: () => worker.status.pipe(Effect.map((status) => new Health({ status: "ok", worker: status })))
    })
  })
)

const ProfilesHandlers = HttpApiBuilder.group(
  Api,
  "profiles",
  Effect.fn(function*(handlers) {
    const profiles = yield* Profiles
    return handlers.handleAll({
      list: () => profiles.list,
      create: Effect.fn(function*({ payload }) {
        const unlocked = yield* profiles.create(payload)
        yield* setUnlockCookie(unlocked.token)
        return unlocked.profile
      }),
      unlock: Effect.fn(function*({ params, payload }) {
        const unlocked = yield* profiles.unlock(params.id, payload.pin)
        yield* setUnlockCookie(unlocked.token)
        return unlocked.profile
      })
    })
  })
)

const SessionHandlers = HttpApiBuilder.group(
  Api,
  "session",
  Effect.fn(function*(handlers) {
    const profiles = yield* Profiles
    return handlers.handleAll({
      me: () => CurrentProfile,
      lock: Effect.fn(function*() {
        const credential = yield* HttpApiBuilder.securityDecode(ProfileCookie)
        yield* profiles.lock(Redacted.value(credential))
        yield* clearUnlockCookie
      })
    })
  })
)

const TaxonomyHandlers = HttpApiBuilder.group(
  Api,
  "taxonomy",
  Effect.fn(function*(handlers) {
    const taxonomy = yield* Taxonomy
    return handlers.handleAll({
      current: () => Effect.succeed(taxonomy.view)
    })
  })
)

export const ApiRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide([SystemHandlers, ProfilesHandlers, SessionHandlers, TaxonomyHandlers]),
  Layer.provide(ProfileSessionLive)
)
