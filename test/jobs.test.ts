import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Option, Schema } from "effect"
import type { JobView } from "../src/api/Jobs.ts"
import { type JobKind, JobStepFailed } from "../src/server/jobs/JobKind.ts"
import { JobStore, settleEnd } from "../src/server/jobs/JobStore.ts"
import { ConnectionTest } from "../src/server/jobs/kinds/connectionTest.ts"
import { LlmAdapter } from "../src/server/llm/LlmAdapter.ts"
import { FakeLlm } from "../src/server/llm/LlmTransport.ts"
import { ApiKeyStore } from "../src/server/settings/ApiKeyStore.ts"
import { Settings } from "../src/server/settings/Settings.ts"
import { advanceUntil, openBrowser, runWithWorker, runWithWorkers, TestWorkers } from "./harness.ts"

const passphrase = "correct horse battery"

// 1000 tokens in and 200 out at $2 and $8 per million: $0.0036 a call.
const CallCost = 0.0036

const configure = Effect.gen(function*() {
  const settings = yield* Settings
  const keys = yield* ApiKeyStore
  yield* settings.saveLlm({
    baseUrl: "https://api.example.com/v1",
    jsonMode: "json-schema",
    models: [{ task: "tagging", model: "small-model" }],
    prices: [{ model: "small-model", inputPerMillion: 2, outputPerMillion: 8 }]
  })
  yield* keys.save("sk-test-12345678")
})

// The fake model sends back whatever word the request asks for.
const echoWords = Effect.gen(function*() {
  const fake = yield* FakeLlm
  yield* fake.respondWith((request) => {
    const word = /word set to "([a-z]+)"/.exec(request.messages.at(-1)?.content ?? "")?.[1] ?? "none"
    return { content: JSON.stringify({ ok: true, word }), tokensIn: 1000, tokensOut: 200 }
  })
})

// A job of a given number of steps, each one LLM call. It notes every step it
// starts, and a step can be held until the test lets it go, the first time it
// runs; a hold never let go stands in for a worker killed part way through.
const makeCounting = () => {
  const started: Array<number> = []
  const holds = new Map<number, Deferred.Deferred<void>>()
  const hold = (step: number) =>
    Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      holds.set(step, gate)
      return Deferred.succeed(gate, undefined)
    })
  const Params = Schema.Struct({ steps: Schema.Int })
  const Checkpoint = Schema.Struct({ done: Schema.Int })
  const Reply = Schema.Struct({ ok: Schema.Boolean, word: Schema.String })
  const kind: JobKind<typeof Params.Type, typeof Checkpoint.Type> = {
    kind: "counting",
    params: Params,
    checkpoint: Checkpoint,
    label: (params) => `Count to ${params.steps}`,
    start: () => ({ done: 0 }),
    stepsTotal: (params) => params.steps,
    step: ({ jobId, params, checkpoint }) =>
      Effect.gen(function*() {
        const step = checkpoint.done + 1
        started.push(step)
        const gate = holds.get(step)
        if (gate !== undefined) {
          holds.delete(step)
          yield* Deferred.await(gate)
        }
        const llm = yield* LlmAdapter
        const reply = yield* llm.call({
          task: "tagging",
          promptVersion: "counting@1",
          system: "Count.",
          user: `Reply with ok set to true and word set to "step".`,
          output: Reply,
          jobId
        })
        if (reply.value.word !== "step") return yield* new JobStepFailed({ message: "wrong word" })
        return step === params.steps
          ? { _tag: "Finished" as const, result: `Counted to ${params.steps}.` }
          : { _tag: "Continue" as const, checkpoint: { done: step }, stepsTotal: params.steps, note: `Step ${step} done` }
      })
  }
  return { kind, started, hold }
}

const jobById = (id: string) =>
  Effect.gen(function*() {
    const store = yield* JobStore
    return (yield* store.list).find((job) => job.id === id)
  })

const whenJob = (id: string, ready: (job: JobView) => boolean) =>
  jobById(id).pipe(Effect.map((job) => (job !== undefined && ready(job) ? job : undefined)))

