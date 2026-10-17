import type { Effect } from "effect"
import { type RefObject, useCallback, useEffect, useId, useRef, useState } from "react"
import {
  type HeldElsewhere,
  type ItemRef,
  type PracticeOutOfStep,
  type PracticeResult,
  type PracticeView,
  type SelectionInvalid,
  type ServedView,
  SessionId
} from "../../../src/api/Practice.ts"
import { call, type Client } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { minutesAndSeconds, spokenDuration } from "../format.ts"
import { RichInline, RichText } from "../RichText.tsx"
import { linkProps, navigate } from "../router.ts"
import { DebriefPanel } from "./DebriefPanel.tsx"
import { type ClockReading, Timer, useRemaining, warningFor } from "./Timer.tsx"
import { StimulusDetails, StimulusPane } from "../stimulus/StimulusPane.tsx"
import { AnswerParts, type Picks } from "./Parts.tsx"
import { Calculator } from "./Calculator.tsx"

interface Props {
  readonly id: string
  readonly onSessionLost: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

// The browser reads a timed set again this often, besides after every
// change, so its clock stays the server's.
const ResyncMs = 15_000

const readingOf = (view: PracticeView): ClockReading | undefined =>
  view.clock === null ? undefined : {
    remainingMs: view.clock.remainingMs,
    paused: view.status !== "active",
    at: performance.now()
  }

// One Practice Set: the Question on screen and, once answered, its Debrief
// in an untimed set; in a timed set, the next Question at once and the
// Debriefs at the end; when the set is over, how it went.
export const PracticeSet = ({ id, onSessionLost, onStopped }: Props) => {
  const [view, setView] = useState<PracticeView>()
  const [reading, setReading] = useState<ClockReading>()
  const [missing, setMissing] = useState(false)

  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "NotUnlocked" ? onSessionLost() : onStopped(failure)),
    [onSessionLost, onStopped]
  )

  const show = useCallback((next: PracticeView) => {
    setView(next)
    setReading(readingOf(next))
  }, [])

  const refresh = useCallback(async () => {
    const result = await call((client) => client.practice.get({ params: { id: SessionId.make(id) } }))
    if (result._tag === "Success") show(result.success)
    else if (result.failure._tag === "PracticeNotFound") setMissing(true)
    else handle(result.failure)
  }, [id, show, handle])

  useEffect(() => {
    setView(undefined)
    void refresh()
  }, [refresh])

  // A timed set's clock is the server's: read it again now and then.
  const ticking = view !== undefined && view.timed && view.status !== "finished"
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => void refresh(), ResyncMs)
    return () => clearInterval(timer)
  }, [ticking, refresh])

  // Coming back to the tab, any set is read again, as another tab may have
  // taken it over or moved it on.
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
        <h1>This set is not here</h1>
        <p className="lede">It may belong to another Profile. Start a new set from Practice.</p>
        <a className="button" {...linkProps("/")}>Back to Practice</a>
      </>
    )
  }
  if (view === undefined) return <p className="quiet" aria-busy="true">Opening the set</p>
  if (view.status === "finished") return <SetSummary view={view} onFailure={handle} />
  return (
    <SetScreen key={view.id} view={view} reading={reading} onView={show} onRefresh={refresh} onFailure={handle} />
  )
}

const isOutOfStep = (failure: { readonly _tag: string }): failure is PracticeOutOfStep =>
  failure._tag === "PracticeOutOfStep"

const isHeldElsewhere = (failure: { readonly _tag: string }): failure is HeldElsewhere =>
  failure._tag === "HeldElsewhere"

const isSelectionInvalid = (failure: { readonly _tag: string }): failure is SelectionInvalid =>
  failure._tag === "SelectionInvalid"

// Keys typed into a text field are the field's; a radio button or a
// checkbox leaves the shortcuts working.
export const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement ||
    (target instanceof HTMLInputElement && !["radio", "checkbox", "button", "submit"].includes(target.type)))

