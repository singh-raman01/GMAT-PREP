import { useCallback, useEffect, useId, useRef, useState } from "react"
import type { DailyLogDay } from "../../../src/api/Plan.ts"
import { call } from "../api.ts"
import { hoursAndMinutes, longDay } from "../format.ts"
import { useReading } from "../progress/reading.ts"

// The Daily Log (decision 91): each Study Day's time, Questions, accuracy by
// Section and Mocks, the items planned for it and which were done, and the
// Learner's note.

const percent = (right: number, answered: number) => (answered === 0 ? "none answered" : `${Math.round((100 * right) / answered)}%`)

const workText = (day: DailyLogDay) => {
  if (day.questions === 0 && day.mocks === 0) return "No Questions answered."
  const sections = day.sections.map((each) => `${each.section.name} ${percent(each.right, each.answered)} of ${each.answered}`)
  return [
    `${hoursAndMinutes(day.minutes)}, ${day.questions} ${day.questions === 1 ? "Question" : "Questions"}`,
    ...(sections.length === 0 ? [] : [`right: ${sections.join(", ")}`]),
    ...(day.mocks === 0 ? [] : [`${day.mocks} ${day.mocks === 1 ? "Mock" : "Mocks"} finished`])
  ].join("; ") + "."
}

const Note = ({ day, onSaved }: { readonly day: DailyLogDay; readonly onSaved: (day: DailyLogDay) => void }) => {
  const id = useId()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(day.note ?? "")
  const [problem, setProblem] = useState<string>()
  const busy = useRef(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  // Focus follows the editor: into it when it opens, back to its button
  // when it closes.
  const opened = useRef(false)
  useEffect(() => {
    if (editing) field.current?.focus()
    else if (opened.current) opener.current?.focus()
    opened.current = editing
  }, [editing])
  const save = async () => {
    if (busy.current) return
    busy.current = true
    const result = await call((client) => client.plan.writeNote({ params: { day: day.day }, payload: { note: text } }))
    busy.current = false
    if (result._tag === "Failure") return setProblem("The note was not saved. Try again.")
    setProblem(undefined)
    setText(result.success.note ?? "")
    setEditing(false)
    onSaved(result.success)
  }
  // Cancel puts back the note as saved.
  const cancel = () => {
    setText(day.note ?? "")
    setProblem(undefined)
    setEditing(false)
  }
  if (!editing) {
    return (
      <div className="log-note">
        {day.note === null ? null : <p className="log-note-text">{day.note}</p>}
        <button ref={opener} type="button" className="link-button" onClick={() => setEditing(true)}>
          {day.note === null ? "Add a note" : "Change the note"}
          <span className="visually-hidden"> for {longDay(day.day)}</span>
        </button>
      </div>
    )
  }
  return (
    <div className="log-note">
      <label htmlFor={id}>A note on {longDay(day.day)}</label>
      <textarea ref={field} id={id} rows={3} maxLength={2000} value={text} onChange={(event) => setText(event.target.value)} />
      <div className="actions">
        <button type="button" className="button" onClick={() => void save()}>Save the note</button>
        <button type="button" className="button button-quiet" onClick={cancel}>Cancel</button>
      </div>
      {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
    </div>
  )
}

export const DailyLog = ({ onFailure }: { readonly onFailure: (failure: { readonly _tag: string }) => void }) => {
  const read = useCallback(() => call((client) => client.plan.dailyLog()), [])
  const log = useReading(read, onFailure)
  const [changed, setChanged] = useState<ReadonlyMap<string, DailyLogDay>>(new Map())
  if (log === undefined) return <p className="quiet" aria-busy="true">Reading your Daily Log</p>
  const days = log.days.map((day) => changed.get(day.day) ?? day)
  return (
    <ol className="daily-log">
      {days.map((day) => {
        const done = day.items.filter((item) => item.status === "done").length
        return (
          <li key={day.day} className="log-day">
            <h2 className="log-date">{day.day === log.today ? `Today, ${longDay(day.day)}` : longDay(day.day)}</h2>
            <p className="log-work">{workText(day)}</p>
            {day.items.length > 0 && (
              <>
                <p className="log-planned">{done} of {day.items.length} planned {day.items.length === 1 ? "item" : "items"} done.</p>
                <ul className="log-items">
                  {day.items.map((item) => (
                    <li key={item.id} className={item.status === "done" ? "log-item-done" : undefined}>
                      {item.title}
                      <span className="visually-hidden">{item.status === "done" ? ", done" : ", not done"}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <Note day={day} onSaved={(saved) => setChanged(new Map([...changed, [saved.day, saved]]))} />
          </li>
        )
      })}
    </ol>
  )
}
