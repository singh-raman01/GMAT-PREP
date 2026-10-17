import { useEffect, useId, useRef, useState } from "react"
import type { QuestionId } from "../../../src/api/Review.ts"
import type { ProblemReportView, TutorExchange, TutorView } from "../../../src/api/Tutor.ts"
import { call } from "../api.ts"
import { dayAndTime } from "../format.ts"
import { emptyMessageNote, emptyReportNote, failureNote, replyAnnouncement, stateNote, withLatest } from "./chatText.ts"
import { Conversation } from "./Conversation.tsx"
import { reportSent } from "./reportEvents.ts"

// Tutor Chat and Report a problem, under a Debrief (decisions 103 to 108):
// the Learner asks about their reasoning on this Question, or reports one
// they believe is wrong for the Curator to check.

export const TutorPanel = ({ questionId, onFailure }: {
  readonly questionId: QuestionId
  readonly onFailure?: ((failure: { readonly _tag: string }) => void) | undefined
}) => {
  const ids = { chat: useId(), message: useId(), report: useId(), reportText: useId(), reportHint: useId() }
  const [open, setOpen] = useState<"chat" | "report">()
  const [view, setView] = useState<TutorView>()
  // Exchanges from earlier pages, shown above the latest, oldest first.
  const [older, setOlder] = useState<ReadonlyArray<TutorExchange>>([])
  const [latest, setLatest] = useState<ReadonlyArray<TutorExchange>>([])
  const [more, setMore] = useState(false)
  const [message, setMessage] = useState("")
  const [report, setReport] = useState("")
  // The Learner's report on it still waiting for the Curator, once read.
  const [waiting, setWaiting] = useState<ProblemReportView | null>()
  const [problem, setProblem] = useState<string>()
  const [sent, setSent] = useState<string>()
  const [announcement, setAnnouncement] = useState("")
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const messageRef = useRef<HTMLTextAreaElement>(null)
  const reportButton = useRef<HTMLButtonElement>(null)
  const olderList = useRef<HTMLOListElement>(null)

  useEffect(() => {
    if (open !== "chat") return
    let live = true
    void call((client) => client.tutor.conversation({ params: { id: questionId }, query: {} })).then((result) => {
      if (!live) return
      if (result._tag === "Success") {
        setView(result.success)
        setOlder([])
        setLatest(result.success.exchanges)
        return setMore(result.success.earlier)
      }
      const note = failureNote(result.failure, "chat")
      if (note !== undefined) return setProblem(note)
      onFailure?.(result.failure)
    })
    return () => {
      live = false
    }
  }, [open, questionId, onFailure])

  useEffect(() => {
    if (open !== "report") return
    let live = true
    setWaiting(undefined)
    void call((client) => client.tutor.myReport({ params: { id: questionId } })).then((result) => {
      if (!live) return
      if (result._tag === "Failure") return onFailure?.(result.failure)
      setWaiting(result.success)
      if (result.success !== null) setReport(result.success.text)
    })
    return () => {
      live = false
    }
  }, [open, questionId, onFailure])

  const showEarlier = async () => {
    const first = older[0] ?? latest[0]
    if (busyRef.current || first === undefined) return
    busyRef.current = true
    setBusy(true)
    const result = await call((client) => client.tutor.conversation({ params: { id: questionId }, query: { before: first.id } }))
    busyRef.current = false
    setBusy(false)
    if (result._tag === "Failure") {
      const note = failureNote(result.failure, "chat")
      if (note !== undefined) return setProblem(note)
      return onFailure?.(result.failure)
    }
    const shown = new Set([...older, ...latest].map((exchange) => exchange.id))
    setOlder([...result.success.exchanges.filter((exchange) => !shown.has(exchange.id)), ...older])
    setMore(result.success.earlier)
    // Reading goes on from where the earlier messages start.
    requestAnimationFrame(() => olderList.current?.focus())
  }

  const ask = async () => {
    if (busyRef.current) return
    if (message.trim() === "") {
      setProblem(emptyMessageNote)
      return messageRef.current?.focus()
    }
    busyRef.current = true
    setBusy(true)
    setProblem(undefined)
    setAnnouncement("")
    const result = await call((client) => client.tutor.ask({ params: { id: questionId }, payload: { message } }))
    busyRef.current = false
    setBusy(false)
    if (result._tag === "Success") {
      const page = result.success.exchanges
      const onPage = new Set(page.map((exchange) => exchange.id))
      setView(result.success)
      setOlder((current) => current.filter((exchange) => !onPage.has(exchange.id)))
      setLatest((current) => withLatest(current, page))
      setMessage("")
      setAnnouncement(replyAnnouncement(page.at(-1)))
      return messageRef.current?.focus()
    }
    const note = failureNote(result.failure, "chat")
    if (note !== undefined) return setProblem(note)
    onFailure?.(result.failure)
  }

  const send = async () => {
    if (busyRef.current) return
    if (report.trim() === "") return setProblem(emptyReportNote)
    busyRef.current = true
    setBusy(true)
    setProblem(undefined)
    const result = await call((client) => client.tutor.report({ params: { id: questionId }, payload: { text: report } }))
    busyRef.current = false
    setBusy(false)
    if (result._tag === "Success") {
      setReport("")
      setOpen(undefined)
      setSent(
        waiting === null || waiting === undefined
          ? "Report sent. The Curator checks it; the Question stays as it is until then."
          : "Report updated. The Curator reads your new words in place of the earlier ones; the Question stays as it is until then."
      )
      reportSent()
      // The form has gone, so the Learner goes on from the button that opened it.
      return reportButton.current?.focus()
    }
    const note = failureNote(result.failure, "report")
    if (note !== undefined) return setProblem(note)
    onFailure?.(result.failure)
  }

  const toggle = (which: "chat" | "report") => {
    setProblem(undefined)
    setSent(undefined)
    setAnnouncement("")
    setOpen((current) => (current === which ? undefined : which))
  }

  const note = view === undefined ? undefined : stateNote(view.state, view.missing)
  return (
    <div className="tutor">
      <div className="actions">
        <button type="button" className="button button-quiet" aria-expanded={open === "chat"} aria-controls={ids.chat} onClick={() => toggle("chat")}>
          Ask the tutor
        </button>
        <button
          ref={reportButton}
          type="button"
          className="button button-quiet"
          aria-expanded={open === "report"}
          aria-controls={ids.report}
          onClick={() => toggle("report")}
        >
          Report a problem
        </button>
      </div>
      {sent !== undefined && <p className="saved" role="status">{sent}</p>}
      {open === "chat" && (
        <section id={ids.chat} className="tutor-chat" aria-label="Tutor Chat">
          {view === undefined && problem === undefined && <p className="quiet" aria-busy="true">Opening the chat</p>}
          {view !== undefined && older.length === 0 && latest.length === 0 && (
            <p className="hint">
              Ask why your answer went wrong, or how to see it faster. The tutor takes the answer key as correct; if you
              believe the key is wrong, use Report a problem.
            </p>
          )}
          {view !== undefined && more && (
            <div className="actions">
              <button type="button" className="link-button" aria-disabled={busy} onClick={() => void showEarlier()}>
                Show earlier messages
              </button>
            </div>
          )}
          {view !== undefined && <Conversation older={older} latest={latest} announcement={announcement} olderRef={olderList} />}
          {note !== undefined && <p className="hint">{note}</p>}
          {view !== undefined && view.state === "open" && (
            <form
              className="tutor-form"
              noValidate
              onSubmit={(event) => {
                event.preventDefault()
                void ask()
              }}
            >
              <label htmlFor={ids.message}>Your question</label>
              <textarea
                ref={messageRef}
                id={ids.message}
                rows={3}
                maxLength={2000}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
              />
              <div className="actions">
                <button type="submit" className="button" aria-disabled={busy} aria-busy={busy}>
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
          <p id={ids.reportHint} className="hint">
            {waiting === null || waiting === undefined
              ? "A wrong key, an unclear stem, a typo: the Curator reads every report."
              : `You reported it on ${dayAndTime(waiting.at)}, and the Curator has not decided yet. Sending again replaces what you wrote.`}
          </p>
          <textarea
            id={ids.reportText}
            rows={3}
            maxLength={2000}
            value={report}
            aria-describedby={ids.reportHint}
            onChange={(event) => setReport(event.target.value)}
          />
          <div className="actions">
            <button type="submit" className="button" aria-disabled={busy} aria-busy={busy}>Send the report</button>
          </div>
        </form>
      )}
      {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
    </div>
  )
}
