import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { BankApi } from "./Bank.ts"
import { BooksApi } from "./Books.ts"
import { CuratorAccessApi, CuratorSessionApi } from "./Curator.ts"
import { ErrorLogApi } from "./ErrorLog.ts"
import { GenerationApi } from "./Generation.ts"
import { GoldenApi } from "./Golden.ts"
import { JobsApi } from "./Jobs.ts"
import { MocksApi } from "./Mocks.ts"
import { PaperMarksApi } from "./PaperMarks.ts"
import { PracticeApi } from "./Practice.ts"
import { SectionalsApi } from "./Sectionals.ts"
import { ProfilesApi, SessionApi } from "./Profiles.ts"
import { ReviewApi } from "./Review.ts"
import { ScoresApi } from "./Scores.ts"
import { SettingsApi } from "./Settings.ts"
import { TaxonomyApi } from "./Taxonomy.ts"

export class WorkerStatus extends Schema.Class<WorkerStatus>("gmat-prep/api/WorkerStatus")({
  running: Schema.Boolean,
  pid: Schema.NullOr(Schema.Int),
  restarts: Schema.Int
}) {}

export class Health extends Schema.Class<Health>("gmat-prep/api/Health")({
  status: Schema.Literal("ok"),
  worker: WorkerStatus
}) {}

export class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/api/health", {
    success: Health
  })
) {}

// Shared by the server and the web app; it holds no server code.
export class Api extends HttpApi.make("gmat-prep")
  .add(SystemApi)
  .add(ProfilesApi)
  .add(SessionApi)
  .add(TaxonomyApi)
  .add(PracticeApi)
  .add(SectionalsApi)
  .add(MocksApi)
  .add(ScoresApi)
  .add(PaperMarksApi)
  .add(ErrorLogApi)
  .add(CuratorAccessApi)
  .add(CuratorSessionApi)
  .add(SettingsApi)
  .add(JobsApi)
  .add(BooksApi)
  .add(ReviewApi)
  .add(GoldenApi)
  .add(BankApi)
  .add(GenerationApi)
{}