describe("Jobs", () => {
  test("a connection test runs one LLM call end to end and shows its spend", () =>
    runWithWorker(Effect.gen(function*() {
      yield* configure
      yield* echoWords
      const curator = yield* openBrowser
      yield* curator.curatorAccess.setPassphrase({ payload: { passphrase } })
      const queued = yield* curator.jobs.testConnection({ payload: { task: "tagging" } })
      expect(queued.status).toBe("queued")
      expect(queued.label).toBe("Connection test: Tagging on small-model")
      const done = yield* advanceUntil(
        curator.jobs.list().pipe(Effect.map((jobs) => jobs.find((job) => job.id === queued.id && job.status === "done")))
      )
      expect(done.spend).toBeCloseTo(CallCost, 12)
      expect(done.spendCap).toBe(0.05)
      expect(done.result).toBe("small-model replied as asked, using 1200 tokens for $0.0036.")
      expect(done.stepsDone).toBe(0)
      expect(done.finishedAt).not.toBeNull()
    })))

  test("a connection test needs the LLM settings first, and says which are missing", () =>
    runWithWorker(Effect.gen(function*() {
      const curator = yield* openBrowser
      yield* curator.curatorAccess.setPassphrase({ payload: { passphrase } })
      const error = yield* curator.jobs.testConnection({ payload: { task: "lessons" } }).pipe(Effect.flip)
      expect(error._tag === "LlmNotConfigured" && error.missing).toEqual([
        "the API base URL",
        "the API key",
        "a model for Lessons"
      ])
    })))

  test("a worker killed part way resumes from the last saved step, without repeating finished steps", async () => {
    const counting = makeCounting()
    await runWithWorkers(
      Effect.gen(function*() {
        yield* counting.hold(3)
        yield* configure
        const fake = yield* FakeLlm
        yield* fake.respondWith(() => ({ content: JSON.stringify({ ok: true, word: "step" }) }))
        const store = yield* JobStore
        const job = yield* store.create(counting.kind, { steps: 4 }, 1)
        const workers = yield* TestWorkers

        const first = yield* workers.start
        yield* advanceUntil(whenJob(job.id, (current) => current.stepsDone === 2 && counting.started.includes(3)))
        yield* Fiber.interrupt(first)

        yield* workers.start
        // The first worker's heartbeat is still fresh, so its job is left alone.
        yield* advanceUntil(Effect.succeed(undefined), { maxSteps: 20 }).pipe(Effect.ignore)
        expect((yield* jobById(job.id))?.stepsDone).toBe(2)
        expect(counting.started).toEqual([1, 2, 3])

        const done = yield* advanceUntil(whenJob(job.id, (current) => current.status === "done"))
        expect(counting.started).toEqual([1, 2, 3, 3, 4])
        expect(done.stepsDone).toBe(3)
        expect(done.result).toBe("Counted to 4.")
        expect((yield* fake.requests).length).toBe(4)
      }),
      [counting.kind]
    )
  })

  test("a job pauses at its last saved step when it reaches its spend cap, and resumes once the cap is raised", async () => {
    const counting = makeCounting()
    await runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const fake = yield* FakeLlm
        yield* fake.respondWith(() => ({ content: JSON.stringify({ ok: true, word: "step" }), tokensIn: 1000, tokensOut: 200 }))
        const store = yield* JobStore
        const job = yield* store.create(counting.kind, { steps: 4 }, 0.005)
        const paused = yield* advanceUntil(whenJob(job.id, (current) => current.status === "paused"))
        expect(paused.stepsDone).toBe(2)
        expect(paused.spend).toBeCloseTo(2 * CallCost, 12)
        expect(paused.note).toBe("The spend cap is reached: $0.0072 of $0.005. Raise the cap to continue.")
        expect(paused.resumeAt).toBeNull()

        const tooLow = yield* store.resume(job.id, undefined).pipe(Effect.flip)
        expect(tooLow._tag).toBe("SpendCapTooLow")
        yield* store.resume(job.id, 0.05)
        const done = yield* advanceUntil(whenJob(job.id, (current) => current.status === "done"))
        expect(done.spend).toBeCloseTo(4 * CallCost, 12)
        expect(counting.started).toEqual([1, 2, 3, 4])
      }),
      [counting.kind]
    )
  })

  test("a job pauses while the API keeps failing, and resumes on its own", async () => {
    const counting = makeCounting()
    await runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const fake = yield* FakeLlm
        let failing = true
        yield* fake.respondWith(() =>
          failing ? { status: 503, message: "overloaded" } : { content: JSON.stringify({ ok: true, word: "step" }) }
        )
        const store = yield* JobStore
        const job = yield* store.create(counting.kind, { steps: 1 }, 1)
        const paused = yield* advanceUntil(whenJob(job.id, (current) => current.status === "paused"), { step: "5 seconds" })
        expect(paused.note).toBe("The API is not responding (503: overloaded). The job resumes on its own.")
        expect(paused.resumeAt).not.toBeNull()
        failing = false
        const done = yield* advanceUntil(whenJob(job.id, (current) => current.status === "done"), { step: "10 seconds" })
        expect(done.result).toBe("Counted to 1.")
      }),
      [counting.kind]
    )
  })

  test("a reply that stays invalid fails the job with the error, and resuming tries again", () =>
    runWithWorker(Effect.gen(function*() {
      yield* configure
      const fake = yield* FakeLlm
      yield* fake.reply({ content: "no" }, { content: "still no" })
      yield* echoWords
      const store = yield* JobStore
      const job = yield* store.create(ConnectionTest, { task: "tagging" as const, model: "small-model", word: "apple" }, 1)
      const failed = yield* advanceUntil(whenJob(job.id, (current) => current.status === "failed"))
      expect(failed.note).toBe(
        "The model's reply could not be used, even after a retry: the reply was not valid JSON"
      )
      yield* store.resume(job.id, undefined)
      const done = yield* advanceUntil(whenJob(job.id, (current) => current.status === "done"))
      expect(done.note).toBeNull()
    })))

  test("the Curator can pause, resume and cancel a waiting job", () =>
    runWithWorkers(Effect.gen(function*() {
      const curator = yield* openBrowser
      yield* curator.curatorAccess.setPassphrase({ payload: { passphrase } })
      yield* configure
      const job = yield* curator.jobs.testConnection({ payload: { task: "tagging" } })
      const paused = yield* curator.jobs.pause({ params: { id: job.id } })
      expect(paused).toMatchObject({ status: "paused", note: "Paused by the Curator" })
      const resumed = yield* curator.jobs.resume({ params: { id: job.id }, payload: {} })
      expect(resumed.status).toBe("queued")
      const cancelled = yield* curator.jobs.cancel({ params: { id: job.id } })
      expect(cancelled).toMatchObject({ status: "cancelled", note: "Cancelled by the Curator" })
      const again = yield* curator.jobs.resume({ params: { id: job.id }, payload: {} }).pipe(Effect.flip)
      expect(again._tag).toBe("JobNotChangeable")
      expect(yield* curator.jobs.pause({ params: { id: job.id } }).pipe(Effect.flip, Effect.map((e) => e._tag)))
        .toBe("JobNotChangeable")
    })))

  test("cancelling a running job stops it at once; pausing waits for its step to be saved", async () => {
    const counting = makeCounting()
    await runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const fake = yield* FakeLlm
        yield* fake.respondWith(() => ({ content: JSON.stringify({ ok: true, word: "step" }) }))
        const store = yield* JobStore

        yield* counting.hold(1)
        const hanging = yield* store.create(counting.kind, { steps: 3 }, 1)
        yield* advanceUntil(whenJob(hanging.id, (current) => current.status === "running"))
        const asked = yield* store.cancel(hanging.id)
        expect(asked).toMatchObject({ status: "running", requested: "cancel" })
        const cancelled = yield* advanceUntil(whenJob(hanging.id, (current) => current.status === "cancelled"))
        expect(cancelled.note).toBe("Cancelled by the Curator")

        const release = yield* counting.hold(2)
        const second = yield* store.create(counting.kind, { steps: 3 }, 1)
        yield* advanceUntil(whenJob(second.id, (current) => current.stepsDone === 1 && counting.started.at(-1) === 2))
        expect(yield* store.pause(second.id)).toMatchObject({ status: "running", requested: "pause" })
        yield* release
        const paused = yield* advanceUntil(whenJob(second.id, (current) => current.status === "paused"))
        expect(paused).toMatchObject({ note: "Paused by the Curator", stepsDone: 2, resumeAt: null })
      }),
      [counting.kind]
    )
  })

  test("a pause asked while a step runs into an API outage waits for the Curator", async () => {
    const counting = makeCounting()
    await runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const fake = yield* FakeLlm
        // A long Retry-After ends the call at once as unavailable.
        yield* fake.respondWith(() => ({ status: 429, retryAfterMs: 120_000 }))
        const store = yield* JobStore
        const release = yield* counting.hold(1)
        const job = yield* store.create(counting.kind, { steps: 2 }, 1)
        yield* advanceUntil(whenJob(job.id, (current) => current.status === "running" && counting.started.includes(1)))
        yield* store.pause(job.id)
        yield* release
        const paused = yield* advanceUntil(whenJob(job.id, (current) => current.status === "paused"))
        expect(paused).toMatchObject({ note: "Paused by the Curator", resumeAt: null })
        // It does not resume on its own.
        yield* advanceUntil(Effect.succeed(undefined), { step: "1 minute", maxSteps: 10 }).pipe(Effect.ignore)
        expect((yield* jobById(job.id))?.status).toBe("paused")
        expect(yield* fake.requests).toHaveLength(1)
      }),
      [counting.kind]
    )
  })

  test("a cancel asked just before an API outage still cancels the job", async () => {
    const counting = makeCounting()
    await runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const fake = yield* FakeLlm
        yield* fake.respondWith(() => ({ status: 429, retryAfterMs: 120_000 }))
        const store = yield* JobStore
        const release = yield* counting.hold(1)
        const job = yield* store.create(counting.kind, { steps: 2 }, 1)
        yield* advanceUntil(whenJob(job.id, (current) => current.status === "running" && counting.started.includes(1)))
        // Released before the next heartbeat could see the cancel.
        yield* store.cancel(job.id)
        yield* release
        const cancelled = yield* advanceUntil(whenJob(job.id, (current) => current.status === "cancelled"), {
          step: "100 millis"
        })
        expect(cancelled.note).toBe("Cancelled by the Curator")
      }),
      [counting.kind]
    )
  })

  test("a pause the Curator takes back before the worker ends its turn leaves the job running", async () => {
    const counting = makeCounting()
    await runWithWorkers(
      Effect.gen(function*() {
        const store = yield* JobStore
        const job = yield* store.create(counting.kind, { steps: 2 }, 1)
        const claimed = yield* store.claim("worker-a")
        expect(Option.isSome(claimed)).toBe(true)
        yield* store.pause(job.id)
        yield* store.resume(job.id, undefined)
        expect(yield* store.finish(job.id, "worker-a", { _tag: "PausedOnRequest" })).toBe("running")
        expect((yield* jobById(job.id))).toMatchObject({ status: "running", requested: null })
        expect(yield* store.finish(job.id, "worker-a", { _tag: "Done", result: "Counted." })).toBe("ended")
        expect((yield* jobById(job.id))?.status).toBe("done")
        expect(yield* store.finish(job.id, "worker-a", { _tag: "Done", result: "Again." })).toBe("lost")
      }),
      [counting.kind]
    )
  })

  test("what the Curator asked while a step ran decides how the job's turn ends", () => {
    const outage = { _tag: "Paused", note: "The API is not responding", resumeAt: 1000 } as const
    const failed = { _tag: "Failed", note: "Bad reply" } as const
    const done = { _tag: "Done", result: "Done." } as const
    const cancelled = { _tag: "Cancelled", note: "Cancelled by the Curator" } as const
    const pausedByCurator = { _tag: "Paused", note: "Paused by the Curator", resumeAt: null } as const
    expect(settleEnd(outage, "cancel")).toEqual(cancelled)
    expect(settleEnd(failed, "cancel")).toEqual(cancelled)
    expect(settleEnd(done, "cancel")).toEqual(done)
    expect(settleEnd(outage, "pause")).toEqual(pausedByCurator)
    expect(settleEnd(failed, "pause")).toEqual(failed)
    expect(settleEnd(outage, null)).toEqual(outage)
    expect(settleEnd({ _tag: "PausedOnRequest" }, "pause")).toEqual(pausedByCurator)
    expect(settleEnd({ _tag: "PausedOnRequest" }, "cancel")).toEqual(cancelled)
    expect(settleEnd({ _tag: "PausedOnRequest" }, null)).toBe("keep-running")
  })
})
