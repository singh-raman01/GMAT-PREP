import { Effect, Layer } from "effect"
import { BookFiles } from "./books/BookFiles.ts"
import { Books } from "./books/Books.ts"
import { Curator } from "./curator/Curator.ts"
import { DatabaseLive } from "./db/Database.ts"
import { JobFeed } from "./events/JobFeed.ts"
import { BookFileRoutes } from "./http/books.ts"
import { EventsRoutes } from "./http/events.ts"
import { GuardLive } from "./http/guard.ts"
import { ApiRoutes } from "./http/handlers.ts"
import { WebRoutes } from "./http/web.ts"
import type { JobKinds } from "./jobs/JobKind.ts"
import { JobStore } from "./jobs/JobStore.ts"
import { JobKindsLive } from "./jobs/kinds/index.ts"
import { Profiles } from "./profiles/Profiles.ts"
import { ReviewQueue } from "./review/ReviewQueue.ts"
import { ApiKeyStore } from "./settings/ApiKeyStore.ts"
import { Settings } from "./settings/Settings.ts"
import { Taxonomy } from "./taxonomy/Taxonomy.ts"

// Every route the server answers, behind the Host check.
export const AppRoutes = Layer.mergeAll(ApiRoutes, BookFileRoutes, EventsRoutes, WebRoutes, GuardLive)

// Uploads a crash cut short leave temporary files; none is in progress yet.
const RemoveUploadLeftovers = Layer.effectDiscard(
  Effect.gen(function*() {
    yield* (yield* BookFiles).removeLeftovers
  })
)

// Domain services over the opened, migrated database, for the given job
// kinds. Requires AppConfig.
export const makeAppServices = (kinds: Layer.Layer<JobKinds>) => Layer.mergeAll(
  Profiles.layer,
  Taxonomy.layer,
  Curator.layer,
  JobFeed.layer,
  Books.layer,
  ReviewQueue.layer,
  RemoveUploadLeftovers
).pipe(
  Layer.provideMerge(Layer.mergeAll(Settings.layer, ApiKeyStore.layer, BookFiles.layer)),
  Layer.provideMerge(JobStore.layer),
  Layer.provideMerge(kinds),
  Layer.provideMerge(DatabaseLive)
)

export const AppServices = makeAppServices(JobKindsLive)
