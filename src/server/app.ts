import { Effect, Layer } from "effect"
import { BookFiles } from "./books/BookFiles.ts"
import { FigureFiles } from "./books/FigureFiles.ts"
import { Books } from "./books/Books.ts"
import { Curator } from "./curator/Curator.ts"
import { DatabaseLive } from "./db/Database.ts"
import { Generation } from "./generation/Generation.ts"
import { JobFeed } from "./events/JobFeed.ts"
import { BookFileRoutes } from "./http/books.ts"
import { EventsRoutes } from "./http/events.ts"
import { GuardLive } from "./http/guard.ts"
import { ApiRoutes } from "./http/handlers.ts"
import { MediaRoutes } from "./http/media.ts"
import { WebRoutes } from "./http/web.ts"
import type { JobKinds } from "./jobs/JobKind.ts"
import { JobStore } from "./jobs/JobStore.ts"
import { JobKindsLive } from "./jobs/kinds/index.ts"
import { Practice } from "./practice/Practice.ts"
import { Sectionals } from "./sections/Sectionals.ts"
import { Profiles } from "./profiles/Profiles.ts"
import { OfficialScores } from "./ratings/OfficialScores.ts"
import { Bank } from "./review/Bank.ts"
import { Golden } from "./review/Golden.ts"
import { ReviewQueue } from "./review/ReviewQueue.ts"
import { ApiKeyStore } from "./settings/ApiKeyStore.ts"
import { Settings } from "./settings/Settings.ts"
import { Taxonomy } from "./taxonomy/Taxonomy.ts"

// Every route the server answers, behind the Host check.
export const AppRoutes = Layer.mergeAll(ApiRoutes, BookFileRoutes, MediaRoutes, EventsRoutes, WebRoutes, GuardLive)

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
  Curator.layer,
  JobFeed.layer,
  Books.layer,
  ReviewQueue.layer,
  Golden.layer,
  Bank.layer,
  Generation.layer,
  Practice.layer,
  Sectionals.layer,
  OfficialScores.layer,
  RemoveUploadLeftovers
).pipe(
  Layer.provideMerge(Layer.mergeAll(Settings.layer, ApiKeyStore.layer, BookFiles.layer, FigureFiles.layer, Taxonomy.layer)),
  Layer.provideMerge(JobStore.layer),
  Layer.provideMerge(kinds),
  Layer.provideMerge(DatabaseLive)
)

export const AppServices = makeAppServices(JobKindsLive)
