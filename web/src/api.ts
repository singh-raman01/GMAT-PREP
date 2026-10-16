import { Effect, Result } from "effect"
import { FetchHttpClient, type HttpClientError } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { Api } from "../../src/api/Api.ts"

// The typed client derived from the same API definition the server uses. The
// unlock cookie is HttpOnly and same-origin, so fetch sends it unprompted.

const makeClient = HttpApiClient.make(Api, { baseUrl: window.location.origin }).pipe(
  Effect.provide(FetchHttpClient.layer)
)

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