const outOfStepText: Record<PracticeOutOfStep["reason"], string> = {
  "answered": "The set had moved on in another tab, so this shows where it stands now.",
  "not-current": "The set had moved on in another tab, so this shows where it stands now.",
  "not-answered": "The set had moved on in another tab, so this shows where it stands now.",
  "no-more": "That was the last Question in the set.",
  "finished": "The set had ended.",
  "paused": "The set is paused. Resume it to go on.",
  "untimed": "Only a timed set has a clock to pause."
}

// Sends one change to the set and shows the set as the server returns it.
const useActions = (
  onView: (view: PracticeView) => void,
  onFailure: (failure: { readonly _tag: string }) => void
) => {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const act = async <E extends { readonly _tag: string }>(request: (client: Client) => Effect.Effect<PracticeView, E>) => {
    if (busy) return
    setBusy(true)
    setProblem(undefined)
    const result = await call(request)
    setBusy(false)
    if (result._tag === "Success") return onView(result.success)
    const failure: { readonly _tag: string } = result.failure
    if (isOutOfStep(failure)) {
      onView(failure.view)
      setProblem(outOfStepText[failure.reason])
    } else if (isHeldElsewhere(failure)) {
      onView(failure.view)
      setProblem("Another tab or device has this set now. Take it over here to go on.")
    } else if (isSelectionInvalid(failure)) {
      setProblem(failure.problems.join(" "))
    } else {
      onFailure(failure)
    }
  }
  return { busy, setBusy, problem, setProblem, act }
}

