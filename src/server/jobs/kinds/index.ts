import { BookExtraction } from "../../books/extractJob.ts"
import { BookIntake } from "../../books/intakeJob.ts"
import { BookMapping } from "../../books/mapJob.ts"
import { GoldenCheck } from "../../review/goldenJob.ts"
import { QuestionRefresh } from "../../review/refreshJob.ts"
import { type AnyJobKind, JobKinds } from "../JobKind.ts"
import { ConnectionTest } from "./connectionTest.ts"

// Every kind of job this build can run.
export const AllJobKinds: ReadonlyArray<AnyJobKind> = [
  ConnectionTest,
  BookIntake,
  BookMapping,
  BookExtraction,
  QuestionRefresh,
  GoldenCheck
]

export const JobKindsLive = JobKinds.layer(AllJobKinds)
