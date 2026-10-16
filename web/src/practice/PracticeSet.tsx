import type { Effect } from "effect"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import {
  type PracticeOutOfStep,
  type PracticeResult,
  type PracticeView,
  type SelectionInvalid,
  type ServedView,
  SessionId
} from "../../../src/api/Practice.ts"
import { call, type Client } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { spokenDuration } from "../format.ts"
import { RichInline, RichText } from "../RichText.tsx"
import { linkProps, navigate } from "../router.ts"
import { DebriefPanel } from "./DebriefPanel.tsx"

interface Props {
  readonly id: string
  readonly onSessionLost: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

// One Practice Set: the Question on screen and, once answered, its Debrief;
// when the set is over, how it went.
export const PracticeSet = ({ id, onSessionLost, onStopped }: Props) => {
  const [view, setView] = useState<PracticeView>()
  const [missing, setMissing] = useState(false)

  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "NotUnlocked" ? onSessionLost() : onStopped(failure)),
    [onSessionLost, onStopped]
  )

  useEffect(() => {
    let live = true
    setView(undefined)
    void call((client) => client.practice.get({ params: { id: SessionId.make(id) } })).then((result) => {
      if (!live) return
      if (result._tag === "Success") setView(result.success)
      else if (result.failure._tag === "PracticeNotFound") setMissing(true)
      else handle(result.failure)
    })
    return () => {
      live = false
    }
  }, [id, handle])

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
  return view.status === "finished"
    ? <SetSummary view={view} onFailure={handle} />
    : <QuestionScreen key={view.id} view={view} onView={setView} onFailure={handle} />
}

const isOutOfStep = (failure: { readonly _tag: string }): failure is PracticeOutOfStep =>
  failure._tag === "PracticeOutOfStep"

const isSelectionInvalid = (failure: { readonly _tag: string }): failure is SelectionInvalid =>
  failure._tag === "SelectionInvalid"

// Keys typed into a text field are the field's; a radio button or a
// checkbox leaves the shortcuts working.
const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement ||
    (target instanceof HTMLInputElement && !["radio", "checkbox", "button", "submit"].includes(target.type)))

