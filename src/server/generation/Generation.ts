import { count, desc, eq, inArray, max } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Semaphore } from "effect"
import { BatchView, type GeneratedQuestionType, SkillNotForType } from "../../api/Generation.ts"
import type { DifficultyBand } from "../../api/difficulty.ts"
import { LlmNotConfigured } from "../../api/Jobs.ts"
import { skillsFor } from "../../api/taxonomyRules.ts"
import { Db } from "../db/Database.ts"
import { generationBatches, jobs, questions } from "../db/schema.ts"
import { JobKinds } from "../jobs/JobKind.ts"
import { JobStore, toJobView } from "../jobs/JobStore.ts"
import { ApiKeyStore } from "../settings/ApiKeyStore.ts"
import { missingSettings, Settings } from "../settings/Settings.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { GenerationBatch } from "./batchJob.ts"

// Starts generation batches and reports on them.

export interface BatchRequest {
  readonly questionType: GeneratedQuestionType
  readonly skill: string
  readonly band: DifficultyBand
  readonly count: number
  readonly spendCap: number
}

export class Generation extends Context.Service<Generation, {
  readonly batches: Effect.Effect<ReadonlyArray<BatchView>>
  start(request: BatchRequest): Effect.Effect<BatchView, SkillNotForType | LlmNotConfigured>
}>()("gmat-prep/server/Generation") {
  static readonly layer = Layer.effect(
    Generation,
    Effect.gen(function*() {
      const db = yield* Db
      const store = yield* JobStore
      const kinds = yield* JobKinds
      const settings = yield* Settings
      const keys = yield* ApiKeyStore
      const taxonomy = (yield* Taxonomy).view
      const oneAtATime = (yield* Semaphore.make(1)).withPermits(1)

      const views = (ids: ReadonlyArray<string> | undefined) =>
        Effect.gen(function*() {
          const rows = yield* db.select().from(generationBatches)
            .where(ids === undefined ? undefined : inArray(generationBatches.id, [...ids]))
            .orderBy(desc(generationBatches.number))
          if (rows.length === 0) return []
          const batchIds = rows.map((row) => row.id)
          const counts = yield* db.select({ batchId: questions.batchId, status: questions.status, reserve: questions.reserve, n: count() })
            .from(questions).where(inArray(questions.batchId, batchIds))
            .groupBy(questions.batchId, questions.status, questions.reserve)
          const jobIds = rows.flatMap((row) => (row.jobId === null ? [] : [row.jobId]))
          const jobRows = jobIds.length === 0 ? [] : yield* db.select().from(jobs).where(inArray(jobs.id, jobIds))
          return rows.map((row) => {
            const mine = counts.filter((each) => each.batchId === row.id)
            const of = (status: string) => mine.filter((each) => each.status === status).reduce((sum, each) => sum + each.n, 0)
            const job = jobRows.find((each) => each.id === row.jobId)
            return new BatchView({
              id: row.id,
              number: row.number,
              questionType: row.questionType as GeneratedQuestionType,
              skill: row.skill,
              band: row.band as DifficultyBand,
              count: row.count,
              failed: row.failed,
              questions: mine.reduce((sum, each) => sum + each.n, 0),
              published: of("published"),
              held: of("held"),
              checking: of("draft"),
              withdrawn: of("withdrawn"),
              reserved: mine.filter((each) => each.reserve === true && each.status !== "withdrawn")
                .reduce((sum, each) => sum + each.n, 0),
              job: job === undefined ? null : toJobView(job, kinds),
              createdAt: row.createdAt
            })
          })
        }).pipe(Effect.orDie)

      const start = (request: BatchRequest) =>
        Effect.gen(function*() {
          const skills = skillsFor(taxonomy, request.questionType)
          if (!skills.some((skill) => skill.id === request.skill)) {
            return yield* new SkillNotForType({ skills: skills.map((skill) => skill.id) })
          }
          const llm = yield* settings.llm
          const hasKey = Option.isSome(yield* keys.read)
          const missing = [
            ...new Set(
              (["generation", "statement-translation", "tagging", "solving", "approaches"] as const)
                .flatMap((task) => missingSettings(llm, hasKey, task))
            )
          ]
          if (missing.length > 0) return yield* new LlmNotConfigured({ missing })
          const now = yield* Clock.currentTimeMillis
          const id = crypto.randomUUID()
          yield* db.transaction(() =>
            Effect.gen(function*() {
              const [last] = yield* db.select({ number: max(generationBatches.number) }).from(generationBatches)
              yield* db.insert(generationBatches).values({
                id,
                number: (last?.number ?? 0) + 1,
                questionType: request.questionType,
                skill: request.skill,
                band: request.band,
                count: request.count,
                createdAt: now
              })
              const job = yield* store.create(GenerationBatch, { batchId: id }, request.spendCap)
              yield* db.update(generationBatches).set({ jobId: job.id }).where(eq(generationBatches.id, id))
            })
          ).pipe(Effect.orDie)
          return (yield* views([id]))[0]!
        }).pipe(oneAtATime)

      return Generation.of({ batches: views(undefined), start })
    })
  )
}