const SetScreen = (
  { view, reading, onView, onRefresh, onFailure }: {
    readonly view: PracticeView
    readonly reading: ClockReading | undefined
    readonly onView: (view: PracticeView) => void
    readonly onRefresh: () => Promise<void>
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const actions = useActions(onView, onFailure)
  const [timerHidden, setTimerHidden] = useState(false)
  // The calculator comes with Data Insights Questions only.
  const [calculating, setCalculating] = useState(false)
  const calculatorToggle = useRef<HTMLButtonElement>(null)
  const dataInsights = view.status === "active" && view.current?.question.section.id === "di"
  const remaining = useRemaining(reading)

  // The time left turns to a warning near the end, and is said once then,
  // even with the timer hidden.
  const warningMs = warningFor(view.clock?.limitMs ?? 0)
  const [announcement, setAnnouncement] = useState("")
  const aboveWarning = useRef(remaining === undefined || remaining > warningMs)
  useEffect(() => {
    if (remaining === undefined) return
    if (aboveWarning.current && remaining <= warningMs && remaining > 0) {
      setAnnouncement(`${spokenDuration(Math.ceil(remaining / 1000) * 1000)} left.`)
    }
    aboveWarning.current = remaining > warningMs
  }, [remaining, warningMs])

  // When the time shown runs out, the server ends the set within a second
  // or two; read it then.
  const expired = remaining === 0 && view.status === "active"
  useEffect(() => {
    if (!expired) return
    const timer = setTimeout(() => void onRefresh(), 1500)
    return () => clearTimeout(timer)
  }, [expired, reading, onRefresh])

  const pause = () => void actions.act((client) => client.practice.pause({ params: { id: view.id } }))
  const resume = () => void actions.act((client) => client.practice.resume({ params: { id: view.id } }))
  const claim = () => void actions.act((client) => client.practice.claim({ params: { id: view.id } }))
  const endSet = () => void actions.act((client) => client.practice.finish({ params: { id: view.id } }))

  // Losing the set to another tab moves focus to taking it back; taking it
  // over moves focus to the Question, or to the pause, the banner and its
  // button having gone.
  const takeOver = useRef<HTMLButtonElement>(null)
  const mainHeading = useRef<HTMLHeadingElement>(null)
  const wasHeld = useRef(view.heldHere)
  useEffect(() => {
    if (wasHeld.current && !view.heldHere) takeOver.current?.focus()
    if (!wasHeld.current && view.heldHere) mainHeading.current?.focus()
    wasHeld.current = view.heldHere
  }, [view.heldHere])

  return (
    <div className="practice-set" data-section={view.current?.question.section.id}>
      <p className="back">
        <a className="quiet-link" {...linkProps("/")}>Practice</a>
      </p>
      <div className="set-head">
        <p className="set-title">{view.title}</p>
        <div className="set-controls">
          {remaining !== undefined && view.status === "active" && (
            <Timer
              remainingMs={remaining}
              warningMs={warningMs}
              hidden={timerHidden}
              onToggle={() => setTimerHidden((hidden) => !hidden)}
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
          {view.timed && view.status === "active" && view.heldHere && (
            <button type="button" className="link-button" onClick={pause} disabled={actions.busy}>Pause</button>
          )}
          {view.heldHere && (
            <button type="button" className="link-button set-end" onClick={endSet} disabled={actions.busy}>
              End set
            </button>
          )}
        </div>
      </div>
      {dataInsights && calculating && (
        <Calculator
          onClose={() => {
            setCalculating(false)
            calculatorToggle.current?.focus()
          }}
        />
      )}
      <p className="visually-hidden" role="status">{announcement}</p>
      {view.clock?.interrupted === true && (
        <p className="clock-note">
          The clock did not count time while the app was stopped or the computer slept.
        </p>
      )}
      {!view.heldHere && (
        <div className="held-elsewhere" role="status">
          <p>This set is open in another tab or on another device, so you can only look at it here.</p>
          <button type="button" className="button" ref={takeOver} onClick={claim} disabled={actions.busy}>
            Take it over here
          </button>
        </div>
      )}
      {view.status === "paused"
        ? <Paused view={view} headingRef={mainHeading} busy={actions.busy} problem={actions.problem} onResume={resume} />
        : <QuestionScreen view={view} headingRef={mainHeading} actions={actions} onFailure={onFailure} />}
    </div>
  )
}

// A paused timed set hides its Question until it resumes.
const Paused = (
  { view, headingRef, busy, problem, onResume }: {
    readonly view: PracticeView
    readonly headingRef: RefObject<HTMLHeadingElement | null>
    readonly busy: boolean
    readonly problem: string | undefined
    readonly onResume: () => void
  }
) => {
  useEffect(() => headingRef.current?.focus(), [headingRef])
  return (
    <section className="paused" aria-labelledby="paused-title">
      <h1 id="paused-title" ref={headingRef} tabIndex={-1}>Paused</h1>
      <p className="lede">
        The clock stopped with {minutesAndSeconds(view.clock?.remainingMs ?? 0)} left. The Question stays hidden
        until you resume.
      </p>
      {view.heldHere && (
        <div className="actions">
          <button type="button" className="button" onClick={onResume} disabled={busy}>Resume</button>
        </div>
      )}
      {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
    </section>
  )
}

const QuestionScreen = (
  { view, headingRef, actions, onFailure }: {
    readonly view: PracticeView
    readonly headingRef: RefObject<HTMLHeadingElement | null>
    readonly actions: ReturnType<typeof useActions>
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const { busy, setBusy, problem, act } = actions
  const current = view.current!
  const question = current.question
  const parts = question.parts
  // One Part of five options takes the A to E keys.
  const lettered = parts.length === 1 && parts[0]!.kind === "single-choice" ? parts[0]! : undefined
  const answered = current.response !== null
  // Read-only here while another device holds the set.
  const locked = !view.heldHere
  const [picks, setPicks] = useState<Picks>({})
  const [guessed, setGuessed] = useState(false)
  const [similarNote, setSimilarNote] = useState<string>()
  const questionHeading = headingRef
  const debriefHeading = useRef<HTMLHeadingElement>(null)
  const names = { guess: useId() }
  const last = current.position + 1 >= view.total
  const pick = (part: number, label: string) => setPicks((before) => ({ ...before, [part]: label }))
  const complete = parts.every((part) => picks[part.position] !== undefined)

  // A new Question starts clear, with focus on its heading.
  useEffect(() => {
    setPicks({})
    setGuessed(false)
    setSimilarNote(undefined)
    questionHeading.current?.focus()
  }, [current.position, questionHeading])

  // Once the Question is answered, focus moves to the Debrief, whose heading
  // says how it went. A set opened already answered leaves focus alone.
  const wasAnswered = useRef(answered)
  useEffect(() => {
    if (answered && !wasAnswered.current) debriefHeading.current?.focus()
    wasAnswered.current = answered
  }, [answered])

  const shownPicks: Picks = answered
    ? Object.fromEntries(current.response!.selection.map((each) => [each.part, each.choice]))
    : picks

  const submit = () => {
    if (answered || locked || !complete) return
    void act((client) =>
      client.practice.answer({
        params: { id: view.id },
        payload: {
          seq: view.nextSeq,
          questionId: question.id,
          selection: parts.map((part) => ({ part: part.position, choice: picks[part.position]! })),
          guessed
        }
      })
    )
  }

  const moveOn = () => {
    if (!answered || locked) return
    void act((client) =>
      last
        ? client.practice.finish({ params: { id: view.id } })
        : client.practice.next({ params: { id: view.id }, payload: { position: current.position + 1 } })
    )
  }

  const toggleBookmark = () =>
    void act((client) =>
      client.practice.bookmark({
        params: { id: view.id },
        payload: { questionId: question.id, bookmarked: !current.bookmarked }
      })
    )

  const similar = async () => {
    setBusy(true)
    const result = await call((client) => client.practice.similar({ payload: { questionId: question.id } }))
    setBusy(false)
    if (result._tag === "Success") return navigate(`/practice/${result.success.id}`)
    if (result.failure._tag === "NoQuestionsMatch") {
      return setSimilarNote("No unseen Questions like this one are left. More books would add some.")
    }
    onFailure(result.failure)
  }

  // A to E pick an option and Enter submits; once answered, Enter moves on.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (locked || event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return
      // Keys typed in the calculator, or in the Mistake Type control, are
      // their own: Enter there does not move on.
      if (event.target instanceof Element && event.target.closest(".calculator, .mistakes, .display-menu") !== null) return
      const label = event.key.toUpperCase()
      if (
        !answered && lettered !== undefined && label.length === 1 &&
        lettered.options.some((option) => option.label === label)
      ) {
        event.preventDefault()
        pick(lettered.position, label)
        return
      }
      if (event.key !== "Enter") return
      if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement) return
      event.preventDefault()
      if (answered) moveOn()
      else submit()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  })

  const keys = current.debrief === null
    ? undefined
    : new Map(current.debrief.keys.map((each) => [each.part, each.key] as const))

  const work = (
    <>
      <div className="question-body">
        <RichText source={question.stem} />
        <AnswerParts parts={parts} picks={shownPicks} onPick={pick} disabled={answered || locked} keys={keys} />
      </div>

      {!answered && !locked && (
        <div className="answer-actions">
          <div className="check">
            <input id={names.guess} type="checkbox" checked={guessed} onChange={(event) => setGuessed(event.target.checked)} />
            <label htmlFor={names.guess}>I guessed</label>
          </div>
          <div className="actions">
            <button type="button" className="button" onClick={submit} disabled={!complete || busy}>
              {view.timed ? (last ? "Submit and finish" : "Submit and go on") : "Submit answer"}
            </button>
            <BookmarkButton bookmarked={current.bookmarked} disabled={busy} onToggle={toggleBookmark} />
          </div>
          <p className="hint">
            {lettered !== undefined
              ? "Press A to E to choose, then Enter to submit."
              : "Answer every part, then submit. It is right only when every part is."}
            {view.timed ? " The next Question follows at once; how each went shows at the end." : ""}
          </p>
        </div>
      )}
      {problem !== undefined && <p className="problem" role="alert">{problem}</p>}

      {answered && current.debrief !== null && (
        <>
          <DebriefPanel
            debrief={current.debrief}
            response={current.response}
            timed={view.timed}
            headingRef={debriefHeading}
            parts={parts}
            mistakes={current.mistakes}
            onFailure={onFailure}
            questionId={current.question.id}
          />
          {!locked && (
            <div className="actions debrief-actions">
              <button type="button" className="button" onClick={moveOn} disabled={busy}>
                {last ? "Finish set" : "Next question"}
              </button>
              <button type="button" className="button button-quiet" onClick={() => void similar()} disabled={busy}>
                Practise 3 similar
              </button>
              <BookmarkButton bookmarked={current.bookmarked} disabled={busy} onToggle={toggleBookmark} />
            </div>
          )}
          {similarNote !== undefined && <p className="hint" role="status">{similarNote}</p>}
        </>
      )}
    </>
  )

  return (
    <>
      {current.position === 0 && <Skipped view={view} />}
      <h1 ref={questionHeading} tabIndex={-1} className="question-count">
        Question {current.position + 1} of {view.total}
      </h1>
      <p className="question-meta">
        <span className="swatch" aria-hidden="true" />
        {question.questionType.name}
        {question.source === null
          ? ""
          : `. ${question.source.bookTitle}, ${question.source.set}, question ${question.source.number}`}
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


const BookmarkButton = (
  { bookmarked, disabled, onToggle }: {
    readonly bookmarked: boolean
    readonly disabled: boolean
    readonly onToggle: () => void
  }
) => (
  <button type="button" className="button button-quiet" aria-pressed={bookmarked} onClick={onToggle} disabled={disabled}>
    {bookmarked ? "Bookmarked" : "Bookmark"}
  </button>
)

// A served Question's options as reviewed after the set: the pick marked,
// and the answer named.
export const AnsweredOptions = ({ served }: { readonly served: ServedView }) => {
  const parts = served.question.parts
  // A single Part of five options reads as a list; other Parts as they were
  // answered, read-only.
  if (parts.length > 1 || parts[0]?.kind !== "single-choice") {
    const picks = Object.fromEntries((served.response?.selection ?? []).map((each) => [each.part, each.choice]))
    const keys = new Map((served.debrief?.keys ?? []).map((each) => [each.part, each.key] as const))
    return <AnswerParts parts={parts} picks={picks} onPick={() => {}} disabled keys={keys} />
  }
  const part = parts[0]
  const picked = served.response?.selection.find((each) => each.part === part.position)?.choice
  const key = served.debrief?.keys.find((each) => each.part === part.position)?.key
  return (
    <ul className="answered-options">
      {part.options.map((option) => {
        const isPicked = option.label === picked
        const isKey = option.label === key
        return (
          <li
            key={option.label}
            className="answered-option"
            data-key={isKey || undefined}
            data-missed={(isPicked && !isKey) || undefined}
          >
            <span className={isPicked ? "answer-letter mark" : "answer-letter"}>{option.label}</span>
            <span className="answer-text">
              <RichInline source={option.text} />
              {isKey && <span className="answer-flag">The answer</span>}
              {isPicked && !isKey && <span className="answer-flag">Your answer</span>}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

const SkipLabels: Record<ItemRef["reason"], string> = {
  reserve: "Held for Mocks",
  undecided: "Held until the Mock Reserve is decided",
  checking: "Not in the Question Bank yet",
  withdrawn: "Withdrawn from the Question Bank",
  "in-section": "In your Sectional or Mock, until it ends"
}

// The book's items the set leaves out, and why.
const Skipped = ({ view }: { readonly view: PracticeView }) => {
  const items = [...view.heldForMocks, ...view.unavailable]
  if (items.length === 0) return null
  const reasons = (Object.keys(SkipLabels) as Array<ItemRef["reason"]>).filter((reason) =>
    items.some((item) => item.reason === reason)
  )
  return (
    <div className="held-note">
      <p>This set leaves out some of the book's items.</p>
      <ul>
        {reasons.map((reason) => (
          <li key={reason}>
            {SkipLabels[reason]}: {items.filter((item) => item.reason === reason).map((item) => `${item.set} ${item.number}`)
              .join(", ")}.
          </li>
        ))}
      </ul>
    </div>
  )
}

const resultText = (result: PracticeResult) =>
  result.timedOut ? "Time ran out" : result.correct === null ? "Not answered" : result.correct ? "Right" : "Wrong"

// How a set went, in one or two sentences. The Question on screen when time
// ran out counts as answered, and wrong, as it does on Practice.
const outcomeText = (view: PracticeView) => {
  const answered = view.results.filter((result) => result.correct !== null)
  const right = answered.filter((result) => result.correct === true).length
  const unanswered = view.results.length - answered.length
  const parts = [
    answered.length === 0 ? "Nothing was answered in this set." : `${right} of ${answered.length} right.`,
    unanswered > 0 ? `${unanswered} left unanswered.` : undefined,
    view.endedBy === "time" ? "Time ran out." : undefined,
    view.results.length < view.total ? `The set ended after ${view.results.length} of ${view.total} Questions.` : undefined,
    view.clock === null
      ? undefined
      : `You took ${spokenDuration(Math.min(view.clock.elapsedMs, view.clock.limitMs))} of ${
        spokenDuration(view.clock.limitMs)
      }.`
  ]
  return parts.filter((part) => part !== undefined).join(" ")
}

const SetSummary = (
  { view, onFailure }: { readonly view: PracticeView; readonly onFailure: (failure: { readonly _tag: string }) => void }
) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  return (
    <>
      <p className="back">
        <a className="quiet-link" {...linkProps("/")}>Practice</a>
      </p>
      <h1 ref={heading} tabIndex={-1}>{view.title}</h1>
      <p className="lede">{outcomeText(view)}</p>
      {view.timed && (
        <p className="quiet">Answers to Questions you had not seen before count toward your Score Estimates on Practice.</p>
      )}
      <Skipped view={view} />
      <ol className="set-results">
        {view.results.map((result) => (
          <ResultRow key={result.position} view={view} result={result} onFailure={onFailure} />
        ))}
      </ol>
      <div className="actions">
        <a className="button" {...linkProps("/")}>Back to Practice</a>
      </div>
    </>
  )
}

type Review = { readonly _tag: "Closed" } | { readonly _tag: "Loading" } | { readonly _tag: "Open"; readonly served: ServedView }

const ResultRow = (
  { view, result, onFailure }: {
    readonly view: PracticeView
    readonly result: PracticeResult
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const [review, setReview] = useState<Review>({ _tag: "Closed" })
  const toggle = async () => {
    if (review._tag !== "Closed") return setReview({ _tag: "Closed" })
    setReview({ _tag: "Loading" })
    const loaded = await call((client) =>
      client.practice.review({ params: { id: view.id, position: result.position } })
    )
    if (loaded._tag === "Success") setReview({ _tag: "Open", served: loaded.success })
    else {
      setReview({ _tag: "Closed" })
      onFailure(loaded.failure)
    }
  }
  const panel = useId()
  return (
    <li
      className="set-result"
      data-result={result.timedOut ? "wrong" : result.correct === null ? "unanswered" : result.correct ? "right" : "wrong"}
    >
      <div className="set-result-head">
        <span className="set-result-name">Question {result.position + 1}, {result.questionType.name}</span>
        <span className="set-result-outcome">{resultText(result)}</span>
        <span className="set-result-facts">
          {[
            result.timeSpentMs === null ? undefined : spokenDuration(result.timeSpentMs),
            result.guessed ? "guessed" : undefined,
            result.bookmarked ? "Bookmarked" : undefined
          ].filter((part) => part !== undefined).join(", ")}
        </span>
        <button
          type="button"
          className="link-button"
          aria-expanded={review._tag === "Open"}
          aria-controls={panel}
          onClick={() => void toggle()}
        >
          {review._tag === "Open" ? "Hide" : "Show the Debrief"}
        </button>
      </div>
      <div id={panel} className="set-result-review" hidden={review._tag !== "Open"}>
        {review._tag === "Open" && (
          <>
            {review.served.question.stimulus !== null && <StimulusDetails stimulus={review.served.question.stimulus} />}
            <RichText source={review.served.question.stem} />
            <AnsweredOptions served={review.served} />
            {review.served.debrief !== null && (
              <DebriefPanel
                debrief={review.served.debrief}
                response={review.served.response}
                timed={view.timed}
                parts={review.served.question.parts}
                mistakes={review.served.mistakes}
                onFailure={onFailure}
                questionId={review.served.question.id}
              />
            )}
          </>
        )}
      </div>
    </li>
  )
}
