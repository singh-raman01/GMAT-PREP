import { Effect, Result } from "effect"
import { FetchHttpClient, HttpClient, type HttpClientError, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { Api } from "../../src/api/Api.ts"
import { BackgroundHeader } from "../../src/api/Profiles.ts"

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

// Each tab is a device of its own: one device holds a Session at a time,
// and another takes it over only when the Learner says so. The id lasts as
// long as the tab, through reloads. It is made from random bytes, which a
// page served over plain HTTP on the network can get, unlike a UUID.
const newDeviceId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")

const keepDeviceId = (id: string) => {
  try {
    sessionStorage.setItem("gmat-prep-device", id)
  } catch {
    // Storage is off: the id lasts until the page reloads.
  }
}

let deviceId = (() => {
  try {
    const kept = sessionStorage.getItem("gmat-prep-device")
    if (kept !== null) return kept
  } catch {
    // Storage is off; a new id each load.
  }
  const made = newDeviceId()
  keepDeviceId(made)
  return made
})()

// A duplicated tab starts with a copy of its tab's storage, and so with its
// device id. On load a tab asks the others whether its id is in use, and
// takes a new one if it is. Requests wait briefly for an answer.
const devices = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("gmat-prep-device")
const AnswerWaitMs = 100
const deviceChecked = new Promise<void>((resolve) => {
  if (devices === undefined) return resolve()
  const timer = setTimeout(resolve, AnswerWaitMs)
  devices.addEventListener("message", (event: MessageEvent<{ readonly type: string; readonly id: string }>) => {
    if (event.data.id !== deviceId) return
    if (event.data.type === "asking") devices.postMessage({ type: "in-use", id: deviceId })
    if (event.data.type === "in-use") {
      deviceId = newDeviceId()
      keepDeviceId(deviceId)
      clearTimeout(timer)
      resolve()
    }
  })
  devices.postMessage({ type: "asking", id: deviceId })
})

// A background client marks its requests as made by the page on its own,
// which the server does not count as use of the unlock.
const makeClient = (background: boolean) =>
  HttpApiClient.make(Api, {
    baseUrl: window.location.origin,
    transformClient: HttpClient.mapRequest((request) => {
      const fromDevice = HttpClientRequest.setHeader(request, "x-gp-device", deviceId)
      const shown = shownProfile === undefined ? fromDevice : HttpClientRequest.setHeader(fromDevice, "x-gp-profile", shownProfile)
      return background ? HttpClientRequest.setHeader(shown, BackgroundHeader, "1") : shown
    })
  }).pipe(Effect.provide(FetchHttpClient.layer))

export type Client = Effect.Success<ReturnType<typeof makeClient>>

const clients = new Map<boolean, Promise<Client>>()

// Runs one API call. Failures the API declares come back as values, so each
// screen can say what happened. A call the page makes on its own, with no
// one asking, is made in the background.
export const call = async <A, E>(
  request: (client: Client) => Effect.Effect<A, E>,
  options: { readonly background?: boolean } = {}
): Promise<Result.Result<A, E>> => {
  const background = options.background === true
  let client = clients.get(background)
  if (client === undefined) {
    client = deviceChecked.then(() => Effect.runPromise(makeClient(background)))
    clients.set(background, client)
  }
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
