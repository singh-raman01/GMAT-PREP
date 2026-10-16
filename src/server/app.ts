import { Layer } from "effect"
import { DatabaseLive } from "./db/Database.ts"
import { GuardLive } from "./http/guard.ts"
import { ApiRoutes } from "./http/handlers.ts"
import { WebRoutes } from "./http/web.ts"
import { Profiles } from "./profiles/Profiles.ts"
import { Taxonomy } from "./taxonomy/Taxonomy.ts"

// Every route the server answers, behind the Host check.
export const AppRoutes = Layer.mergeAll(ApiRoutes, WebRoutes, GuardLive)

// Domain services over the opened, migrated database. Requires AppConfig.
export const AppServices = Layer.mergeAll(Profiles.layer, Taxonomy.layer).pipe(
  Layer.provideMerge(DatabaseLive)
)
