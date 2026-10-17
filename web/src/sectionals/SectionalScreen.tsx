import type { Effect } from "effect"
import { type RefObject, useCallback, useEffect, useId, useRef, useState } from "react"
import { bandNames } from "../../../src/api/difficulty.ts"
import { type PracticePart, SessionId } from "../../../src/api/Practice.ts"
import type {
  ReviewEntry,
  SectionalOutOfStep,
  SectionalQuestion,
  SectionalReport,
  SectionalResult,
  SectionalView
} from "../../../src/api/Sectionals.ts"
import { call, type Client } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { spokenDuration } from "../format.ts"
import { RichText } from "../RichText.tsx"
import { linkProps } from "../router.ts"
import { StimulusDetails, StimulusPane } from "../stimulus/StimulusPane.tsx"
import { Calculator } from "../practice/Calculator.tsx"
import { DebriefPanel } from "../practice/DebriefPanel.tsx"
import { AnswerParts, type Picks } from "../practice/Parts.tsx"
import { examKey, keyPressOf } from "../practice/examKeys.ts"
import { AnsweredOptions } from "../practice/PracticeSet.tsx"
import { type ClockReading, Timer, useRemaining, warningFor } from "../practice/Timer.tsx"
import { useTimerChoice } from "../practice/timerChoices.ts"

// A Sectional on screen: one Question at a time with the clock running, then
// Review & Edit while time is left, then the report.

interface Props {
  readonly id: string
  readonly onSessionLost: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
  // For a Mock's Section: called once the Section has closed, while the
  // Mock goes on.
  readonly onClosed?: () => void
}

// What the Section is called, and the page to go back to.
const titleOf = (view: SectionalView) =>
  view.mock === null ? `${view.section.name} Sectional` : `${view.section.name}, Mock Section ${view.mock.place}`

const backOf = (view: SectionalView) =>
  view.mock === null ? { to: "/sectionals", label: "Sectionals" } : { to: `/mocks/${view.mock.id}`, label: "Mock" }

// The browser reads the Sectional again this often, besides after every
// change, so its clock stays the server's.
const ResyncMs = 15_000

const readingOf = (view: SectionalView): ClockReading => ({
  remainingMs: view.clock.remainingMs,
  paused: view.stage === "finished",
  at: performance.now()
})

const outOfStepText: Record<SectionalOutOfStep["reason"], string> = {
  "answered": "That Question was answered already, so this shows where the Section stands now.",
  "not-current": "The Section had moved on in another tab, so this shows where it stands now.",
  "not-in-review": "Review & Edit has not begun yet.",
  "no-changes-left": "You have used your three changes.",
  "same-answer": "That is the answer you gave already.",
  "finished": "The Section had ended."
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export const SectionalScreen = ({ id, onSessionLost, onStopped, onClosed }: Props) => {
  const [view, setView] = useState<SectionalView>()
  const [reading, setReading] = useState<ClockReading>()
  const [missing, setMissing] = useState(false)

  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "NotUnlocked" ? onSessionLost() : onStopped(failure)),
    [onSessionLost, onStopped]
  )

  const show = useCallback((next: SectionalView) => {
    setView(next)
    setReading(readingOf(next))
  }, [])

  const refresh = useCallback(async () => {
    const result = await call((client) => client.sectionals.get({ params: { id: SessionId.make(id) } }))
    if (result._tag === "Success") show(result.success)
    else if (result.failure._tag === "SectionalNotFound") setMissing(true)
    else handle(result.failure)
  }, [id, show, handle])

  useEffect(() => {
    setView(undefined)
    void refresh()
  }, [refresh])

  const ticking = view !== undefined && view.stage !== "finished"
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => void refresh(), ResyncMs)
    return () => clearInterval(timer)
  }, [ticking, refresh])

  // Coming back to the tab, the Sectional is read again: another tab may
  // have taken it over, or its time run out.
  useEffect(() => {
    const onShown = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    document.addEventListener("visibilitychange", onShown)
    return () => document.removeEventListener("visibilitychange", onShown)
  }, [refresh])

  if (missing) {
    return (
      <>
        <h1>This Section is not here</h1>
        <p className="lede">It may belong to another Profile. Start a Sectional from Sectionals, or a Mock from Mocks.</p>
        <a className="button" {...linkProps("/sectionals")}>Back to Sectionals</a>
      </>
    )
  }
  if (view === undefined) return <p className="quiet" aria-busy="true">Opening the Section</p>
  if (view.stage === "finished") {
    if (view.report === null) return <SectionClosed view={view} onClosed={onClosed} />
    // The last Section of a Mock, finished or run out of time on the Mock's
    // screen: the Mock's report comes next, not this Section's.
    if (view.mock !== null && onClosed !== undefined) return <MockOver onClosed={onClosed} />
    return <Report view={view} onFailure={handle} />
  }
  return <Running key={view.id} view={view} reading={reading} onView={show} onRefresh={refresh} onFailure={handle} />
}

