import { JobKinds } from "../JobKind.ts"
import { ConnectionTest } from "./connectionTest.ts"

// Every kind of job this build can run.
export const JobKindsLive = JobKinds.layer([ConnectionTest])
