import { Effect } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../api/Api.ts"
import { CurrentProfile } from "../../api/Profiles.ts"
import { Lessons } from "../lessons/Lessons.ts"
import type { Caller } from "../practice/Practice.ts"
import { DeviceHeader } from "./practice.ts"

// The Curator's Lessons: the list, the job that writes them, and the
// decision on each draft.
export const CuratorLessonsHandlers = HttpApiBuilder.group(
  Api,
  "curatorLessons",
  Effect.fn(function*(handlers) {
    const lessons = yield* Lessons
    return handlers.handleAll({
      overview: () => lessons.overview,
      write: ({ payload }) => lessons.write(payload.subjects, payload.spendCap),
      lesson: ({ params }) => lessons.preview(params.id),
      approve: ({ params }) => lessons.approve(params.id),
      reject: ({ params, payload }) => lessons.reject(params.id, payload.note)
    })
  })
)

// The signed-in Profile's Lessons.
export const LessonsHandlers = HttpApiBuilder.group(
  Api,
  "lessons",
  Effect.fn(function*(handlers) {
    const lessons = yield* Lessons
    const profile = CurrentProfile.pipe(Effect.map((current) => current.id))
    const caller = Effect.gen(function*() {
      const current = yield* CurrentProfile
      const request = yield* HttpServerRequest.HttpServerRequest
      const device = request.headers[DeviceHeader]
      return { profileId: current.id, device: device === undefined || device === "" ? undefined : device } satisfies Caller
    })
    return handlers.handleAll({
      list: () => profile.pipe(Effect.flatMap(lessons.list)),
      open: ({ params, payload }) =>
        profile.pipe(Effect.flatMap((id) => lessons.open(id, params.subject, payload.part, payload.planItemId))),
      read: ({ params, payload }) =>
        profile.pipe(Effect.flatMap((id) => lessons.read(id, params.subject, payload.part, payload.planItemId))),
      check: ({ params, payload }) => caller.pipe(Effect.flatMap((who) => lessons.check(who, params.subject, payload.planItemId)))
    })
  })
)