// Sends one change and shows the Sectional as the server returns it.
const useActions = (onView: (view: SectionalView) => void, onFailure: (failure: { readonly _tag: string }) => void) => {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const act = async <E extends { readonly _tag: string }>(request: (client: Client) => Effect.Effect<SectionalView, E>) => {
    if (busy) return false
    setBusy(true)
    setProblem(undefined)
    const result = await call(request)
    setBusy(false)
    if (result._tag === "Success") {
      onView(result.success)
      return true
    }
    const failure: { readonly _tag: string } = result.failure
    if (failure._tag === "SectionalOutOfStep") {
      const outOfStep = failure as SectionalOutOfStep
      onView(outOfStep.view)
      setProblem(outOfStepText[outOfStep.reason])
    } else if (failure._tag === "SectionalHeldElsewhere") {
      const held = (failure as unknown as { readonly view: SectionalView }).view
      onView(held)
      setProblem(`Another tab or device has this ${held.mock === null ? "Sectional" : "Mock"} now. Take it over here to go on.`)
    } else if (failure._tag === "SelectionInvalid") {
      setProblem((failure as unknown as { readonly problems: ReadonlyArray<string> }).problems.join(" "))
    } else {
      onFailure(failure)
    }
    return false
  }
  return { busy, problem, setProblem, act }
}

type Actions = ReturnType<typeof useActions>

