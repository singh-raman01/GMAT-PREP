import { Effect, Result } from "effect"
import { FetchHttpClient, HttpClient, type HttpClientError, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { Api } from "../../src/api/Api.ts"

// The typed client derived from the same API definition the server uses. The
// unlock cookie is HttpOnly, so this page never sees it; the browser sends it
// with every request to the app.

// Tabs share the browser's one unlock. Each request names the Profile this
// tab shows, and the server refuses it if another tab has since opened a
// different Profile.
let shownProfile: string | undefined

export const showProfile = (id: string | undefined) => {
  shownProfile = id
}

const makeClient = HttpApiClient.make(Api, {
  baseUrl: window.location.origin,
  transformClient: HttpClient.mapRequest((request) =>
    shownProfile === undefined ? request : HttpClientRequest.setHeader(request, "x-gp-profile", shownProfile)
  )
}).pipe(Effect.provide(FetchHttpClient.layer))

export type Client = Effect.Success<typeof makeClient>

let client: Promise<Client> | undefined

// Runs one API call. Failures the API declares come back as values, so each
// screen can say what happened.
export const call = async <A, E>(request: (client: Client) => Effect.Effect<A, E>): Promise<Result.Result<A, E>> => {
  client ??= Effect.runPromise(makeClient)
  return Effect.runPromise(Effect.result(request(await client)))
}

// What went wrong with a call, for failures no screen handles itself:
// the app is not running, it failed while handling the request, or it sent
// a reply this page cannot read (usually a page left open across an update).
export type Trouble = "unreachable" | "failed" | "unreadable"

export const troubleOf = (error: { readonly _tag: string }): Trouble => {
  if (error._tag !== "HttpClientError") return "unreadable"
  const reason = (error as HttpClientError.HttpClientError).reason
  if (reason._tag === "TransportError") return "unreachable"
  // An undeclared status arrives as a response the client could not decode.
  if ("response" in reason && reason.response !== undefined && reason.response.status >= 500) return "failed"
  return "unreadable"
}

// The status of a reply the API refused without a declared error, such as a
// request its schema rejects (400), or undefined for any other failure.
export const refusedStatus = (error: { readonly _tag: string }): number | undefined => {
  if (error._tag !== "HttpClientError") return undefined
  const reason = (error as HttpClientError.HttpClientError).reason
  return "response" in reason && reason.response !== undefined ? reason.response.status : undefined
}

// Tells the app's other tabs that this browser's unlock changed, so they show
// the Profile now unlocked instead of acting as the one they showed before.
const channel = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("gmat-prep-unlock")

export const announceUnlockChanged = () => channel?.postMessage("changed")

export const onUnlockChanged = (listener: () => void): (() => void) => {
  if (channel === undefined) return () => {}
  channel.addEventListener("message", listener)
  return () => channel.removeEventListener("message", listener)
}
