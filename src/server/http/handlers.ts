import { Effect, Layer, Redacted } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api, Health } from "../../api/Api.ts"
import { CurrentProfile, NotUnlocked, ProfileCookie, ProfileSession } from "../../api/Profiles.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { WorkerSupervisor } from "../worker/WorkerSupervisor.ts"
import { BankHandlers, BooksHandlers, GoldenHandlers, ReviewHandlers } from "./books.ts"
import { CuratorHandlers, CuratorSessionLive } from "./curatorHandlers.ts"
import { PracticeHandlers } from "./practice.ts"

// Plain HTTP on localhost or a trusted LAN, so the cookie is not marked Secure.
const cookieOptions = { httpOnly: true, secure: false, sameSite: "strict", path: "/" } as const

const setUnlockCookie = (token: string) => HttpApiBuilder.securitySetCookie(ProfileCookie, token, cookieOptions)

const clearUnlockCookie = HttpApiBuilder.securitySetCookie(ProfileCookie, "", { ...cookieOptions, maxAge: 0 })

// Tabs share the browser's one unlock, so each tab names the Profile it
// shows in X-GP-Profile. A tab left showing another Profile is refused, and
// reloads the current one, instead of acting as the Profile now unlocked.
export const ExpectedProfileHeader = "x-gp-profile"

export const ProfileSessionLive = Layer.effect(
  ProfileSession,
  Effect.gen(function*() {
    const profiles = yield* Profiles
    return ProfileSession.of({
      cookie: Effect.fn(function*(httpEffect, { credential }) {
        const profile = yield* profiles.fromToken(Redacted.value(credential))
        const request = yield* HttpServerRequest.HttpServerRequest
        const expected = request.headers[ExpectedProfileHeader]
        if (expected !== undefined && expected !== profile.id) {
          return yield* new NotUnlocked()
        }
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

    // A browser holds one unlock: a new one ends the one it replaces.
    const replaceUnlock = Effect.fn(function*(token: string) {
      const request = yield* HttpServerRequest.HttpServerRequest
      const previous = request.cookies[ProfileCookie.key]
      if (previous !== undefined && previous !== "") yield* profiles.lock(previous)
      yield* setUnlockCookie(token)
    })

    return handlers.handleAll({
      list: () => profiles.list,
      create: Effect.fn(function*({ payload }) {
        const unlocked = yield* profiles.create(payload)
        yield* replaceUnlock(unlocked.token)
        return unlocked.profile
      }),
      unlock: Effect.fn(function*({ params, payload }) {
        const unlocked = yield* profiles.unlock(params.id, payload.pin)
        yield* replaceUnlock(unlocked.token)
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
  Layer.provide([
    SystemHandlers,
    ProfilesHandlers,
    SessionHandlers,
    TaxonomyHandlers,
    PracticeHandlers,
    CuratorHandlers,
    BooksHandlers,
    ReviewHandlers,
    GoldenHandlers,
    BankHandlers
  ]),
  Layer.provide([ProfileSessionLive, CuratorSessionLive])
)
