import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { BookFiles } from "../books/BookFiles.ts"
import { ReadyDatabaseLive } from "../db/Database.ts"
import type { JobKinds } from "../jobs/JobKind.ts"
import { JobRunner } from "../jobs/JobRunner.ts"
import { JobStore } from "../jobs/JobStore.ts"
import { JobKindsLive } from "../jobs/kinds/index.ts"
import { LlmAdapter } from "../llm/LlmAdapter.ts"
import { type LlmTransport, LlmTransportHttp } from "../llm/LlmTransport.ts"
import { ApiKeyStore } from "../settings/ApiKeyStore.ts"
import { Settings } from "../settings/Settings.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"

// What the job worker runs on, over a given LLM transport and job kinds.
// Requires AppConfig.
export const workerServices = <E, R>(
  transport: Layer.Layer<LlmTransport, E, R>,
  kinds: Layer.Layer<JobKinds> = JobKindsLive
) =>
  JobRunner.layer.pipe(
    Layer.provideMerge(LlmAdapter.layer),
    Layer.provideMerge(
      Layer.mergeAll(JobStore.layer, Settings.layer, ApiKeyStore.layer, BookFiles.layer, Taxonomy.layer, transport)
    ),
    Layer.provideMerge(kinds),
    Layer.provideMerge(ReadyDatabaseLive)
  )

export const WorkerServicesLive = workerServices(LlmTransportHttp.pipe(Layer.provide(FetchHttpClient.layer)))
