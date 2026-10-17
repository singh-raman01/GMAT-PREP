import { Effect, Layer } from "effect"
import { BookFiles } from "./books/BookFiles.ts"
import { FigureFiles } from "./books/FigureFiles.ts"
import { Books } from "./books/Books.ts"
import { Curator } from "./curator/Curator.ts"
import { DatabaseLive } from "./db/Database.ts"
import { Generation } from "./generation/Generation.ts"
import { JobFeed } from "./events/JobFeed.ts"
import { ErrorLog } from "./learning/ErrorLog.ts"
import { Plans } from "./plans/Plans.ts"
import { Lessons } from "./lessons/Lessons.ts"
import { LlmAdapter } from "./llm/LlmAdapter.ts"
import { Tutor } from "./tutor/Tutor.ts"
import { Retries } from "./learning/Retries.ts"
import { Analytics } from "./analytics/Analytics.ts"
import { SiblingsReport } from "./learning/SiblingsReport.ts"
import { BookFileRoutes } from "./http/books.ts"
import { EventsRoutes } from "./http/events.ts"
import { GuardLive } from "./http/guard.ts"
import { ApiRoutes } from "./http/handlers.ts"
import { MediaRoutes } from "./http/media.ts"
import { WebRoutes } from "./http/web.ts"
import type { JobKinds } from "./jobs/JobKind.ts"
import { JobStore } from "./jobs/JobStore.ts"
import { JobKindsLive } from "./jobs/kinds/index.ts"
import { PaperMarks } from "./practice/PaperMarks.ts"
import { Practice } from "./practice/Practice.ts"
import { Mocks } from "./sections/Mocks.ts"
import { Sectionals } from "./sections/Sectionals.ts"
import { Profiles } from "./profiles/Profiles.ts"
import { Scores } from "./ratings/Scores.ts"
import { Bank } from "./review/Bank.ts"
import { Golden } from "./review/Golden.ts"
import { Overview } from "./review/Overview.ts"
import { ReviewQueue } from "./review/ReviewQueue.ts"
import { ApiKeyStore } from "./settings/ApiKeyStore.ts"
import { Settings } from "./settings/Settings.ts"
import { Snapshots } from "./snapshots/Snapshots.ts"
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
export const makeAppServices = (kinds: Layer.Layer<JobKinds>) => Plans.layer.pipe(
  // The Study Plan, over what it starts and reads.
  Layer.provideMerge(Layer.mergeAll(
    Profiles.layer,
    Curator.layer,
    JobFeed.layer,
    Books.layer,
    ReviewQueue.layer,
    Golden.layer,
    Overview.layer,
    Generation.layer,
    Mocks.layer,
    Retries.layer,
    Scores.layer,
    PaperMarks.layer,
    Lessons.layer,
    Tutor.layer,
    RemoveUploadLeftovers
  )),
  // The analytics, which Retries order their steps by.
  Layer.provideMerge(Analytics.layer),
  // One of each, shared: the Sectional engine Mocks run their Sections on,
  // the Practice and Error Log services Retries build on, and the Bank and
  // Siblings counts the Curator's Overview reads.
  Layer.provideMerge(Layer.mergeAll(Sectionals.layer, Practice.layer, ErrorLog.layer, Bank.layer, SiblingsReport.layer)),
  // Tutor Chat calls the LLM from the server, over the transport given.
  Layer.provideMerge(LlmAdapter.layer),
  Layer.provideMerge(Layer.mergeAll(Settings.layer, ApiKeyStore.layer, BookFiles.layer, FigureFiles.layer, Taxonomy.layer)),
  // Snapshots, taken before risky changes in the services above.
  Layer.provideMerge(Snapshots.layer),
  Layer.provideMerge(JobStore.layer),
  Layer.provideMerge(kinds),
  Layer.provideMerge(DatabaseLive)
)

export const AppServices = makeAppServices(JobKindsLive)