const QuestionScreen = (
  { view, onView, onFailure }: {
    readonly view: PracticeView
    readonly onView: (view: PracticeView) => void
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const current = view.current!
  const question = current.question
  const part = question.parts[0]!
  const answered = current.response !== null
  const [picked, setPicked] = useState<string>()
  const [guessed, setGuessed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [similarNote, setSimilarNote] = useState<string>()
  const questionHeading = useRef<HTMLHeadingElement>(null)
  const debriefHeading = useRef<HTMLHeadingElement>(null)
  const names = { options: useId(), guess: useId() }
  const last = current.position + 1 >= view.total

  // A new Question starts clear, with focus on its heading.
  useEffect(() => {
    setPicked(undefined)
    setGuessed(false)
    setProblem(undefined)
    setSimilarNote(undefined)
    questionHeading.current?.focus()
  }, [current.position])

  const chosen = answered ? current.response!.selection.find((each) => each.part === part.position)?.choice : picked

  // Sends one change to the set and shows the set as the server returns it.
  const act = async <E extends { readonly _tag: string }>(
    request: (client: Client) => Effect.Effect<PracticeView, E>,
    after?: () => void
  ) => {
    if (busy) return
    setBusy(true)
    setProblem(undefined)
    const result = await call(request)
    setBusy(false)
    if (result._tag === "Success") {
      onView(result.success)
      after?.()
      return
    }
    const failure: { readonly _tag: string } = result.failure
    if (isOutOfStep(failure)) {
      onView(failure.view)
      setProblem("The set had moved on in another tab, so this shows where it stands now.")
    } else if (isSelectionInvalid(failure)) {
      setProblem(failure.problems.join(" "))
    } else {
      onFailure(failure)
    }
  }

  const submit = () => {
    if (answered || picked === undefined) return
    void act(
      (client) =>
        client.practice.answer({
          params: { id: view.id },
          payload: {
            seq: view.nextSeq,
            questionId: question.id,
            selection: [{ part: part.position, choice: picked }],
            guessed
          }
        }),
      () => requestAnimationFrame(() => debriefHeading.current?.focus())
    )
  }

  const moveOn = () => {
    if (!answered) return
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

  const endSet = () => void act((client) => client.practice.finish({ params: { id: view.id } }))

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
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return
      const label = event.key.toUpperCase()
      if (!answered && label.length === 1 && part.options.some((option) => option.label === label)) {
        event.preventDefault()
        setPicked(label)
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

  const key = current.debrief?.keys.find((each) => each.part === part.position)?.key

  return (
    <div className="practice-set" data-section={question.section.id}>
      <p className="back">
        <a className="quiet-link" {...linkProps("/")}>Practice</a>
      </p>
      <div className="set-head">
        <p className="set-title">{view.title}</p>
        <button type="button" className="link-button set-end" onClick={endSet} disabled={busy}>
          End set
        </button>
      </div>
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

      <div className="question-body">
        <RichText source={question.stem} />
        {part.prompt !== null && <RichText source={part.prompt} />}
        <fieldset className="answer-options" disabled={answered || busy}>
          <legend className="visually-hidden">Answer choices</legend>
          {part.options.map((option) => {
            const isPicked = chosen === option.label
            const isKey = key === option.label
            return (
              <label
                key={option.label}
                className="answer-option"
                data-picked={isPicked || undefined}
                data-key={(answered && isKey) || undefined}
                data-missed={(answered && isPicked && !isKey) || undefined}
              >
                <input
                  type="radio"
                  name={names.options}
                  value={option.label}
                  checked={isPicked}
                  onChange={() => setPicked(option.label)}
                />
                <span className={isPicked ? "answer-letter mark" : "answer-letter"}>{option.label}</span>
                <span className="answer-text">
                  <RichInline source={option.text} />
                  {answered && isKey && <span className="answer-flag">The answer</span>}
                  {answered && isPicked && !isKey && <span className="answer-flag">Your answer</span>}
                </span>
              </label>
            )
          })}
        </fieldset>
      </div>

      {!answered && (
        <div className="answer-actions">
          <div className="check">
            <input id={names.guess} type="checkbox" checked={guessed} onChange={(event) => setGuessed(event.target.checked)} />
            <label htmlFor={names.guess}>I guessed</label>
          </div>
          <div className="actions">
            <button type="button" className="button" onClick={submit} disabled={picked === undefined || busy}>
              Submit answer
            </button>
            <BookmarkButton bookmarked={current.bookmarked} disabled={busy} onToggle={toggleBookmark} />
          </div>
          <p className="hint">Press A to E to choose, then Enter to submit.</p>
        </div>
      )}
      {problem !== undefined && <p className="problem" role="alert">{problem}</p>}

      {answered && current.debrief !== null && (
        <>
          <DebriefPanel debrief={current.debrief} response={current.response} headingRef={debriefHeading} />
          <div className="actions debrief-actions">
            <button type="button" className="button" onClick={moveOn} disabled={busy}>
              {last ? "Finish set" : "Next question"}
            </button>
            <button type="button" className="button button-quiet" onClick={() => void similar()} disabled={busy}>
              Practise 3 similar
            </button>
            <BookmarkButton bookmarked={current.bookmarked} disabled={busy} onToggle={toggleBookmark} />
          </div>
          {similarNote !== undefined && <p className="hint" role="status">{similarNote}</p>}
        </>
      )}
    </div>
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
const AnsweredOptions = ({ served }: { readonly served: ServedView }) => {
  const part = served.question.parts[0]
  const picked = served.response?.selection.find((each) => each.part === part?.position)?.choice
  const key = served.debrief?.keys.find((each) => each.part === part?.position)?.key
  return (
    <ul className="answered-options">
      {part?.options.map((option) => {
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

const resultText = (result: PracticeResult) =>
  result.correct === null ? "Not answered" : result.correct ? "Right" : "Wrong"

const SetSummary = (
  { view, onFailure }: { readonly view: PracticeView; readonly onFailure: (failure: { readonly _tag: string }) => void }
) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const answered = view.results.filter((result) => result.correct !== null)
  const right = answered.filter((result) => result.correct === true).length
  const unanswered = view.results.length - answered.length
  return (
    <>
      <p className="back">
        <a className="quiet-link" {...linkProps("/")}>Practice</a>
      </p>
      <h1 ref={heading} tabIndex={-1}>{view.title}</h1>
      <p className="lede">
        {answered.length === 0
          ? "Nothing was answered in this set."
          : `${right} of ${answered.length} right${unanswered > 0 ? `, ${unanswered} left unanswered` : ""}.`}
        {view.results.length < view.total && ` The set ended after ${view.results.length} of ${view.total} Questions.`}
      </p>
      {view.heldForMocks.length > 0 && (
        <p className="held-note">
          Held for Mocks, so not in this set: {view.heldForMocks.map((item) => `${item.set} ${item.number}`).join(", ")}.
        </p>
      )}
      {view.unavailable.length > 0 && (
        <p className="held-note">
          Not in the Question Bank yet: {view.unavailable.map((item) => `${item.set} ${item.number}`).join(", ")}.
        </p>
      )}
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
    <li className="set-result" data-result={result.correct === null ? "unanswered" : result.correct ? "right" : "wrong"}>
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
            <RichText source={review.served.question.stem} />
            <AnsweredOptions served={review.served} />
            {review.served.debrief !== null && (
              <DebriefPanel debrief={review.served.debrief} response={review.served.response} />
            )}
          </>
        )}
      </div>
    </li>
  )
}