const Running = (
  { view, reading, onView, onRefresh, onFailure }: {
    readonly view: SectionalView
    readonly reading: ClockReading | undefined
    readonly onView: (view: SectionalView) => void
    readonly onRefresh: () => Promise<void>
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const actions = useActions(onView, onFailure)
  // Hidden for the whole Mock, and dismissed for this Section's clock.
  const [timerHidden, setTimerHidden] = useTimerChoice("hidden", view.mock?.id ?? view.id)
  const [warningDismissed, setWarningDismissed] = useTimerChoice("dismissed", view.id)
  const [calculating, setCalculating] = useState(false)
  const [ending, setEnding] = useState(false)
  const calculatorToggle = useRef<HTMLButtonElement>(null)
  const mainHeading = useRef<HTMLHeadingElement>(null)
  const dataInsights = view.section.id === "di"
  const remaining = useRemaining(reading)
  const warningMs = warningFor(view.clock.limitMs)

  // When the time shown runs out, the server ends the Section within a
  // second or two; read it then.
  const expired = remaining === 0
  useEffect(() => {
    if (!expired) return
    const timer = setTimeout(() => void onRefresh(), 1500)
    return () => clearTimeout(timer)
  }, [expired, reading, onRefresh])

  const claim = () => void actions.act((client) => client.sectionals.claim({ params: { id: view.id } }))
  const finish = () => void actions.act((client) => client.sectionals.finish({ params: { id: view.id } }))

  return (
    <div className="practice-set sectional" data-section={view.section.id}>
      <p className="back">
        <a className="quiet-link" {...linkProps(backOf(view).to)}>{backOf(view).label}</a>
      </p>
      <div className="set-head">
        <p className="set-title">{titleOf(view)}</p>
        <div className="set-controls">
          {remaining !== undefined && (
            <Timer
              remainingMs={remaining}
              warningMs={warningMs}
              hidden={timerHidden}
              onToggle={() => setTimerHidden(!timerHidden)}
              dismissed={warningDismissed}
              onDismiss={() => setWarningDismissed(true)}
            />
          )}
          {dataInsights && (
            <button
              ref={calculatorToggle}
              type="button"
              className="link-button"
              aria-expanded={calculating}
              onClick={() => setCalculating((open) => !open)}
            >
              Calculator
            </button>
          )}
          {view.heldHere && view.stage === "question" && (
            <button type="button" className="link-button set-end" aria-expanded={ending} onClick={() => setEnding(true)}>
              End the Section
            </button>
          )}
        </div>
      </div>
      {ending && (
        <Confirm
          text="End the Section now? The Questions not reached count as wrong."
          yes="End it now"
          no="Keep going"
          onYes={() => {
            setEnding(false)
            finish()
          }}
          onNo={() => {
            setEnding(false)
            // Back to the Question, where Enter submits the answer.
            mainHeading.current?.focus()
          }}
        />
      )}
      {dataInsights && calculating && (
        <Calculator
          onClose={() => {
            setCalculating(false)
            calculatorToggle.current?.focus()
          }}
        />
      )}
      {view.clock.interrupted && (
        <p className="clock-note">
          The clock did not count time while the app was stopped, the computer slept or the data was restored.
        </p>
      )}
      {!view.heldHere && (
        <div className="held-elsewhere" role="status">
          <p>
            This {view.mock === null ? "Sectional" : "Mock"} is open in another tab or on another device, so you can only
            look at it here.
          </p>
          <button type="button" className="button" onClick={claim} disabled={actions.busy}>Take it over here</button>
        </div>
      )}
      {view.stage === "question"
        ? <QuestionStage view={view} headingRef={mainHeading} actions={actions} />
        : <ReviewStage view={view} headingRef={mainHeading} actions={actions} onFinish={finish} onFailure={onFailure} />}
    </div>
  )
}

const Confirm = (
  { text, yes, no, onYes, onNo }: {
    readonly text: string
    readonly yes: string
    readonly no: string
    readonly onYes: () => void
    readonly onNo: () => void
  }
) => {
  const first = useFocusOnMount<HTMLButtonElement>()
  return (
    <div className="held-elsewhere" role="group" aria-label={text}>
      <p>{text}</p>
      <div className="actions">
        <button type="button" className="button" ref={first} onClick={onYes}>{yes}</button>
        <button type="button" className="button button-quiet" onClick={onNo}>{no}</button>
      </div>
    </div>
  )
}

const BookmarkButton = (
  { bookmarked, disabled, onToggle }: { readonly bookmarked: boolean; readonly disabled: boolean; readonly onToggle: () => void }
) => (
  <button type="button" className="button button-quiet" aria-pressed={bookmarked} onClick={onToggle} disabled={disabled}>
    {bookmarked ? "Bookmarked" : "Bookmark"}
  </button>
)

// The Question on screen: answer it to go on.
const QuestionStage = (
  { view, headingRef, actions }: {
    readonly view: SectionalView
    readonly headingRef: RefObject<HTMLHeadingElement | null>
    readonly actions: Actions
  }
) => {
  const current = view.current!
  const question = current.question
  const parts = question.parts
  const lettered = parts.length === 1 && parts[0]!.kind === "single-choice" ? parts[0]! : undefined
  const [picks, setPicks] = useState<Picks>({})
  const [shownFor, setShownFor] = useState(current.position)
  // A new Question starts clear.
  if (shownFor !== current.position) {
    setShownFor(current.position)
    setPicks({})
  }
  const locked = !view.heldHere
  const complete = parts.every((part) => picks[part.position] !== undefined)
  const pick = (part: number, label: string) => setPicks((before) => ({ ...before, [part]: label }))

  useEffect(() => {
    headingRef.current?.focus()
  }, [current.position, headingRef])

  const submit = () => {
    if (!complete || locked) return
    void actions.act((client) =>
      client.sectionals.answer({
        params: { id: view.id },
        payload: {
          seq: view.nextSeq,
          questionId: question.id,
          selection: parts.map((part) => ({ part: part.position, choice: picks[part.position]! }))
        }
      })
    )
  }

  const toggleBookmark = () =>
    void actions.act((client) =>
      client.sectionals.bookmark({ params: { id: view.id }, payload: { questionId: question.id, bookmarked: !current.bookmarked } })
    )

  // A to E pick an option and Enter goes on.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (locked) return
      const action = examKey(keyPressOf(event), lettered?.options.map((option) => option.label) ?? [])
      if (action === undefined) return
      event.preventDefault()
      if (action._tag === "Pick") pick(lettered!.position, action.label)
      else submit()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  })

  const last = view.remaining === 0
  const work = (
    <>
      <div className="question-body">
        <RichText source={question.stem} />
        <AnswerParts parts={parts} picks={picks} onPick={pick} disabled={locked || actions.busy} keys={undefined} />
      </div>
      {!locked && (
        <div className="answer-actions">
          <div className="actions">
            <button type="button" className="button" onClick={submit} disabled={!complete || actions.busy}>
              {last ? "Submit and review" : "Submit and go on"}
            </button>
            <BookmarkButton bookmarked={current.bookmarked} disabled={actions.busy} onToggle={toggleBookmark} />
          </div>
          <p className="hint">
            {lettered !== undefined ? "Press A to E to choose, then Enter. " : "Answer every part, then submit. "}
            There is no going back to a Question once you go on.
          </p>
        </div>
      )}
      {actions.problem !== undefined && <p className="problem" role="alert">{actions.problem}</p>}
    </>
  )
  return (
    <>
      <h1 ref={headingRef} tabIndex={-1} className="question-count">
        Question {current.position + 1} of {view.total}
      </h1>
      <p className="question-meta">
        <span className="swatch" aria-hidden="true" />
        {question.questionType.name}
      </p>
      {question.stimulus === null ? work : (
        <div className="with-stimulus">
          <StimulusPane key={question.stimulus.id} stimulus={question.stimulus} position={current.position} />
          <div className="beside-stimulus">{work}</div>
        </div>
      )}
    </>
  )
}

