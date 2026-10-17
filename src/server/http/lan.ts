import { Duration, Effect } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../api/Api.ts"
import { DeviceCookie, HostOnly } from "../../api/Lan.ts"
import { LanAccess } from "../access/LanAccess.ts"

// Pairing a device, and the Curator's LAN mode tools (decisions 119 to 125).

// Plain HTTP on a trusted network, so the cookie is not marked Secure. A
// paired device keeps it as long as browsers allow, 400 days.
const DeviceCookieMaxAge = Duration.days(400)
const setDeviceCookie = (token: string) =>
  HttpApiBuilder.securitySetCookie(DeviceCookie, token, {
    httpOnly: true,
    secure: false,
    sameSite: "strict",
    path: "/",
    maxAge: DeviceCookieMaxAge
  })

export const PairingHandlers = HttpApiBuilder.group(
  Api,
  "pairing",
  Effect.fn(function*(handlers) {
    const access = yield* LanAccess
    return handlers.handleAll({
      status: Effect.fn(function*() {
        return yield* access.status(yield* HttpServerRequest.HttpServerRequest)
      }),
      pair: Effect.fn(function*({ payload }) {
        const request = yield* HttpServerRequest.HttpServerRequest
        const paired = yield* access.pair(request, payload.code, payload.name)
        yield* setDeviceCookie(paired.token)
        return paired.device
      })
    })
  })
)

// The guard refuses these paths to other devices already; each handler
// checks again, as the router reads paths more loosely than any list.
export const CuratorLanHandlers = HttpApiBuilder.group(
  Api,
  "curatorLan",
  Effect.fn(function*(handlers) {
    const access = yield* LanAccess
    const hostOnly = Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (!(yield* access.fromHost(request))) return yield* new HostOnly()
    })
    return handlers.handleAll({
      view: () => hostOnly.pipe(Effect.andThen(access.view)),
      setMode: ({ payload }) => hostOnly.pipe(Effect.andThen(access.setMode(payload.on))),
      makeCode: () => hostOnly.pipe(Effect.andThen(access.makeCode)),
      revoke: ({ params }) => hostOnly.pipe(Effect.andThen(access.revoke(params.id)))
    })
  })
)
