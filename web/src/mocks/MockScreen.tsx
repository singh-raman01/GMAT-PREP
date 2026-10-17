import { useCallback, useEffect, useRef, useState } from "react"
import { BreakMinutes, KeepBreakSeconds, type MockReport, type MockView } from "../../../src/api/Mocks.ts"
import { SessionId } from "../../../src/api/Practice.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { dayAndTime, minutesAndSeconds } from "../format.ts"
import { linkProps } from "../router.ts"
import { SectionalScreen } from "../sectionals/SectionalScreen.tsx"
import { useRemaining } from "../practice/Timer.tsx"

// A Mock on screen: the Section running, as a Sectional shows it; the break
// between Sections; and the report once the last Section closes.

interface Props {
  readonly id: string
  readonly onSessionLost: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

// The browser reads the Mock again this often in a break, so the next
// Section starts on screen when the break runs out.
const ResyncMs = 15_000

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const BreakMs = BreakMinutes * 60_000
const KeepBreakMs = KeepBreakSeconds * 1000

export const MockScreen = ({ id, onSessionLost, onStopped }: Props) => {
  const [view, setView] = useState<MockView>()
  const [missing, setMissing] = useState(false)
  const [problem, setProblem] = useState<string>()
  const busy = useRef(false)

  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "NotUnlocked" ? onSessionLost() : onStopped(failure)),
    [onSessionLost, onStopped]
  )

  const refresh = useCallback(async () => {
    const result = await call((client) => client.mocks.get({ params: { id: SessionId.make(id) } }))
    if (result._tag === "Success") return setView(result.success)
    if (result.failure._tag === "MockNotFound") return setMissing(true)
    handle(result.failure)
  }, [id, handle])

  useEffect(() => {
    setView(undefined)
    void refresh()
  }, [refresh])

  const onBreak = view?.stage === "break"
  useEffect(() => {
    if (!onBreak) return
    const timer = setInterval(() => void refresh(), ResyncMs)
    return () => clearInterval(timer)
  }, [onBreak, refresh])

  const goOn = async () => {
    if (busy.current || view === undefined) return
    busy.current = true
    setProblem(undefined)
    const result = await call((client) => client.mocks.goOn({ params: { id: view.id } }))
    busy.current = false
    if (result._tag === "Success") return setView(result.success)
    switch (result.failure._tag) {
      case "MockOutOfStep":
      case "MockHeldElsewhere":
        setView(result.failure.view)
        return setProblem(
          result.failure._tag === "MockHeldElsewhere"
            ? "Another tab or device has this Mock now. Take it over here to go on."
            : "The break had ended, so this shows where the Mock stands now."
        )
      default:
        return handle(result.failure)
    }
  }

  const claim = async () => {
    if (view === undefined) return
    const result = await call((client) => client.mocks.claim({ params: { id: view.id } }))
    if (result._tag === "Success") return setView(result.success)
    handle(result.failure)
  }

  if (missing) {
    return (
      <>
        <h1>This Mock is not here</h1>
        <p className="lede">It may belong to another Profile. Start a new one from Mocks.</p>
        <a className="button" {...linkProps("/mocks")}>Back to Mocks</a>
      </>
    )
  }
  if (view === undefined) return <p className="quiet" aria-busy="true">Opening the Mock</p>
  if (view.stage === "section") {
    const current = view.sections.find((section) => section.place === view.current)
    if (current?.sessionId == null) return <p className="quiet" aria-busy="true">Starting the next Section</p>
    return (
      <SectionalScreen
        key={current.sessionId}
        id={current.sessionId}
        onSessionLost={onSessionLost}
        onStopped={onStopped}
        onClosed={() => void refresh()}
      />
    )
  }
  if (view.stage === "break") {
    return <Break view={view} problem={problem} onGoOn={() => void goOn()} onClaim={() => void claim()} onEnded={refresh} />
  }
  return <Report view={view} report={view.report!} />
}

