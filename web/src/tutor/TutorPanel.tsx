import { useEffect, useId, useRef, useState } from "react"
import type { QuestionId } from "../../../src/api/Review.ts"
import type { TutorView } from "../../../src/api/Tutor.ts"
import { call } from "../api.ts"
import { RichText } from "../RichText.tsx"

// Tutor Chat and Report a problem, under a Debrief (decisions 103 to 108):
// the Learner asks about their reasoning on this Question, or reports one
// they believe is wrong for the Curator to check.

const stateNotes = {
  "open": undefined,
  "cap-reached": "Tutor Chat has reached this month's spending cap. It opens again next month, or when the Curator raises the cap.",
  "not-set-up": "Tutor Chat is not set up yet: the Curator chooses its model under Settings."
} as const

const failureNotes: Readonly<Record<string, string>> = {
  TutorCapReached: stateNotes["cap-reached"],
  TutorNotSetUp: stateNotes["not-set-up"],
  TutorUnavailable: "The tutor cannot be reached now. Try again in a little while; everything else keeps working.",
  TutorReplyInvalid: "The tutor's reply could not be shown. Try asking again, perhaps in other words.",
  TutorQuestionClosed: "This Question cannot be discussed now, as while a Sectional or Mock holds it."
}

export const TutorPanel = ({ questionId, onFailure }: {
  readonly questionId: QuestionId
  readonly onFailure?: ((failure: { readonly _tag: string }) => void) | undefined
}) => {
  const ids = { chat: useId(), message: useId(), report: useId(), reportText: useId() }
  const [open, setOpen] = useState<"chat" | "report">()
  const [view, setView] = useState<TutorView>()
  const [message, setMessage] = useState("")
  const [report, setReport] = useState("")
  const [problem, setProblem] = useState<string>()
  const [sent, setSent] = useState<string>()
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  useEffect(() => {
    if (open !== "chat") return
    let live = true
    void call((client) => client.tutor.conversation({ params: { id: questionId } })).then((result) => {
      if (!live) return
      if (result._tag === "Success") return setView(result.success)
      const note = failureNotes[result.failure._tag]
      if (note !== undefined) return setProblem(note)
      onFailure?.(result.failure)
    })
    return () => {
      live = false
    }
  }, [open, questionId, onFailure])

  const ask = async () => {
    if (busyRef.current || message.trim() === "") return
    busyRef.current = true
    setBusy(true)
    setProblem(undefined)
    const result = await call((client) => client.tutor.ask({ params: { id: questionId }, payload: { message } }))
    busyRef.current = false
    setBusy(false)
    if (result._tag === "Success") {
      setView(result.success)
      return setMessage("")
    }
    const note = failureNotes[result.failure._tag]
    if (note !== undefined) return setProblem(note)
    onFailure?.(result.failure)
  }

  const send = async () => {
    if (busyRef.current) return
    if (report.trim() === "") return setProblem("Say what you believe is wrong with it.")
    busyRef.current = true
    setBusy(true)
    setProblem(undefined)
    const result = await call((client) => client.tutor.report({ params: { id: questionId }, payload: { text: report } }))
    busyRef.current = false
    setBusy(false)
    if (result._tag === "Success") {
      setReport("")
      setOpen(undefined)
      return setSent("Report sent. The Curator checks it; the Question stays as it is until then.")
    }
    const note = failureNotes[result.failure._tag]
    if (note !== undefined) return setProblem(note)
    onFailure?.(result.failure)
  }

  const toggle = (which: "chat" | "report") => {
    setProblem(undefined)
    setSent(undefined)
    setOpen((current) => (current === which ? undefined : which))
  }

  const note = view === undefined ? undefined : stateNotes[view.state]
  return (
    <div className="tutor">
      <div className="actions">
        <button type="button" className="button button-quiet" aria-expanded={open === "chat"} aria-controls={ids.chat} onClick={() => toggle("chat")}>
          Ask the tutor
        </button>
        <button type="button" className="button button-quiet" aria-expanded={open === "report"} aria-controls={ids.report} onClick={() => toggle("report")}>
          Report a problem
        </button>
      </div>
      {sent !== undefined && <p className="saved" role="status">{sent}</p>}
      {open === "chat" && (
        <section id={ids.chat} className="tutor-chat" aria-label="Tutor Chat">
          {view === undefined && problem === undefined && <p className="quiet" aria-busy="true">Opening the chat</p>}
          {view !== undefined && view.exchanges.length === 0 && (
            <p className="hint">
              Ask why your answer went wrong, or how to see it faster. The tutor takes the answer key as correct; if you
              believe the key is wrong, use Report a problem.
            </p>
          )}
          {view !== undefined && view.exchanges.length > 0 && (
            <ol className="tutor-exchanges">
              {view.exchanges.map((exchange) => (
                <li key={exchange.id}>
                  <p className="tutor-message"><span className="visually-hidden">You asked: </span>{exchange.message}</p>
                  <div className="tutor-reply">
                    <span className="visually-hidden">The tutor: </span>
                    <RichText source={exchange.reply} />
                  </div>
                </li>
              ))}
            </ol>
          )}
          {note !== undefined && <p className="hint">{note}</p>}
          {view !== undefined && view.state === "open" && (
            <form
              className="tutor-form"
              onSubmit={(event) => {
                event.preventDefault()
                void ask()
              }}
            >
              <label htmlFor={ids.message}>Your question</label>
              <textarea id={ids.message} rows={3} maxLength={2000} value={message} onChange={(event) => setMessage(event.target.value)} />
              <div className="actions">
                <button type="submit" className="button" aria-disabled={busy || message.trim() === ""} aria-busy={busy}>
                  {busy ? "Asking" : "Ask"}
                </button>
              </div>
            </form>
          )}
        </section>
      )}
      {open === "report" && (
        <form
          id={ids.report}
          className="tutor-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          <label htmlFor={ids.reportText}>What is wrong with this Question?</label>
          <p className="hint">A wrong key, an unclear stem, a typo: the Curator reads every report.</p>
          <textarea id={ids.reportText} rows={3} maxLength={2000} value={report} onChange={(event) => setReport(event.target.value)} />
          <div className="actions">
            <button type="submit" className="button" aria-disabled={busy} aria-busy={busy}>Send the report</button>
          </div>
        </form>
      )}
      {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
    </div>
  )
}
