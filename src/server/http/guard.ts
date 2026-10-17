import { Cause, Effect, Stream } from "effect"
import { HttpBody, HttpEffect, HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http"
import { BookUploadPath, MaxBookBytes } from "../../api/Books.ts"
import { RefusedHeader } from "../../api/Lan.ts"
import { LanAccess } from "../access/LanAccess.ts"
import { RefusalTexts, type Refused } from "../access/reach.ts"

// Who may reach the server is decided in LanAccess (decisions 119 to 125):
// a web page on another site can point its own host name at this computer
// (DNS rebinding), so requests are answered only when their Host header
// names this computer; and only this computer, or in LAN mode a paired
// device, gets more than the app's pages and pairing.

const SecurityHeaders = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'"
} as const

// Writes come only from the app's own pages. SameSite cookies stop other sites
// from using an unlock, but not pages on other ports of this computer, and not
// writes that need no unlock, such as creating a Profile. Browsers name the
// page that sent a request in Origin; tools such as curl send none.
const UnsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"])

export const MaxJsonBytes = 1_000_000

// The one write that is not JSON: adding a Book streams the PDF itself.
const FileUploads: ReadonlyMap<string, { readonly type: string; readonly maxBytes: number }> = new Map([
  [BookUploadPath, { type: "application/pdf", maxBytes: MaxBookBytes }]
])

const writeRefusal = (request: HttpServerRequest.HttpServerRequest, host: string) => {
  if (!UnsafeMethods.has(request.method)) return undefined
  const origin = request.headers["origin"]
  if (origin !== undefined && origin.toLowerCase() !== `http://${host.toLowerCase()}`) {
    return HttpServerResponse.text("Changes are accepted only from GMAT prep's own pages.", { status: 403 })
  }
  const length = request.headers["content-length"]
  const type = (request.headers["content-type"] ?? "").toLowerCase()
  const upload = request.method === "POST" ? FileUploads.get(request.url.split("?")[0] ?? "") : undefined
  if (upload !== undefined) {
    if (!type.startsWith(upload.type)) {
      return HttpServerResponse.text("Send the Book as a PDF.", { status: 415 })
    }
    if (length === undefined) {
      return HttpServerResponse.text("Send the length of the file.", { status: 411 })
    }
    if (Number(length) > upload.maxBytes) {
      return HttpServerResponse.text("The file is too large.", { status: 413 })
    }
    return undefined
  }
  const hasBody = (length !== undefined && length !== "0") || request.headers["transfer-encoding"] !== undefined
  if (!hasBody) return undefined
  if (!type.startsWith("application/json")) {
    return HttpServerResponse.text("Send the request body as JSON.", { status: 415 })
  }
  if (length === undefined) {
    return HttpServerResponse.text("Send the length of the request body.", { status: 411 })
  }
  if (Number(length) > MaxJsonBytes) {
    return HttpServerResponse.text("The request body is too large.", { status: 413 })
  }
  return undefined
}

// A response that sets its own content security policy keeps it, such as a
// Book's PDF, which the browser's viewer must be allowed to show.
const { "content-security-policy": _policy, ...HeadersBesidesPolicy } = SecurityHeaders

const addSecurityHeaders: HttpEffect.PreResponseHandler = (_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeaders(
      response,
      response.headers["content-security-policy"] === undefined ? SecurityHeaders : HeadersBesidesPolicy
    )
  )

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

// The app reads why from the header, to ask for pairing.
const refusal = (verdict: Refused) =>
  HttpServerResponse.text(RefusalTexts[verdict.reason](verdict.lan), {
    status: 403,
    headers: { [RefusedHeader]: verdict.reason }
  })

// A stream to another device, such as its event stream, ends part way when
// its access does; Bun goes on sending any other response until the listener
// holding it closes (src/server/http/listeners.ts). The stream fails rather
// than ends, so the device cannot take it for whole, and with no error, as
// Bun prints any other.
const stopsWhenAccessEnds = (response: HttpServerResponse.HttpServerResponse, ended: Effect.Effect<Refused>) => {
  const body = response.body
  if (body._tag !== "Stream") return response
  const stopped = body.stream.pipe(Stream.interruptWhen(Effect.andThen(ended, Effect.fail(undefined))))
  return HttpServerResponse.setBody(response, HttpBody.stream(stopped, body.contentType, body.contentLength))
}

// Refuses other hosts, devices not let in, and cross-site writes, adds the
// security headers to every response, error responses included, and logs
// server failures. Ordinary requests are not logged, to keep the terminal
// quiet.
export const GuardLive = HttpRouter.middleware(
  Effect.gen(function*() {
    const access = yield* LanAccess
    return (httpEffect) =>
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        yield* HttpEffect.appendPreResponseHandler(addSecurityHeaders)
        const verdict = yield* access.judge(request)
        if (verdict._tag === "refuse") return refusal(verdict)
        const refusedWrite = writeRefusal(request, request.headers["host"] ?? "")
        if (refusedWrite !== undefined) {
          return refusedWrite
        }
        const logged = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(Effect.tapCause((cause) => logServerFailure(request, cause)))
        if (verdict.fromHost) return yield* logged(httpEffect)
        // Another device's access can end while its request runs (decisions
        // 120 and 123): the request then stops where it is, so a write not
        // yet committed rolls back, and the device is refused. As without
        // the race, only the route's handler can be interrupted, and a device
        // that goes away still ends its request.
        const ended = access.accessEnds(request)
        const response = yield* logged(
          Effect.raceFirst(Effect.uninterruptible(httpEffect), Effect.map(ended, refusal)).pipe(Effect.interruptible)
        )
        return stopsWhenAccessEnds(response, ended)
      })
  }),
  { global: true }
)