const Break = (
  { view, problem, onGoOn, onClaim, onEnded }: {
    readonly view: MockView
    readonly problem: string | undefined
    readonly onGoOn: () => void
    readonly onClaim: () => void
    readonly onEnded: () => Promise<void>
  }
) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const pause = view.break!
  const [reading, setReading] = useState(() => ({ remainingMs: pause.remainingMs, paused: false, at: performance.now() }))
  useEffect(() => setReading({ remainingMs: pause.remainingMs, paused: false, at: performance.now() }), [pause.remainingMs])
  const remaining = useRemaining(reading) ?? pause.remainingMs
  const next = view.sections.find((section) => section.place === pause.after + 1)!
  // When the break runs out, the server starts the next Section within a
  // second or two; read the Mock then.
  const over = remaining === 0
  useEffect(() => {
    if (!over) return
    const timer = setTimeout(() => void onEnded(), 1500)
    return () => clearTimeout(timer)
  }, [over, onEnded])
  // Going on keeps the break only in its first minute after Section 1; the
  // server decides, and this follows the clock on screen.
  const keeps = pause.keepsBreak && BreakMs - remaining < KeepBreakMs
  // Said aloud as each moment passes: the first minute, the last, the end.
  const announcement = over
    ? `The break is over. Section ${next.place} is starting.`
    : remaining <= 60_000
    ? "One minute left in the break."
    : pause.keepsBreak && !keeps
    ? "The first minute is over, so going on now ends your break."
    : ""
  return (
    <div className="mock-break">
      <p className="back">
        <a className="quiet-link" {...linkProps("/mocks")}>Mocks</a>
      </p>
      <h1 ref={heading} tabIndex={-1}>Break</h1>
      <p className="break-time" role="timer" aria-live="off">
        <span className="visually-hidden">Time left in the break:</span> {minutesAndSeconds(remaining)}
      </p>
      <p className="lede">
        Section {pause.after} is done. Next is Section {next.place}, {next.section.name}, 45 minutes. It starts when the
        break ends, or when you go on.
      </p>
      <p>{keeps ? "Going on now keeps your break for after Section 2." : "Going on now ends your break."}</p>
      <p className="visually-hidden" role="status">{announcement}</p>
      {!view.heldHere && (
        <div className="held-elsewhere" role="status">
          <p>This Mock is open in another tab or on another device, so you can only look at it here.</p>
          <button type="button" className="button" onClick={onClaim}>Take it over here</button>
        </div>
      )}
      {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
      {view.heldHere && (
        <div className="actions">
          <button type="button" className="button" onClick={onGoOn}>Go on to Section {next.place}</button>
        </div>
      )}
    </div>
  )
}

const Report = ({ view, report }: { readonly view: MockView; readonly report: MockReport }) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const notes = [
    report.interruptions > 0
      ? `${plural(report.interruptions, "Section", "Sections")} lost time to a stop of the app or the computer, which the clock did not count.`
      : undefined,
    report.repeats > 0
      ? `${plural(report.repeats, "Question you had seen before was", "Questions you had seen before were")} served${
        report.paperRepeats > 0 ? `, ${report.paperRepeats} of them done on paper` : ""
      }.`
      : undefined,
    report.rescored ? "An answer key changed after the Mock, so these scores follow the new key." : undefined
  ].filter((note) => note !== undefined)
  return (
    <div className="mock-report">
      <p className="back">
        <a className="quiet-link" {...linkProps("/mocks")}>Mocks</a>
      </p>
      <h1 ref={heading} tabIndex={-1}>Mock, {dayAndTime(view.finishedAt ?? view.createdAt)}</h1>
      <div className="report-score">
        <span className="score-value">{report.total.score}</span>
        <span className="score-facts">
          likely {report.total.low} to {report.total.high}, on the 205 to 805 scale
          {report.total.calibrated ? "" : ", not yet calibrated"}
        </span>
      </div>
      {!report.total.calibrated && (
        <p className="hint">
          Enter an Official Score under <a {...linkProps("/scores")}>Scores</a> to line these estimates up with GMAC's scale.
        </p>
      )}
      <h2 className="results-title">Each Section</h2>
      <ol className="mock-sections">
        {report.sections.map((section) => (
          <li key={section.sessionId} className="mock-section" data-section={section.section.id}>
            <span className="swatch" aria-hidden="true" />
            <span className="mock-section-name">{section.section.name}</span>
            <span className="mock-section-score">{section.report.score}</span>
            <span className="set-facts">
              likely {section.report.low} to {section.report.high}
              {section.interrupted ? ", interrupted" : ""}
            </span>
            <a className="quiet-link" {...linkProps(`/sectionals/${section.sessionId}`)}>
              Each Question<span className="visually-hidden"> in {section.section.name}</span>
            </a>
          </li>
        ))}
      </ol>
      {notes.length > 0 && (
        <ul className="report-notes">
          {notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}
      <p className="quiet">
        Difficulty and your Score Estimates moved when the Mock ended, Section by Section. Questions you had not seen
        before count toward them.
      </p>
      <div className="actions">
        <a className="button" {...linkProps("/mocks")}>Back to Mocks</a>
      </div>
    </div>
  )
}