type Opened =
  | { readonly _tag: "List" }
  | { readonly _tag: "Loading"; readonly position: number }
  | { readonly _tag: "Open"; readonly position: number; readonly question: SectionalQuestion }

// Review & Edit: every Question, the Bookmarked ones marked, and up to three
// changed answers while time is left.
const ReviewStage = (
  { view, headingRef, actions, onFinish, onFailure }: {
    readonly view: SectionalView
    readonly headingRef: RefObject<HTMLHeadingElement | null>
    readonly actions: Actions
    readonly onFinish: () => void
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const review = view.review!
  const [opened, setOpened] = useState<Opened>({ _tag: "List" })
  const [onlyMarked, setOnlyMarked] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const finishToggle = useRef<HTMLButtonElement>(null)
  const listHeading = useRef<HTMLHeadingElement>(null)
  const filterId = useId()

  useEffect(() => {
    if (opened._tag === "List") (listHeading.current ?? headingRef.current)?.focus()
  }, [opened._tag, headingRef])

  const open = async (position: number) => {
    setOpened({ _tag: "Loading", position })
    const result = await call((client) => client.sectionals.question({ params: { id: view.id, position } }))
    if (result._tag === "Success") return setOpened({ _tag: "Open", position, question: result.success })
    setOpened({ _tag: "List" })
    if (result.failure._tag === "SectionalOutOfStep") return actions.setProblem(outOfStepText[result.failure.reason])
    onFailure(result.failure)
  }

  const shown = review.entries.filter((entry) => !onlyMarked || entry.bookmarked)
  if (opened._tag === "Open") {
    return (
      <ReviewQuestion
        key={opened.position}
        view={view}
        entry={review.entries.find((entry) => entry.position === opened.position)!}
        opened={opened.question}
        actions={actions}
        onBack={() => setOpened({ _tag: "List" })}
        onChanged={() => void open(opened.position)}
      />
    )
  }
  return (
    <>
      <h1 ref={headingRef} tabIndex={-1}>Review & Edit</h1>
      <p className="lede">
        {review.changesLeft === 0
          ? "You have used your three changes. You can still look at your answers until time runs out."
          : `You can change ${plural(review.changesLeft, "more answer", "more answers")} while time is left. Open a Question to see your answer.`}
      </p>
      <div className="check">
        <input id={filterId} type="checkbox" checked={onlyMarked} onChange={(event) => setOnlyMarked(event.target.checked)} />
        <label htmlFor={filterId}>Show only Bookmarked Questions</label>
      </div>
      <h2 ref={listHeading} tabIndex={-1} className="visually-hidden">Your Questions</h2>
      {shown.length === 0
        ? <p className="empty">No Question is Bookmarked.</p>
        : (
          <ol className="review-list">
            {shown.map((entry) => (
              <ReviewRow
                key={entry.position}
                entry={entry}
                loading={opened._tag === "Loading" && opened.position === entry.position}
                onOpen={() => void open(entry.position)}
              />
            ))}
          </ol>
        )}
      {actions.problem !== undefined && <p className="problem" role="alert">{actions.problem}</p>}
      {view.heldHere && (
        <div className="actions">
          <button ref={finishToggle} type="button" className="button" onClick={() => setFinishing(true)} disabled={actions.busy}>
            Finish the Section
          </button>
        </div>
      )}
      {finishing && (
        <Confirm
          text="Finish the Section? Your answers are scored as they stand, and none can change after."
          yes="Finish and see the report"
          no="Keep reviewing"
          onYes={() => {
            setFinishing(false)
            onFinish()
          }}
          onNo={() => {
            setFinishing(false)
            finishToggle.current?.focus()
          }}
        />
      )}
    </>
  )
}

const ReviewRow = (
  { entry, loading, onOpen }: { readonly entry: ReviewEntry; readonly loading: boolean; readonly onOpen: () => void }
) => (
  <li className="review-row">
    <span className="review-name">Question {entry.position + 1}, {entry.questionType.name}</span>
    <span className="set-facts">
      {[entry.bookmarked ? "Bookmarked" : undefined, entry.changed ? "Answer changed" : undefined]
        .filter((part) => part !== undefined).join(", ")}
    </span>
    <button
      type="button"
      className="link-button"
      aria-busy={loading || undefined}
      aria-label={`Open Question ${entry.position + 1}`}
      onClick={onOpen}
    >
      Open
    </button>
  </li>
)

const picksOf = (selection: SectionalQuestion["selection"]): Picks =>
  Object.fromEntries((selection ?? []).map((each) => [each.part, each.choice]))

const samePicks = (a: Picks, b: Picks, parts: ReadonlyArray<PracticePart>) =>
  parts.every((part) => a[part.position] === b[part.position])

// One Question in Review & Edit: the answer that stands, which a change
// replaces.
const ReviewQuestion = (
  { view, entry, opened, actions, onBack, onChanged }: {
    readonly view: SectionalView
    readonly entry: ReviewEntry
    readonly opened: SectionalQuestion
    readonly actions: Actions
    readonly onBack: () => void
    readonly onChanged: () => void
  }
) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const question = opened.served.question
  const parts = question.parts
  const standing = picksOf(opened.selection)
  const [picks, setPicks] = useState<Picks>(standing)
  const changesLeft = view.review?.changesLeft ?? 0
  const locked = !view.heldHere
  const complete = parts.every((part) => picks[part.position] !== undefined)
  const different = !samePicks(picks, standing, parts)
  const pick = (part: number, label: string) => setPicks((before) => ({ ...before, [part]: label }))

  const change = async () => {
    if (!complete || !different || changesLeft === 0 || locked) return
    const done = await actions.act((client) =>
      client.sectionals.change({
        params: { id: view.id },
        payload: {
          seq: view.nextSeq,
          questionId: question.id,
          selection: parts.map((part) => ({ part: part.position, choice: picks[part.position]! }))
        }
      })
    )
    if (done) onChanged()
  }

  const toggleBookmark = () =>
    void actions.act((client) =>
      client.sectionals.bookmark({ params: { id: view.id }, payload: { questionId: question.id, bookmarked: !entry.bookmarked } })
    )

  const work = (
    <>
      <div className="question-body">
        <RichText source={question.stem} />
        <AnswerParts
          parts={parts}
          picks={picks}
          onPick={pick}
          disabled={locked || changesLeft === 0 || actions.busy}
          keys={undefined}
        />
      </div>
      <div className="answer-actions">
        <div className="actions">
          {!locked && changesLeft > 0 && (
            <button type="button" className="button" onClick={() => void change()} disabled={!complete || !different || actions.busy}>
              Change my answer
            </button>
          )}
          {!locked && <BookmarkButton bookmarked={entry.bookmarked} disabled={actions.busy} onToggle={toggleBookmark} />}
          <button type="button" className="button button-quiet" onClick={onBack}>Back to the list</button>
        </div>
        <p className="hint">
          {changesLeft === 0
            ? "You have used your three changes."
            : `Choose another answer, then change it. ${plural(changesLeft, "change", "changes")} left.`}
        </p>
      </div>
      {actions.problem !== undefined && <p className="problem" role="alert">{actions.problem}</p>}
    </>
  )
  return (
    <>
      <h1 ref={heading} tabIndex={-1} className="question-count">Question {entry.position + 1} of {view.total}</h1>
      <p className="question-meta">
        <span className="swatch" aria-hidden="true" />
        {question.questionType.name}
        {entry.changed ? ". Answer changed." : ""}
      </p>
      {question.stimulus === null ? work : (
        <div className="with-stimulus">
          <StimulusPane key={question.stimulus.id} stimulus={question.stimulus} position={entry.position} />
          <div className="beside-stimulus">{work}</div>
        </div>
      )}
    </>
  )
}

