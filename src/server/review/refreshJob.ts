import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { enrichQuestion } from "../books/enrichment.ts"
import { Db } from "../db/Database.ts"
import { questions } from "../db/schema.ts"
import type { JobKind } from "../jobs/JobKind.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { runGate } from "./gate.ts"
import { assignUndecided } from "./reserve.ts"
import { strandedDrafts } from "./stranded.ts"

// Sends Questions the Curator changed back through enrichment and the Publish
// Gate, one a step: after a Key Override, the new key's Approaches and
// wrong-option notes are written, and the tags, Difficulty estimate and
// solver runs are reused. A Question no longer a draft by then is skipped.
// Then it takes any draft no job would check (see stranded.ts).

const Params = Schema.Struct({
  questionIds: Schema.Array(Schema.String),
  // Why, for the job's label.
  reason: Schema.String
})

const Checkpoint = Schema.Struct({ done: Schema.Int })

// Dollars a refresh may spend unless the Curator raises it: a few Questions'
// Approaches and notes.
export const RefreshCap = 1

const refreshStep = (jobId: string, params: typeof Params.Type, done: number) =>
  Effect.gen(function*() {
    const db = yield* Db
    const id = params.questionIds[done] ?? (yield* strandedDrafts.pipe(Effect.orDie))[0]
    if (id === undefined) {
      return {
        _tag: "Finished",
        result: `Checked ${done} ${done === 1 ? "Question" : "Questions"} again.`
      } as const
    }
    const [question] = yield* db.select({ status: questions.status }).from(questions).where(eq(questions.id, id))
      .pipe(Effect.orDie)
    let note = "Skipped a Question that changed in the meantime"
    if (question?.status === "draft") {
      const taxonomy = (yield* Taxonomy).view
      yield* enrichQuestion(jobId, taxonomy, id)
      const outcome = yield* runGate(id, taxonomy).pipe(Effect.orDie)
      note = outcome === "published" ? "Checked a Question: published" : "Checked a Question: held for review"
      // A Question published after its Book's run joins the Reserve now.
      if (outcome === "published") yield* assignUndecided.pipe(Effect.orDie)
    }
    return {
      _tag: "Continue",
      checkpoint: { done: done + 1 },
      stepsTotal: null,
      note
    } as const
  })

export const QuestionRefresh: JobKind<typeof Params.Type, typeof Checkpoint.Type> = {
  kind: "question-refresh",
  params: Params,
  checkpoint: Checkpoint,
  label: (params) => params.reason,
  start: () => ({ done: 0 }),
  stepsTotal: () => null,
  step: ({ jobId, params, checkpoint }) => refreshStep(jobId, params, checkpoint.done)
}
