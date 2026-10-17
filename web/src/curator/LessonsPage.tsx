import { type FormEvent, Fragment, useCallback, useEffect, useId, useRef, useState } from "react"
import {
  type CuratorLessonRow,
  type CuratorLessonsView,
  DefaultLessonSpendCap,
  LessonId,
  type LessonStatus,
  type LessonView
} from "../../../src/api/Lessons.ts"
import { call } from "../api.ts"
import { useFocusOnMount, useFocusWhenReady } from "../focus.ts"
import { dayAndTime } from "../format.ts"
import { LessonContent } from "../lessons/LessonPage.tsx"
import { linkProps, navigate } from "../router.ts"
import { afterStreamClosed, useJobEvents } from "./jobEvents.ts"

// The Curator's Lessons (decisions 95 to 98): every subject with where its
// Lesson stands, the job that writes those needed, and each version to read
// as a Learner would, a draft to approve or turn down.

interface Props {
  readonly onLocked: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const statusWords: Record<LessonStatus, string> = { draft: "waiting", approved: "approved", rejected: "turned down" }

// Where a subject's Lesson stands, in a few words.
const stateText = (row: CuratorLessonRow, fewest: number) => {
  const parts: Array<string> = []
  if (row.approved !== null) parts.push(`Version ${row.approved.version} approved ${dayAndTime(row.approved.at)}.`)
  if (row.marked !== null) parts.push(`To write again: ${row.marked}`)
  if (row.draft !== null) parts.push(`Version ${row.draft.version} waits for you.`)
  if (row.rejected !== null) parts.push(`Version ${row.rejected.version} turned down: ${row.rejected.note}`)
  if (row.approved === null && row.draft === null && row.rejected === null) {
    parts.push(row.questions < fewest
      ? `No Lesson: ${plural(row.questions, "Question", "Questions")} to teach from, and it needs ${fewest}.`
      : "No Lesson yet.")
  }
  return parts.join(" ")
}

// A subject's row: where it stands, with a link to each version written.
const LessonRowItem = ({ row, fewest, running, onWrite }: {
  readonly row: CuratorLessonRow
  readonly fewest: number
  readonly running: boolean
  readonly onWrite: () => void
}) => {
  // The versions the buttons and the note do not link already.
  const linked = new Set([row.draft?.id, row.draft === null ? row.approved?.id : undefined, row.rejected?.id])
  const earlier = row.versions.filter((each) => !linked.has(each.id))
  return (
    <li>
      <span className="set-name">{row.subject.name}</span>
      <span className="set-facts">
        {row.subject.kind === "skill" ? row.subject.topic?.name ?? "Skill" : "Question Type"}. {stateText(row, fewest)}
        {row.rejected !== null && (
          <>
            {" "}
            <a {...linkProps(`/curator/lessons/${row.rejected.id}`)}>
              Read version {row.rejected.version}
              <span className="visually-hidden"> on {row.subject.name}, turned down</span>
            </a>
          </>
        )}
        {earlier.length > 0 && (
          <>
            {" "}
            {earlier.length === 1 ? "Earlier version:" : "Earlier versions:"}{" "}
            {earlier.map((each, index) => (
              <Fragment key={each.id}>
                {index > 0 && "; "}
                <a {...linkProps(`/curator/lessons/${each.id}`)}>
                  version {each.version}
                  <span className="visually-hidden"> on {row.subject.name}</span>
                </a>, {statusWords[each.status]}
              </Fragment>
            ))}.
          </>
        )}
      </span>
      {row.draft !== null && (
        <a className="button button-quiet" {...linkProps(`/curator/lessons/${row.draft.id}`)}>
          Read the draft<span className="visually-hidden"> on {row.subject.name}</span>
        </a>
      )}
      {row.draft === null && row.approved !== null && (
        <a className="button button-quiet" {...linkProps(`/curator/lessons/${row.approved.id}`)}>
          Read it<span className="visually-hidden"> on {row.subject.name}</span>
        </a>
      )}
      {row.draft === null && row.questions >= fewest && (
        <button type="button" className="button button-quiet" aria-disabled={running} onClick={onWrite}>
          {row.approved === null && row.rejected === null ? "Write it" : "Write it again"}
          <span className="visually-hidden"> on {row.subject.name}</span>
        </button>
      )}
    </li>
  )
}

export const CuratorLessons = ({ onLocked, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const capId = useId()
  const [view, setView] = useState<CuratorLessonsView>()
  const [since, setSince] = useState<"now">()
  const [cap, setCap] = useState(String(DefaultLessonSpendCap))
  const [problem, setProblem] = useState<string>()
  // Whether a Write was refused while a job had not finished; the page says
  // so for as long as that job runs.
  const [refused, setRefused] = useState(false)
  const mounted = useRef(true)
  const busy = useRef(false)

  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "CuratorNotUnlocked" ? onLocked() : onStopped(failure)),
    [onLocked, onStopped]
  )
  const load = useCallback(async () => {
    const result = await call((client) => client.curatorLessons.overview())
    if (!mounted.current) return
    if (result._tag === "Failure") return handle(result.failure)
    setView(result.success)
    setSince("now")
  }, [handle])
  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
    }
  }, [load])
  useJobEvents(
    since,
    (job) => {
      if (job.kind === "lesson-writing") void load()
    },
    () => void afterStreamClosed(load, onLocked, () => mounted.current)
  )

  const job = view?.job ?? null
  // A paused job holds its place until it is resumed or cancelled in Jobs.
  const running = job !== null && (job.status === "queued" || job.status === "running" || job.status === "paused")
  useEffect(() => {
    if (!running) setRefused(false)
  }, [running])

  const write = async (subjects: ReadonlyArray<string> | undefined) => {
    if (busy.current) return
    setProblem(undefined)
    if (running) return setRefused(true)
    const spendCap = Number(cap)
    if (!Number.isFinite(spendCap) || spendCap <= 0 || spendCap > 10_000) {
      return setProblem("Give a spend cap above 0 and up to 10,000 dollars.")
    }
    busy.current = true
    const result = await call((client) =>
      client.curatorLessons.write({ payload: { spendCap, ...(subjects === undefined ? {} : { subjects: [...subjects] }) } })
    )
    busy.current = false
    if (result._tag === "Success") return void load()
    switch (result.failure._tag) {
      case "LessonJobRunning":
        setRefused(true)
        return void load()
      case "LlmNotConfigured":
        return setProblem(`Set ${result.failure.missing.join(", ")} in Settings first.`)
      case "NothingToWrite":
        return setProblem("Every subject has a Lesson, or too few Questions to write one.")
      default:
        return handle(result.failure)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (view?.needed === 0 && !running) return setProblem("Every subject has a Lesson, or too few Questions to write one.")
    void write(undefined)
  }

  if (view === undefined) {
    return (
      <>
        <h1 ref={heading} tabIndex={-1}>Lessons</h1>
        <p className="quiet" aria-busy="true">Reading the Lessons</p>
      </>
    )
  }
  const approved = view.rows.filter((row) => row.approved !== null).length
  const waiting = view.rows.filter((row) => row.draft !== null).length
  const marked = view.rows.filter((row) => row.marked !== null).length
  const short = view.rows.filter((row) => row.approved === null && row.questions < view.fewest).length
  const sections = [...new Map(view.rows.map((row) => [row.subject.section.id, row.subject.section])).values()]
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>Lessons</h1>
      <p className="lede">
        A Lesson for each Skill and Question Type, written from its published Questions outside the Mock Reserve.
        Learners see each one once you approve it.
      </p>
      <p className="group-about">
        {approved} of {plural(view.rows.length, "subject", "subjects")} approved, {waiting} waiting for you, {marked} to write
        again, {short} with too few Questions.
      </p>
      {job !== null && (
        <p className="hint">
          {running
            ? `${job.label}: ${job.stepsDone} of ${job.stepsTotal ?? "?"} done${job.status === "paused" ? ", paused" : ""}.`
            : `${job.label}: ${job.result ?? job.note ?? job.status}`}{" "}
          <a {...linkProps("/curator/jobs")}>Jobs</a>
        </p>
      )}
      <form className="lesson-write" onSubmit={submit}>
        <div className="field">
          <label htmlFor={capId}>Spend cap, dollars</label>
          <input id={capId} className="number-input" type="text" inputMode="decimal" value={cap} onChange={(event) => setCap(event.target.value)} />
        </div>
        <button type="submit" className="button" aria-disabled={view.needed === 0 || running}>
          {view.needed === 0 ? "Nothing to write" : `Write the ${plural(view.needed, "Lesson", "Lessons")} needed`}
        </button>
      </form>
      {refused && running && (
        <p className="problem" role="alert">
          {job?.status === "paused"
            ? "The last Lesson job is paused. Resume it in Jobs, or cancel it there to start another."
            : "A Lesson job is running already. The Lessons it writes show here as it goes."}
        </p>
      )}
      {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
      {sections.map((section) => (
        <section key={section.id} className="group" data-section={section.id} aria-labelledby={`curator-lessons-${section.id}`}>
          <h2 id={`curator-lessons-${section.id}`}>
            <span className="swatch" aria-hidden="true" /> {section.name}
          </h2>
          <ul className="set-list lesson-rows">
            {view.rows.filter((row) => row.subject.section.id === section.id).map((row) => (
              <LessonRowItem
                key={row.subject.id}
                row={row}
                fewest={view.fewest}
                running={running}
                onWrite={() => void write([row.subject.id])}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}

// One version, as a Learner would read it, with the decision on a draft.
export const CuratorLesson = ({ id, onLocked, onStopped }: Props & { readonly id: string }) => {
  const noteId = useId()
  const [lesson, setLesson] = useState<LessonView | null>()
  const heading = useFocusWhenReady<HTMLHeadingElement>(lesson !== undefined)
  const noteField = useRef<HTMLTextAreaElement>(null)
  const [note, setNote] = useState("")
  const [rejecting, setRejecting] = useState(false)
  const [problem, setProblem] = useState<string>()
  const busy = useRef(false)
  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "CuratorNotUnlocked" ? onLocked() : onStopped(failure)),
    [onLocked, onStopped]
  )
  useEffect(() => {
    let live = true
    void call((client) => client.curatorLessons.lesson({ params: { id: LessonId.make(id) } })).then((result) => {
      if (!live) return
      if (result._tag === "Success") return setLesson(result.success)
      if (result.failure._tag === "LessonNotFound") return setLesson(null)
      handle(result.failure)
    })
    return () => {
      live = false
    }
  }, [id, handle])
  // The note is what turning it down asks for, so it takes focus.
  useEffect(() => {
    if (rejecting) noteField.current?.focus()
  }, [rejecting])

  const decide = async (approve: boolean) => {
    if (busy.current || lesson == null) return
    if (!approve && note.trim() === "") return setProblem("Say what to change, so the next version can be judged against it.")
    busy.current = true
    setProblem(undefined)
    const result = await call((client) =>
      approve
        ? client.curatorLessons.approve({ params: { id: lesson.id } })
        : client.curatorLessons.reject({ params: { id: lesson.id }, payload: { note: note.trim() } })
    )
    busy.current = false
    if (result._tag === "Success") return navigate("/curator/lessons")
    if (result.failure._tag === "LessonNotDraft") {
      return setProblem(`This version is already ${result.failure.status}. Go back to the Lessons to see where it stands.`)
    }
    handle(result.failure)
  }

  if (lesson === undefined) return <p className="quiet" aria-busy="true">Opening the Lesson</p>
  if (lesson === null) {
    return (
      <>
        <h1 ref={heading} tabIndex={-1}>No such Lesson</h1>
        <p className="empty">This Lesson is not in the app. <a {...linkProps("/curator/lessons")}>Lessons</a></p>
      </>
    )
  }
  return (
    <article className="lesson" data-section={lesson.subject.section.id}>
      <p className="back">
        <a className="quiet-link" {...linkProps("/curator/lessons")}>Lessons</a>
      </p>
      <h1 ref={heading} tabIndex={-1}>{lesson.subject.name}</h1>
      <p className="lede">
        Version {lesson.version}, {lesson.status === "draft" ? "waiting for you" : statusWords[lesson.status]}, written{" "}
        {dayAndTime(lesson.writtenAt)}. About {plural(lesson.minutes, "minute", "minutes")} to read; its check holds{" "}
        {plural(lesson.checkQuestions, "Question", "Questions")} now.
      </p>
      <LessonContent lesson={lesson} part="whole" />
      {lesson.status === "draft" && (
        <section className="group lesson-decision" aria-labelledby="lesson-decision">
          <h2 id="lesson-decision">Your decision</h2>
          {rejecting
            ? (
              <div className="field">
                <label htmlFor={noteId}>What to change</label>
                <textarea
                  ref={noteField}
                  id={noteId}
                  rows={3}
                  maxLength={2000}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </div>
            )
            : null}
          <div className="actions">
            {rejecting
              ? (
                <>
                  <button type="button" className="button" onClick={() => void decide(false)}>Turn it down</button>
                  <button type="button" className="button button-quiet" onClick={() => setRejecting(false)}>Cancel</button>
                </>
              )
              : (
                <>
                  <button type="button" className="button" onClick={() => void decide(true)}>Approve it</button>
                  <button type="button" className="button button-quiet" onClick={() => setRejecting(true)}>Turn it down</button>
                </>
              )}
          </div>
          {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
        </section>
      )}
    </article>
  )
}