const resultText = (result: SectionalResult) =>
  result.unanswered ? "Not answered" : result.timedOut ? "Time ran out" : result.correct ? "Right" : "Wrong"

const changeText = (result: SectionalResult) =>
  result.change === null
    ? undefined
    : result.change.wasCorrect === result.change.isCorrect
    ? `changed, still ${result.change.isCorrect ? "right" : "wrong"}`
    : `changed from ${result.change.wasCorrect ? "right to wrong" : "wrong to right"}`

const editText = (report: SectionalReport) => {
  if (report.changes === 0) return "You changed no answers in Review & Edit."
  const changed = `You changed ${plural(report.changes, "answer", "answers")} in Review & Edit`
  if (report.editPoints === 0) return `${changed}, which made no difference to the score.`
  return `${changed}, which ${report.editPoints > 0 ? "gained" : "lost"} ${plural(Math.abs(report.editPoints), "point", "points")}.`
}

// How the Section went: the score with its range, what Review & Edit did,
// and each Question's Difficulty, result and time.
const Report = ({ view, onFailure }: { readonly view: SectionalView; readonly onFailure: (failure: { readonly _tag: string }) => void }) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const report = view.report!
  const answered = report.results.filter((result) => !result.unanswered && !result.timedOut).length
  const right = report.results.filter((result) => result.correct).length
  const notes = [
    report.unreached > 0
      ? `${plural(report.unreached, "Question was", "Questions were")} not reached and ${report.unreached === 1 ? "counts" : "count"} as wrong.`
      : undefined,
    report.unfilled > 0
      ? `The Question Bank had nothing left for ${plural(report.unfilled, "slot", "slots")}, which ${report.unfilled === 1 ? "is" : "are"} not scored.`
      : undefined,
    report.repeats > 0
      ? `${plural(report.repeats, "Question you had seen before was", "Questions you had seen before were")} served, since too few unseen ones were left.${
        report.paperRepeats === 0
          ? ""
          : ` ${report.paperRepeats === report.repeats ? (report.repeats === 1 ? "It" : "All of them") : report.paperRepeats} you had marked as done on paper.`
      }`
      : undefined,
    report.rescored
      ? "An answer key changed after the Section closed, by a correction or a merge of duplicate Questions, so these results and the score follow the current keys."
      : undefined
  ].filter((note) => note !== undefined)
  return (
    <div className="sectional-report" data-section={view.section.id}>
      <p className="back">
        <a className="quiet-link" {...linkProps(backOf(view).to)}>{backOf(view).label}</a>
      </p>
      <h1 ref={heading} tabIndex={-1}>{titleOf(view)}</h1>
      <div className="report-score">
        <span className="score-value">{report.score}</span>
        <span className="score-facts">
          likely {report.low} to {report.high}, on the 60 to 90 scale{report.calibrated ? "" : ", not yet calibrated"}
        </span>
      </div>
      <p className="lede">
        {right} of {report.results.length} right, {answered} answered in time.
        {view.endedBy === "time" ? " Time ran out." : ""} You took{" "}
        {spokenDuration(Math.min(view.clock.elapsedMs, view.clock.limitMs))} of {spokenDuration(view.clock.limitMs)}.
      </p>
      <p>{editText(report)}</p>
      {notes.length > 0 && (
        <ul className="report-notes">
          {notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}
      <p className="quiet">
        Difficulty and your Score Estimates moved when the {view.mock === null ? "Section closed" : "Mock ended"}. Questions you
        had not seen before count toward them.
      </p>
      <h2 className="results-title">Each Question</h2>
      <ol className="set-results">
        {report.results.map((result) => <ResultRow key={result.position} view={view} result={result} onFailure={onFailure} />)}
      </ol>
      <div className="actions">
        <a className="button" {...linkProps(backOf(view).to)}>Back to {view.mock === null ? "Sectionals" : "the Mock"}</a>
      </div>
    </div>
  )
}

// A Mock's Section that has closed while the Mock goes on: its results wait
// for the end of the Mock.
const SectionClosed = ({ view, onClosed }: { readonly view: SectionalView; readonly onClosed: (() => void) | undefined }) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  useEffect(() => onClosed?.(), [onClosed])
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>{titleOf(view)} has closed</h1>
      <p className="lede">Its results show with the Mock's report, once the Mock is over.</p>
      <a className="button" {...linkProps(backOf(view).to)}>Back to the Mock</a>
    </>
  )
}

