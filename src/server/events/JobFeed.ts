import { Context, Effect, Layer, Stream } from "effect"
import type { JobView } from "../../api/Jobs.ts"
import { JobStore } from "../jobs/JobStore.ts"

// Job changes for the events stream. The worker writes jobs in its own
// process, so each open stream reads the changes from the database by
// revision, twice a second. Nothing is read while no stream is open.

export const PollEvery = "500 millis"

export class JobFeed extends Context.Service<JobFeed, {
  // Every job change from the moment the stream starts.
  readonly changes: Stream.Stream<JobView>
}>()("gmat-prep/server/JobFeed") {
  static readonly layer = Layer.effect(
    JobFeed,
    Effect.gen(function*() {
      const store = yield* JobStore
      const changes = Stream.unwrap(
        Effect.gen(function*() {
          let cursor = yield* store.latestRevision
          const poll = Effect.gen(function*() {
            yield* Effect.sleep(PollEvery)
            const changed = yield* store.changesSince(cursor)
            for (const job of changed) cursor = Math.max(cursor, job.revision)
            return changed
          })
          return Stream.fromEffectRepeat(poll).pipe(Stream.flattenIterable)
        })
      )
      return JobFeed.of({ changes })
    })
  )
}
