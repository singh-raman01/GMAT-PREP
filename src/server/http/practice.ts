import { Effect } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../api/Api.ts"
import { CurrentProfile } from "../../api/Profiles.ts"
import { type Caller, Practice } from "../practice/Practice.ts"

// Each browser tab names itself in X-GP-Device, so a set held in one tab is
// not changed from another without taking it over.
export const DeviceHeader = "x-gp-device"

export const PracticeHandlers = HttpApiBuilder.group(
  Api,
  "practice",
  Effect.fn(function*(handlers) {
    const practice = yield* Practice
    // The Profile this browser has unlocked.
    const profile = Effect.map(CurrentProfile, (current) => current.id)
    const caller = Effect.gen(function*() {
      const current = yield* CurrentProfile
      const request = yield* HttpServerRequest.HttpServerRequest
      const device = request.headers[DeviceHeader]
      return { profileId: current.id, device: device === undefined || device === "" ? undefined : device } satisfies Caller
    })
    return handlers.handleAll({
      options: () => profile.pipe(Effect.flatMap(practice.options)),
      preview: ({ payload }) => profile.pipe(Effect.flatMap((id) => practice.preview(id, payload.choice))),
      start: ({ payload }) => caller.pipe(Effect.flatMap((who) => practice.start(who, payload.choice))),
      list: () => profile.pipe(Effect.flatMap(practice.list)),
      get: ({ params }) => caller.pipe(Effect.flatMap((who) => practice.get(who, params.id))),
      answer: ({ params, payload }) => caller.pipe(Effect.flatMap((who) => practice.answer(who, params.id, payload))),
      next: ({ params, payload }) => caller.pipe(Effect.flatMap((who) => practice.next(who, params.id, payload.position))),
      bookmark: ({ params, payload }) =>
        caller.pipe(Effect.flatMap((who) => practice.bookmark(who, params.id, payload.questionId, payload.bookmarked))),
      finish: ({ params }) => caller.pipe(Effect.flatMap((who) => practice.finish(who, params.id))),
      pause: ({ params }) => caller.pipe(Effect.flatMap((who) => practice.pause(who, params.id))),
      resume: ({ params }) => caller.pipe(Effect.flatMap((who) => practice.resume(who, params.id))),
      claim: ({ params }) => caller.pipe(Effect.flatMap((who) => practice.claim(who, params.id))),
      review: ({ params }) => caller.pipe(Effect.flatMap((who) => practice.review(who, params.id, params.position))),
      similar: ({ payload }) => caller.pipe(Effect.flatMap((who) => practice.similar(who, payload.questionId))),
      scores: () => profile.pipe(Effect.flatMap(practice.scores))
    })
  })
)