const MockOver = ({ onClosed }: { readonly onClosed: () => void }) => {
  useEffect(() => onClosed(), [onClosed])
  return <p className="quiet" aria-busy="true">Opening the Mock's report</p>
}

type Debriefed = { readonly _tag: "Closed" } | { readonly _tag: "Loading" } | { readonly _tag: "Open"; readonly question: SectionalQuestion }

const ResultRow = (
  { view, result, onFailure }: {
    readonly view: SectionalView
    readonly result: SectionalResult
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const [debriefed, setDebriefed] = useState<Debriefed>({ _tag: "Closed" })
  const panel = useId()
  const toggle = async () => {
    if (debriefed._tag !== "Closed") return setDebriefed({ _tag: "Closed" })
    setDebriefed({ _tag: "Loading" })
    const loaded = await call((client) => client.sectionals.question({ params: { id: view.id, position: result.position } }))
    if (loaded._tag === "Success") return setDebriefed({ _tag: "Open", question: loaded.success })
    setDebriefed({ _tag: "Closed" })
    onFailure(loaded.failure)
  }
  const served = debriefed._tag === "Open" ? debriefed.question.served : undefined
  return (
    <li className="set-result" data-result={result.unanswered ? "unanswered" : result.correct ? "right" : "wrong"}>
      <div className="set-result-head">
        <span className="set-result-name">Question {result.position + 1}, {result.questionType.name}</span>
        <span className="set-result-outcome">{resultText(result)}</span>
        <span className="set-result-facts">
          {[
            `${bandNames[result.band]} (${result.difficulty.toFixed(1)})`,
            spokenDuration(result.timeSpentMs),
            changeText(result),
            result.bookmarked ? "Bookmarked" : undefined,
            result.repeat ? "seen before" : undefined
          ].filter((part) => part !== undefined).join(", ")}
        </span>
        <button type="button" className="link-button" aria-expanded={debriefed._tag === "Open"} aria-controls={panel} onClick={() => void toggle()}>
          {debriefed._tag === "Open" ? "Hide" : "Show the Debrief"}
        </button>
      </div>
      <div id={panel} className="set-result-review" hidden={served === undefined}>
        {served !== undefined && (
          <>
            {served.question.stimulus !== null && <StimulusDetails stimulus={served.question.stimulus} />}
            <RichText source={served.question.stem} />
            <AnsweredOptions served={served} />
            {served.debrief !== null && (
              <DebriefPanel
                debrief={served.debrief}
                response={served.response}
                timed
                parts={served.question.parts}
                mistakes={served.mistakes}
                onFailure={onFailure}
                questionId={served.question.id}
              />
            )}
          </>
        )}
      </div>
    </li>
  )
}
