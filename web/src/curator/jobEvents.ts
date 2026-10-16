import { Schema } from "effect"
import { useEffect, useRef } from "react"
import { EventsPath, ServerEvent } from "../../../src/api/Events.ts"
import type { JobView } from "../../../src/api/Jobs.ts"
import { call } from "../api.ts"

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(ServerEvent))

// Keeps the newest version of each job, newest job first.
export const mergeJob = (jobs: ReadonlyArray<JobView>, changed: JobView): ReadonlyArray<JobView> => {
  const current = jobs.find((job) => job.id === changed.id)
  if (current !== undefined && current.revision >= changed.revision) return jobs
  const others = jobs.filter((job) => job.id !== changed.id)
  return [changed, ...others].toSorted((a, b) => b.createdAt - a.createdAt)
}

// The highest revision in a list of jobs, to open the stream after it.
export const latestRevision = (jobs: ReadonlyArray<JobView>) =>
  jobs.reduce((latest, job) => Math.max(latest, job.revision), 0)

// Listens for job changes after the given revision, which comes from what
// the page just read, so nothing between the read and the stream is missed;
// "now" listens from the moment the stream opens. The browser reconnects on
// its own after a dropped connection and resumes from the last change it
// received. When the stream closes for good, as it does once the Curator is
// locked, onClosed runs. Nothing opens while since is undefined.
export const useJobEvents = (
  since: number | "now" | undefined,
  onJob: (job: JobView) => void,
  onClosed: () => void
) => {
  const handlers = useRef({ onJob, onClosed })
  handlers.current = { onJob, onClosed }

  useEffect(() => {
    if (since === undefined) return
    const events = new EventSource(since === "now" ? EventsPath : `${EventsPath}?since=${since}`)
    events.onmessage = (message) => {
      const event = decodeEvent(message.data)
      if (event._tag === "Some" && event.value._tag === "JobChanged") handlers.current.onJob(event.value.job)
    }
    events.onerror = () => {
      if (events.readyState === EventSource.CLOSED) handlers.current.onClosed()
    }
    return () => events.close()
  }, [since])
}

// What a page does when its stream has closed for good: the Curator was
// locked, so the page asks for the passphrase; or the app restarted, so the
// page reads its data again and opens a new stream.
export const afterStreamClosed = async (
  reopen: () => unknown,
  onLocked: () => void,
  stillShown: () => boolean
) => {
  const status = await call((client) => client.curatorAccess.status())
  if (!stillShown()) return
  if (status._tag === "Success" && status.success.unlocked) {
    reopen()
    return
  }
  onLocked()
}
