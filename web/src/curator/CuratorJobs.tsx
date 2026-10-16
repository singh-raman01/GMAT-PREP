import { useCallback, useEffect, useId, useRef, useState } from "react"
import type { JobView } from "../../../src/api/Jobs.ts"
import { formatDollars } from "../../../src/api/money.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { clockTime, dayAndTime, endedAt } from "../format.ts"
import { linkProps } from "../router.ts"
import { afterStreamClosed, latestRevision, mergeJob, useJobEvents } from "./jobEvents.ts"

interface Props {
  readonly onLocked: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

export const CuratorJobs = ({ onLocked, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const [jobs, setJobs] = useState<ReadonlyArray<JobView>>()
  // The revision the events stream starts after: the list's highest.
  const [since, setSince] = useState<number>()
  const [announcement, setAnnouncement] = useState("")
  const mounted = useRef(true)

  const handle = useCallback(
    (failure: { readonly _tag: string }) => failure._tag === "CuratorNotUnlocked" ? onLocked() : onStopped(failure),
    [onLocked, onStopped]
  )

  const load = useCallback(async () => {
    const result = await call((client) => client.jobs.list())
    if (!mounted.current) return
    if (result._tag === "Failure") return handle(result.failure)
    setJobs(result.success)
    setSince(latestRevision(result.success))
  }, [handle])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
    }
  }, [load])

  // A job that ends its turn is announced, since the list changes without
  // the Curator doing anything.
  const shown = useRef(jobs)
  shown.current = jobs
  const changed = useCallback((job: JobView) => {
    const before = shown.current?.find((known) => known.id === job.id)
    if (
      before !== undefined && before.revision < job.revision && before.status !== job.status &&
      job.status !== "running"
    ) {
      setAnnouncement(`${job.label}: ${statusText(job)}`)
    }
    setJobs((current) => (current === undefined ? current : mergeJob(current, job)))
  }, [])

  useJobEvents(
    since,
    changed,
    () =>
      void afterStreamClosed(() => {
        setSince(undefined)
        return load()
      }, onLocked, () => mounted.current)
  )

  const act = async (job: JobView, action: "pause" | "resume" | "cancel", spendCap?: number) => {
    const result = await call((client) =>
      action === "pause"
        ? client.jobs.pause({ params: { id: job.id } })
        : action === "cancel"
        ? client.jobs.cancel({ params: { id: job.id } })
        : client.jobs.resume({ params: { id: job.id }, payload: spendCap === undefined ? {} : { spendCap } })
    )
    if (result._tag === "Success") {
      setJobs((current) => (current === undefined ? current : mergeJob(current, result.success)))
      return undefined
    }
    switch (result.failure._tag) {
      case "SpendCapTooLow":
        return `Raise the cap above ${formatDollars(result.failure.spend)}, which the job has already spent.`
      case "JobNotChangeable":
      case "JobNotFound":
        return "The job changed in the meantime; its latest state is shown."
      default:
        handle(result.failure)
        return undefined
    }
  }

  return (
    <>
      <h1 ref={heading} tabIndex={-1}>Jobs</h1>
      <p className="lede">
        Work the app does in the background, such as reading a book. Progress and spend update as it runs.
      </p>
      <p className="visually-hidden" role="status">{announcement}</p>
      {jobs === undefined
        ? <p className="quiet" aria-busy="true">Loading the jobs</p>
        : jobs.length === 0
        ? (
          <p className="empty">
            No jobs yet. <a {...linkProps("/curator/settings")}>Set up the LLM and test the connection</a> to run
            the first one.
          </p>
        )
        : (
          <ul className="jobs">
            {jobs.map((job) => <JobRow key={job.id} job={job} onAct={act} />)}
          </ul>
        )}
    </>
  )
}

const statusText = (job: JobView): string => {
  switch (job.status) {
    case "queued":
      return "Waiting to start"
    case "running":
      if (job.requested === "cancel") return "Cancelling"
      if (job.requested === "pause") return "Pausing after this step"
      return job.stepsTotal === null || job.stepsTotal <= 1
        ? "Running"
        : `Running: step ${Math.min(job.stepsDone + 1, job.stepsTotal)} of ${job.stepsTotal}`
    case "paused":
      return job.resumeAt === null ? "Paused" : `Paused until ${clockTime(job.resumeAt)}`
    case "failed":
      return "Failed"
    case "done":
      return "Done"
    case "cancelled":
      return "Cancelled"
  }
}

const JobRow = (
  { job, onAct }: {
    readonly job: JobView
    readonly onAct: (job: JobView, action: "pause" | "resume" | "cancel", spendCap?: number) => Promise<string | undefined>
  }
) => {
  const capId = useId()
  const [problem, setProblem] = useState<string>()
  const [cap, setCap] = useState("")
  // Resuming a job that has spent its cap needs a higher one.
  const capReached = (job.status === "paused" || job.status === "failed") && job.resumeAt === null &&
    job.spend >= job.spendCap
  const canPause = job.status === "queued" || (job.status === "running" && job.requested === null)
  const canResume = job.status === "paused" || job.status === "failed"
  const canCancel = job.status === "queued" || job.status === "paused" || job.status === "failed" ||
    (job.status === "running" && job.requested !== "cancel")

  const run = async (action: "pause" | "resume" | "cancel") => {
    let spendCap: number | undefined
    if (action === "resume" && capReached) {
      spendCap = Number(cap)
      if (!Number.isFinite(spendCap) || spendCap <= job.spend) {
        return setProblem(`Enter a cap above ${formatDollars(job.spend)}.`)
      }
    }
    setProblem(await onAct(job, action, spendCap))
  }

  const progress = job.stepsTotal !== null && job.stepsTotal > 1 && job.status !== "done"
    ? Math.min(1, job.stepsDone / job.stepsTotal)
    : undefined

  return (
    <li className="job" data-status={job.status}>
      <div className="job-head">
        <h2 className="job-label">{job.label}</h2>
        <p className="job-status">{statusText(job)}</p>
      </div>
      {progress !== undefined && (
        <div
          className="progress"
          role="progressbar"
          aria-label={`${job.label} progress`}
          aria-valuemin={0}
          aria-valuemax={job.stepsTotal ?? 0}
          aria-valuenow={job.stepsDone}
        >
          <div className="progress-done" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      {job.note !== null && <p className={job.status === "failed" ? "job-note problem" : "job-note"}>{job.note}</p>}
      {job.result !== null && <p className="job-result">{job.result}</p>}
      <p className="job-meta">
        Spent {formatDollars(job.spend)} of a {formatDollars(job.spendCap)} cap. Started {dayAndTime(job.createdAt)}
        {job.finishedAt === null ? "" : `, ended ${endedAt(job.createdAt, job.finishedAt)}`}.
      </p>
      {(canPause || canResume || canCancel) && (
        <div className="actions">
          {capReached && (
            <div className="field cap-field">
              <label htmlFor={capId}>New cap in dollars</label>
              <input
                id={capId}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={cap}
                onChange={(event) => setCap(event.target.value)}
              />
            </div>
          )}
          {canPause && <button type="button" className="button button-quiet" onClick={() => void run("pause")}>Pause</button>}
          {canResume && (
            <button type="button" className="button button-quiet" onClick={() => void run("resume")}>
              {job.status === "failed" ? "Try again" : "Resume"}
            </button>
          )}
          {canCancel && <button type="button" className="button button-quiet" onClick={() => void run("cancel")}>Cancel job</button>}
        </div>
      )}
      {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
    </li>
  )
}
