import { BookIntake } from "../../books/intakeJob.ts"
import { BookMapping } from "../../books/mapJob.ts"
import { type AnyJobKind, JobKinds } from "../JobKind.ts"
import { ConnectionTest } from "./connectionTest.ts"

// Every kind of job this build can run.
export const AllJobKinds: ReadonlyArray<AnyJobKind> = [ConnectionTest, BookIntake, BookMapping]

export const JobKindsLive = JobKinds.layer(AllJobKinds)
