import { Cause, Effect } from "effect"
import { HttpEffect, HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http"

// The server listens on 127.0.0.1 only, but a web page on another site can
// still reach it by pointing its own host name at 127.0.0.1 (DNS rebinding).
// Such a request carries that site's name in its Host header, so requests are
// answered only when they name this computer.
const ThisComputer = new Set(["127.0.0.1", "localhost", "[::1]"])

// The host name in a Host header, without the port.
export const hostName = (header: string | undefined): string | undefined => {
  if (header === undefined) return undefined
  const value = header.trim().toLowerCase()
  if (value.startsWith("[")) {
    const end = value.indexOf("]")
    return end === -1 ? undefined : value.slice(0, end + 1)
  }
  const colon = value.indexOf(":")
  return colon === -1 ? value : value.slice(0, colon)
}

const SecurityHeaders = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'"
} as const

const refused = HttpServerResponse.text(
  "GMAT prep answers only to this computer. Open it at http://127.0.0.1 or http://localhost.",
  { status: 403 }
)

const addSecurityHeaders: HttpEffect.PreResponseHandler = (_request, response) =>
  Effect.succeed(HttpServerResponse.setHeaders(response, SecurityHeaders))

// Logs a request that failed on the server. Failures that map to a client
// error, such as a payload that does not decode, are not the server's fault.
const logServerFailure = (request: HttpServerRequest.HttpServerRequest, cause: Cause.Cause<unknown>) =>
  HttpServerError.causeResponse(cause).pipe(
    Effect.flatMap(([response, reported]) =>
      response.status >= 500 && !Cause.hasInterruptsOnly(reported)
        ? Effect.logError(`${request.method} ${request.url} failed`, Cause.pretty(reported))
        : Effect.void
    )
  )

// Refuses other hosts, adds the security headers to every response, error
// responses included, and logs server failures. Ordinary requests are not
// logged, to keep the terminal quiet.
export const GuardLive = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      yield* HttpEffect.appendPreResponseHandler(addSecurityHeaders)
      const host = hostName(request.headers["host"])
      if (host === undefined || !ThisComputer.has(host)) {
        return refused
      }
      return yield* httpEffect.pipe(Effect.tapCause((cause) => logServerFailure(request, cause)))
    }),
  { global: true }
)
