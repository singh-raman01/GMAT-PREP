import { and, desc, eq, gt, gte, sql } from "drizzle-orm"
import { Cause, Clock, Context, Effect, Layer, Option, Schema } from "effect"
import {
  JobId,
  JobNotChangeable,
  JobNotFound,
  type JobStatus,
  JobView,
  SpendCapTooLow
} from "../../api/Jobs.ts"
import { Db } from "../db/Database.ts"
import { jobs } from "../db/schema.ts"
import { type AnyJobKind, type JobKind, JobKinds } from "./JobKind.ts"
import { nextRevision } from "./revision.ts"

export type JobRow = typeof jobs.$inferSelect

// How a running job ends its turn with the worker.
export type JobEnd =
  | { readonly _tag: "Done"; readonly result: string }
  | { readonly _tag: "Failed"; readonly note: string }
  // resumeAt null waits for the Curator; a time resumes on its own.
  | { readonly _tag: "Paused"; readonly note: string; readonly resumeAt: number | null }
  | { readonly _tag: "Cancelled"; readonly note: string }
  // The Curator asked for a pause, and the worker saved its step to honour it.
  | { readonly _tag: "PausedOnRequest" }

// What finish did: ended the job's turn, found the Curator had taken back
// the pause it asked for (so the job keeps running), or found the job is no
// longer this worker's.
export type Finished = "ended" | "running" | "lost"

export interface StepSave {
  readonly checkpoint: string
  readonly stepsDone: number
  readonly stepsTotal: number | null
  readonly note: string | null
}

// What the server asked of a running job, read back by the worker.
export interface Control {
  readonly requested: "pause" | "cancel" | null
}

// A worker whose heartbeat is older than this has stopped; its job can be
// claimed again.
export const StaleAfterMs = 30_000

export const PausedByCurator = "Paused by the Curator"
export const CancelledByCurator = "Cancelled by the Curator"

// The end a job's turn takes, given what the Curator asked while the step ran,
// as read at the moment the end is written. A pending cancel wins over every
// end but Done, since the work is then finished anyway. A pending pause turns
// a pause that would resume on its own into one that waits for the Curator. A
// pause the Curator asked for and then took back keeps the job running.
export const settleEnd = (end: JobEnd, requested: "pause" | "cancel" | null): JobEnd | "keep-running" => {
  if (end._tag === "PausedOnRequest") {
    if (requested === "cancel") return { _tag: "Cancelled", note: CancelledByCurator }
    if (requested === "pause") return { _tag: "Paused", note: PausedByCurator, resumeAt: null }
    return "keep-running"
  }
  if (requested === "cancel" && end._tag !== "Done") return { _tag: "Cancelled", note: CancelledByCurator }
  if (requested === "pause" && end._tag === "Paused" && end.resumeAt !== null) {
    return { _tag: "Paused", note: PausedByCurator, resumeAt: null }
  }
  return end
}

const encodeJson = <A>(schema: Schema.Codec<A, unknown>, value: A) =>
  JSON.stringify(Schema.encodeSync(Schema.toCodecJson(schema))(value))

// Queues a job, inside the caller's transaction when there is one: a job
// step can hand work on to another job this way.
export const queueJob = <P, C>(kind: JobKind<P, C>, params: P, spendCap: number) =>
  Effect.gen(function*() {
    const db = yield* Db
    const now = yield* Clock.currentTimeMillis
    const [created] = yield* db.insert(jobs).values({
      id: crypto.randomUUID(),
      kind: kind.kind,
      params: encodeJson(kind.params, params),
      status: "queued",
      stepsTotal: kind.stepsTotal(params),
      spendCap,
      revision: nextRevision,
      createdAt: now,
      updatedAt: now
    }).returning().pipe(Effect.orDie)
    return created!
  })

export const decodeJson = <A>(schema: Schema.Codec<A, unknown>, text: string): Option.Option<A> =>
  Option.flatMap(
    Option.liftThrowable(() => JSON.parse(text) as unknown)(),
    Schema.decodeUnknownOption(Schema.toCodecJson(schema))
  )

const labelOf = (row: JobRow, kinds: ReadonlyMap<string, AnyJobKind>) => {
  const kind = kinds.get(row.kind)
  if (kind === undefined) return row.kind
  return Option.match(decodeJson(kind.params, row.params), {
    onNone: () => row.kind,
    onSome: (params) => kind.label(params)
  })
}

