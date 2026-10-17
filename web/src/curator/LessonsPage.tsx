import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react"
import {
  type CuratorLessonRow,
  type CuratorLessonsView,
  DefaultLessonSpendCap,
  LessonId,
  type LessonView
} from "../../../src/api/Lessons.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { dayAndTime } from "../format.ts"
import { LessonContent } from "../lessons/LessonPage.tsx"
import { linkProps, navigate } from "../router.ts"
import { afterStreamClosed, useJobEvents } from "./jobEvents.ts"

// The Curator's Lessons (decisions 95 to 98): every subject with where its
// Lesson stands, the job that writes those needed, and each draft to read
// as a Learner would before approving or rejecting it.

interface Props {
  readonly onLocked: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

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

export const CuratorLessons = ({ onLocked, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const capId = useId()
  const [view, setView] = useState<CuratorLessonsView>()
  const [since, setSince] = useState<"now">()
  const [cap, setCap] = useState(String(DefaultLessonSpendCap))
  const [problem, setProblem] = useState<string>()
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

  const write = async (subjects: ReadonlyArray<string> | undefined) => {
    if (busy.current) return
    const spendCap = Number(cap)
    if (!Number.isFinite(spendCap) || spendCap <= 0 || spendCap > 10_000) {
      return setProblem("Give a spend cap above 0 and up to 10,000 dollars.")
    }
    busy.current = true
    setProblem(undefined)
    const result = await call((client) =>
      client.curatorLessons.write({ payload: { spendCap, ...(subjects === undefined ? {} : { subjects: [...subjects] }) } })
    )
    busy.current = false
    if (result._tag === "Success") return void load()
    if (result.failure._tag === "LlmNotConfigured") {
      return setProblem(`Set ${result.failure.missing.join(", ")} in Settings first.`)
    }
    if (result.failure._tag === "NothingToWrite") return setProblem("Every subject has a Lesson, or too few Questions to write one.")
    handle(result.failure)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void write(undefined)
  }

  if (view === undefined) return <p className="quiet" aria-busy="true">Reading the Lessons</p>
  const approved = view.rows.filter((row) => row.approved !== null).length
  const waiting = view.rows.filter((row) => row.draft !== null).length
  const marked = view.rows.filter((row) => row.marked !== null).length
  const short = view.rows.filter((row) => row.approved === null && row.questions < view.fewest).length
  const job = view.job
  const running = job !== null && (job.status === "queued" || job.status === "running" || job.status === "paused")
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
      {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
      {sections.map((section) => (
        <section key={section.id} className="group" data-section={section.id} aria-labelledby={`curator-lessons-${section.id}`}>
          <h2 id={`curator-lessons-${section.id}`}>
            <span className="swatch" aria-hidden="true" /> {section.name}
          </h2>
          <ul className="set-list lesson-rows">
            {view.rows.filter((row) => row.subject.section.id === section.id).map((row) => (
              <li key={row.subject.id}>
                <span className="set-name">{row.subject.name}</span>
                <span className="set-facts">
                  {row.subject.kind === "skill" ? row.subject.topic?.name ?? "Skill" : "Question Type"}. {stateText(row, view.fewest)}
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
                {row.draft === null && row.questions >= view.fewest && (
                  <button type="button" className="button button-quiet" aria-disabled={running} onClick={() => void write([row.subject.id])}>
                    {row.approved === null && row.rejected === null ? "Write it" : "Write it again"}
                    <span className="visually-hidden"> on {row.subject.name}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}

// One version, as a Learner would read it, with the decision on a draft.
export const CuratorLesson = ({ id, onLocked, onStopped }: Props & { readonly id: string }) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const noteId = useId()
  const [lesson, setLesson] = useState<LessonView | null>()
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
  if (lesson === null) return <p className="empty">This Lesson is not in the app. <a {...linkProps("/curator/lessons")}>Lessons</a></p>
  return (
    <article className="lesson" data-section={lesson.subject.section.id}>
      <p className="back">
        <a className="quiet-link" {...linkProps("/curator/lessons")}>Lessons</a>
      </p>
      <h1 ref={heading} tabIndex={-1}>{lesson.subject.name}</h1>
      <p className="lede">
        Version {lesson.version}, {lesson.status === "draft" ? "waiting for you" : lesson.status}, written{" "}
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
                <textarea id={noteId} rows={3} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} />
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
