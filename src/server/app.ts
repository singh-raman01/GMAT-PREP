import { Layer } from "effect"
import { Curator } from "./curator/Curator.ts"
import { DatabaseLive } from "./db/Database.ts"
import { JobFeed } from "./events/JobFeed.ts"
import { EventsRoutes } from "./http/events.ts"
import { GuardLive } from "./http/guard.ts"
import { ApiRoutes } from "./http/handlers.ts"
import { WebRoutes } from "./http/web.ts"
import type { JobKinds } from "./jobs/JobKind.ts"
import { JobStore } from "./jobs/JobStore.ts"
import { JobKindsLive } from "./jobs/kinds/index.ts"
import { Profiles } from "./profiles/Profiles.ts"
import { ApiKeyStore } from "./settings/ApiKeyStore.ts"
import { Settings } from "./settings/Settings.ts"
import { Taxonomy } from "./taxonomy/Taxonomy.ts"

// Every route the server answers, behind the Host check.
export const AppRoutes = Layer.mergeAll(ApiRoutes, EventsRoutes, WebRoutes, GuardLive)

// Domain services over the opened, migrated database, for the given job
// kinds. Requires AppConfig.
export const makeAppServices = (kinds: Layer.Layer<JobKinds>) => Layer.mergeAll(
  Profiles.layer,
  Taxonomy.layer,
  Curator.layer,
  Settings.layer,
  ApiKeyStore.layer,
  JobFeed.layer
).pipe(
  Layer.provideMerge(JobStore.layer),
  Layer.provideMerge(kinds),
  Layer.provideMerge(DatabaseLive)
)

export const AppServices = makeAppServices(JobKindsLive)
