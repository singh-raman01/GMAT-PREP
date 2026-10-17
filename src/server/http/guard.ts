import { Cause, Effect } from "effect"
import { HttpEffect, HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http"
import { BookUploadPath, MaxBookBytes } from "../../api/Books.ts"
import { RefusedHeader } from "../../api/Lan.ts"
import { LanAccess } from "../access/LanAccess.ts"
import { RefusalTexts } from "../access/reach.ts"

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
        if (verdict._tag === "refuse") {
          // The app reads why from the header, to ask for pairing.
          return HttpServerResponse.text(RefusalTexts[verdict.reason](verdict.lan), {
            status: 403,
            headers: { [RefusedHeader]: verdict.reason }
          })
        }
        const refusedWrite = writeRefusal(request, request.headers["host"] ?? "")
        if (refusedWrite !== undefined) {
          return refusedWrite
        }
        return yield* httpEffect.pipe(Effect.tapCause((cause) => logServerFailure(request, cause)))
      })
  }),
  { global: true }
)
