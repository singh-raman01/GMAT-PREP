import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../api/Api.ts"
import { CurrentProfile } from "../../api/Profiles.ts"
import { Practice } from "../practice/Practice.ts"

export const PracticeHandlers = HttpApiBuilder.group(
  Api,
  "practice",
  Effect.fn(function*(handlers) {
    const practice = yield* Practice
    // The Profile this browser has unlocked.
    const profile = Effect.map(CurrentProfile, (current) => current.id)
    return handlers.handleAll({
      options: () => profile.pipe(Effect.flatMap(practice.options)),
      preview: ({ payload }) => profile.pipe(Effect.flatMap((id) => practice.preview(id, payload.choice))),
      start: ({ payload }) => profile.pipe(Effect.flatMap((id) => practice.start(id, payload.choice))),
      list: () => profile.pipe(Effect.flatMap(practice.list)),
      get: ({ params }) => profile.pipe(Effect.flatMap((id) => practice.get(id, params.id))),
      answer: ({ params, payload }) => profile.pipe(Effect.flatMap((id) => practice.answer(id, params.id, payload))),
      next: ({ params, payload }) => profile.pipe(Effect.flatMap((id) => practice.next(id, params.id, payload.position))),
      bookmark: ({ params, payload }) =>
        profile.pipe(Effect.flatMap((id) => practice.bookmark(id, params.id, payload.questionId, payload.bookmarked))),
      finish: ({ params }) => profile.pipe(Effect.flatMap((id) => practice.finish(id, params.id))),
      review: ({ params }) => profile.pipe(Effect.flatMap((id) => practice.review(id, params.id, params.position))),
      similar: ({ payload }) => profile.pipe(Effect.flatMap((id) => practice.similar(id, payload.questionId)))
    })
  })
)