const asRequested = (value: string | null): "pause" | "cancel" | null =>
  value === "pause" || value === "cancel" ? value : null

export const toJobView = (row: JobRow, kinds: ReadonlyMap<string, AnyJobKind>) =>
  new JobView({
    id: JobId.make(row.id),
    kind: row.kind,
    label: labelOf(row, kinds),
    status: row.status as JobStatus,
    stepsDone: row.stepsDone,
    stepsTotal: row.stepsTotal,
    note: row.note,
    result: row.result,
    spend: row.spend,
    spendCap: row.spendCap,
    requested: asRequested(row.requested),
    resumeAt: row.resumeAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
    revision: row.revision
  })

export class JobStore extends Context.Service<JobStore, {
  // The server's side.
  create<P, C>(kind: JobKind<P, C>, params: P, spendCap: number): Effect.Effect<JobView>
  readonly list: Effect.Effect<ReadonlyArray<JobView>>
  // Every job changed since a moment, however many, the latest first.
  changedSince(millis: number): Effect.Effect<ReadonlyArray<JobView>>
  pause(id: JobId): Effect.Effect<JobView, JobNotFound | JobNotChangeable>
  resume(id: JobId, spendCap: number | undefined): Effect.Effect<JobView, JobNotFound | JobNotChangeable | SpendCapTooLow>
  cancel(id: JobId): Effect.Effect<JobView, JobNotFound | JobNotChangeable>
  readonly latestRevision: Effect.Effect<number>
  changesSince(revision: number): Effect.Effect<ReadonlyArray<JobView>>
  // The worker's side.
  claim(workerId: string): Effect.Effect<Option.Option<JobRow>>
  heartbeat(id: string, workerId: string): Effect.Effect<Option.Option<Control>>
  saveStep(id: string, workerId: string, save: StepSave): Effect.Effect<Option.Option<Control>>
  finish(id: string, workerId: string, end: JobEnd): Effect.Effect<Finished>
  spendOf(id: string): Effect.Effect<Option.Option<{ readonly spend: number; readonly cap: number }>>
  // The supervisor's side: whether the worker with this process id holds a
  // job whose heartbeat stopped, as when it is stuck in a loop.
  heartbeatStopped(pid: number): Effect.Effect<boolean>
}>()("gmat-prep/server/JobStore") {
  static readonly layer = Layer.effect(
    JobStore,
    Effect.gen(function*() {
      const db = yield* Db
      const kinds = yield* JobKinds
      const view = (row: JobRow) => toJobView(row, kinds)

      const row = (id: string) =>
        db.select().from(jobs).where(eq(jobs.id, id)).pipe(Effect.map((rows) => rows[0]), Effect.orDie)

      const create = <P, C>(kind: JobKind<P, C>, params: P, spendCap: number) =>
        queueJob(kind, params, spendCap).pipe(Effect.provideService(Db, db), Effect.map(view))

      const list = db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(100).pipe(
        Effect.map((rows) => rows.map(view)),
        Effect.orDie
      )

      const changedSince = (millis: number) =>
        db.select().from(jobs).where(gte(jobs.updatedAt, millis)).orderBy(desc(jobs.createdAt)).pipe(
          Effect.map((rows) => rows.map(view)),
          Effect.orDie
        )

      // Applies a change decided from the row as read. The update holds only
      // if nothing changed since the read, such as the worker claiming the
      // job; otherwise the decision is made again from the new row.
      const change = <E>(
        id: JobId,
        decide: (current: JobRow, now: number) => Effect.Effect<Partial<JobRow> | null, E>
      ): Effect.Effect<JobView, JobNotFound | E> =>
        Effect.gen(function*() {
          for (;;) {
            const current = yield* row(id)
            if (current === undefined) return yield* new JobNotFound()
            const now = yield* Clock.currentTimeMillis
            const changes = yield* decide(current, now)
            if (changes === null) return view(current)
            const [updated] = yield* db.update(jobs)
              .set({ ...changes, revision: nextRevision, updatedAt: now })
              .where(and(eq(jobs.id, id), eq(jobs.revision, current.revision)))
              .returning()
              .pipe(Effect.orDie)
            if (updated !== undefined) return view(updated)
          }
        })

      const notChangeable = (current: JobRow) => Effect.fail(new JobNotChangeable({ status: current.status as JobStatus }))

      type Decision<E> = Effect.Effect<Partial<JobRow> | null, E>

      const pause = (id: JobId) =>
        change(id, (current): Decision<JobNotChangeable> => {
          switch (current.status) {
            case "queued":
              return Effect.succeed({ status: "paused", note: PausedByCurator, resumeAt: null })
            case "paused":
              return Effect.succeed(
                current.resumeAt === null ? null : { note: PausedByCurator, resumeAt: null }
              )
            case "running":
              return Effect.succeed(current.requested === null ? { requested: "pause" } : null)
            default:
              return notChangeable(current)
          }
        })

      const resume = (id: JobId, spendCap: number | undefined) =>
        change(id, (current): Decision<JobNotChangeable | SpendCapTooLow> => {
          const cap = spendCap ?? current.spendCap
          switch (current.status) {
            case "paused":
            case "failed":
              return current.spend >= cap
                ? Effect.fail(new SpendCapTooLow({ spend: current.spend }))
                : Effect.succeed({
                  status: "queued",
                  note: null,
                  resumeAt: null,
                  requested: null,
                  spendCap: cap,
                  crashes: 0,
                  finishedAt: null
                })
            case "running":
            case "queued": {
              if (current.spend >= cap) return Effect.fail(new SpendCapTooLow({ spend: current.spend }))
              const undoPause = current.status === "running" && current.requested === "pause"
              if (!undoPause && cap === current.spendCap) return Effect.succeed(null)
              return Effect.succeed({ spendCap: cap, ...(undoPause ? { requested: null } : {}) })
            }
            default:
              return notChangeable(current)
          }
        })

      // What a job's kind does once the job is cancelled or fails. Its own
      // failure is logged, never the Curator's or the worker's.
      const afterStop = (id: string) =>
        Effect.gen(function*() {
          const current = yield* row(id)
          const kind = current === undefined ? undefined : kinds.get(current.kind)
          if (current === undefined || kind?.stopped === undefined) return
          const params = decodeJson(kind.params, current.params)
          if (Option.isNone(params)) return
          yield* kind.stopped(params.value).pipe(Effect.provideService(Db, db))
        }).pipe(Effect.catchCause((cause) => Effect.logError(`A stopped job's follow-up failed: ${Cause.pretty(cause)}`)))

      const cancel = (id: JobId) =>
        change(id, (current, now): Decision<JobNotChangeable> => {
          switch (current.status) {
            case "queued":
            case "paused":
            case "failed":
              return Effect.succeed({
                status: "cancelled",
                note: CancelledByCurator,
                resumeAt: null,
                requested: null,
                finishedAt: now
              })
            case "running":
              return Effect.succeed(current.requested === "cancel" ? null : { requested: "cancel" })
            default:
              return notChangeable(current)
          }
        }).pipe(Effect.tap((job) => (job.status === "cancelled" ? afterStop(id) : Effect.void)))

      const latestRevision = db.select({ revision: sql<number>`coalesce(max(${jobs.revision}), 0)` }).from(jobs).pipe(
        Effect.map((rows) => rows[0]?.revision ?? 0),
        Effect.orDie
      )

      const changesSince = (revision: number) =>
        db.select().from(jobs).where(gt(jobs.revision, revision)).orderBy(jobs.revision).limit(500).pipe(
          Effect.map((rows) => rows.map(view)),
          Effect.orDie
        )

      // Takes the oldest job that is waiting, due to resume, or left by a
      // worker that stopped. The claim is one statement, so two workers never
      // share a job.
      const claim = (workerId: string) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const staleBefore = now - StaleAfterMs
          const claimable = sql`(
            select ${jobs.id} from ${jobs}
            where ${jobs.status} = 'queued'
              or (${jobs.status} = 'paused' and ${jobs.resumeAt} is not null and ${jobs.resumeAt} <= ${now})
              or (${jobs.status} = 'running' and (${jobs.heartbeatAt} is null or ${jobs.heartbeatAt} < ${staleBefore}))
            order by ${jobs.createdAt}
            limit 1
          )`
          // A read first, so a worker with nothing to do never waits for the
          // write lock, which a restore holds for seconds.
          const [waiting] = yield* db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, claimable)).pipe(Effect.orDie)
          if (waiting === undefined) return Option.none()
          const [claimed] = yield* db.update(jobs)
            .set({
              status: "running",
              claimant: workerId,
              heartbeatAt: now,
              resumeAt: null,
              // A job still running here was left by a worker that stopped.
              crashes: sql`case when ${jobs.status} = 'running' then ${jobs.crashes} + 1 else ${jobs.crashes} end`,
              revision: nextRevision,
              updatedAt: now
            })
            .where(eq(jobs.id, claimable))
            .returning()
            .pipe(Effect.orDie)
          return Option.fromUndefinedOr(claimed)
        })

      const ours = (id: string, workerId: string) =>
        and(eq(jobs.id, id), eq(jobs.claimant, workerId), eq(jobs.status, "running"))

      const heartbeat = (id: string, workerId: string) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const [beat] = yield* db.update(jobs)
            .set({ heartbeatAt: now })
            .where(ours(id, workerId))
            .returning({ requested: jobs.requested })
            .pipe(Effect.orDie)
          return Option.map(Option.fromUndefinedOr(beat), (b) => ({ requested: asRequested(b.requested) }))
        })

      const saveStep = (id: string, workerId: string, save: StepSave) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const [saved] = yield* db.update(jobs)
            .set({
              checkpoint: save.checkpoint,
              stepsDone: save.stepsDone,
              stepsTotal: save.stepsTotal,
              note: save.note,
              heartbeatAt: now,
              crashes: 0,
              revision: nextRevision,
              updatedAt: now
            })
            .where(ours(id, workerId))
            .returning({ requested: jobs.requested })
            .pipe(Effect.orDie)
          return Option.map(Option.fromUndefinedOr(saved), (s) => ({ requested: asRequested(s.requested) }))
        })

      // Writes the end of the job's turn from the row as it is now, so a
      // request the Curator made while the step ran is not lost. The write
      // holds only if the row is unchanged since the read; otherwise the end
      // is settled again from the new row.
      const finish = (id: string, workerId: string, end: JobEnd) =>
        Effect.gen(function*() {
          for (;;) {
            const [current] = yield* db.select().from(jobs).where(ours(id, workerId)).pipe(Effect.orDie)
            if (current === undefined) return "lost" as const
            const settled = settleEnd(end, asRequested(current.requested))
            if (settled === "keep-running") return "running" as const
            const now = yield* Clock.currentTimeMillis
            const common = { claimant: null, requested: null, revision: nextRevision, updatedAt: now }
            const changes = settled._tag === "Done"
              ? { status: "done", note: null, result: settled.result, resumeAt: null, finishedAt: now }
              : settled._tag === "Failed"
              ? { status: "failed", note: settled.note, resumeAt: null, finishedAt: now }
              : settled._tag === "Paused"
              ? { status: "paused", note: settled.note, resumeAt: settled.resumeAt, finishedAt: null }
              : settled._tag === "Cancelled"
              ? { status: "cancelled", note: settled.note, resumeAt: null, finishedAt: now }
              : { status: "paused", note: PausedByCurator, resumeAt: null, finishedAt: null }
            const updated = yield* db.update(jobs)
              .set({ ...changes, ...common })
              .where(and(ours(id, workerId), eq(jobs.revision, current.revision)))
              .returning({ id: jobs.id })
              .pipe(Effect.orDie)
            if (updated.length > 0) {
              if (changes.status === "cancelled" || changes.status === "failed") yield* afterStop(id)
              return "ended" as const
            }
          }
        })

      const spendOf = (id: string) =>
        db.select({ spend: jobs.spend, cap: jobs.spendCap }).from(jobs).where(eq(jobs.id, id)).pipe(
          Effect.map((rows) => Option.fromUndefinedOr(rows[0])),
          Effect.orDie
        )

      const heartbeatStopped = (pid: number) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const [stuck] = yield* db.select({ id: jobs.id }).from(jobs)
            .where(and(
              eq(jobs.status, "running"),
              sql`${jobs.claimant} like ${`worker-${pid}-%`}`,
              sql`${jobs.heartbeatAt} < ${now - StaleAfterMs}`
            ))
            .limit(1)
            .pipe(Effect.orDie)
          return stuck !== undefined
        })

      return JobStore.of({
        heartbeatStopped,
        create,
        list,
        changedSince,
        pause,
        resume,
        cancel,
        latestRevision,
        changesSince,
        claim,
        heartbeat,
        saveStep,
        finish,
        spendOf
      })
    })
  )
}
