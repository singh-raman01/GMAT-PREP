import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react"
import type { BookId } from "../../../src/api/Books.ts"
import { bandNames, type DifficultyBand } from "../../../src/api/difficulty.ts"
import {
  DefaultSetSize,
  MaxSetSize,
  type PracticeChoice,
  type PracticeOptions,
  type PracticePreview,
  type PracticeSummary,
  type StatusFilter
} from "../../../src/api/Practice.ts"
import type { ScoreEstimates } from "../../../src/api/Scores.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { dayAndTime, spokenDuration } from "../format.ts"
import { linkProps, navigate } from "../router.ts"

interface Props {
  readonly onSessionLost: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

const statusLabels: Record<StatusFilter, string> = {
  any: "Any",
  unseen: "Not seen yet",
  missed: "Missed before",
  bookmarked: "Bookmarked"
}

type Mode = "filters" | "book"

// What the form holds, as typed.
interface Form {
  readonly mode: Mode
  readonly section: string
  readonly questionType: string
  readonly skill: string
  readonly band: DifficultyBand | ""
  readonly status: StatusFilter
  readonly size: string
  readonly bookId: string
  readonly set: string
  readonly from: string
  readonly to: string
  readonly timed: boolean
}

const blank: Form = {
  mode: "filters",
  section: "",
  questionType: "",
  skill: "",
  band: "",
  status: "unseen",
  size: String(DefaultSetSize),
  bookId: "",
  set: "",
  from: "",
  to: "",
  timed: false
}

const wholeNumber = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined)

// The choice the form describes, or what is wrong with it.
const choiceOf = (form: Form): { readonly choice: PracticeChoice } | { readonly problem: string } => {
  if (form.mode === "filters") {
    const size = wholeNumber(form.size)
    if (size === undefined || size < 1 || size > MaxSetSize) {
      return { problem: `Choose from 1 to ${MaxSetSize} Questions.` }
    }
    return {
      choice: {
        kind: "filters",
        status: form.status,
        size,
        ...(form.timed ? { timed: true } : {}),
        ...(form.section === "" ? {} : { section: form.section }),
        ...(form.questionType === "" ? {} : { questionType: form.questionType }),
        ...(form.skill === "" ? {} : { skill: form.skill }),
        ...(form.band === "" ? {} : { band: form.band })
      }
    }
  }
  if (form.bookId === "") return { problem: "Choose a book." }
  const from = form.from.trim() === "" ? undefined : wholeNumber(form.from)
  const to = form.to.trim() === "" ? undefined : wholeNumber(form.to)
  if (from === 0 || to === 0 || (form.from.trim() !== "" && from === undefined) || (form.to.trim() !== "" && to === undefined)) {
    return { problem: "Item numbers are whole numbers from 1." }
  }
  if (from !== undefined && to !== undefined && from > to) return { problem: `Item ${from} comes after item ${to}.` }
  return {
    choice: {
      kind: "book",
      bookId: form.bookId as BookId,
      ...(form.timed ? { timed: true } : {}),
      ...(form.set === "" ? {} : { set: form.set }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to })
    }
  }
}

const previewText = (preview: PracticePreview, mode: Mode) =>
  `${countText(preview, mode)}${preview.limitMs === null || preview.questions === 0 ? "" : ` Time: ${spokenDuration(preview.limitMs)}.`}`

const countText = (preview: PracticePreview, mode: Mode) => {
  const held = preview.heldForMocks > 0
    ? ` ${preview.heldForMocks} ${preview.heldForMocks === 1 ? "is" : "are"} held back for Mocks.`
    : ""
  const missing = preview.unavailable > 0
    ? ` ${preview.unavailable} ${preview.unavailable === 1 ? "is" : "are"} not in the Question Bank.`
    : ""
  const running = preview.inSection > 0
    ? ` ${preview.inSection} ${preview.inSection === 1 ? "is" : "are"} in your Sectional or Mock, until it ends.`
    : ""
  if (preview.questions === 0) return `No Questions to practise with these choices.${held}${missing}${running}`
  if (mode === "book") {
    return `${preview.questions} ${preview.questions === 1 ? "Question" : "Questions"} in book order.${held}${missing}${running}`
  }
  return `${
    preview.matching > preview.questions
      ? `${preview.matching} Questions match; the set takes ${preview.questions}.`
      : `${preview.questions} ${preview.questions === 1 ? "Question matches" : "Questions match"}.`
  }${running}`
}

export const PracticeHome = ({ onSessionLost, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const [options, setOptions] = useState<PracticeOptions>()
  const [sets, setSets] = useState<ReadonlyArray<PracticeSummary>>()
  const [scores, setScores] = useState<ScoreEstimates>()
  const mounted = useRef(true)

  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "NotUnlocked" ? onSessionLost() : onStopped(failure)),
    [onSessionLost, onStopped]
  )

  const loadSets = useCallback(async () => {
    const result = await call((client) => client.practice.list())
    if (!mounted.current) return
    if (result._tag === "Failure") return handle(result.failure)
    setSets(result.success)
  }, [handle])

  useEffect(() => {
    mounted.current = true
    void call((client) => client.practice.options()).then((result) => {
      if (!mounted.current) return
      if (result._tag === "Failure") return handle(result.failure)
      setOptions(result.success)
    })
    void loadSets()
    void call((client) => client.scores.estimates()).then((result) => {
      if (mounted.current && result._tag === "Success") setScores(result.success)
    })
    return () => {
      mounted.current = false
    }
  }, [handle, loadSets])

  // A set another tab or device holds is ended here only once the Learner
  // says to take it over.
  const [confirming, setConfirming] = useState<PracticeSummary["id"]>()
  const end = async (id: PracticeSummary["id"]) => {
    const result = await call((client) => client.practice.finish({ params: { id } }))
    if (result._tag === "Failure" && result.failure._tag === "HeldElsewhere") return setConfirming(id)
    if (result._tag === "Failure" && result.failure._tag !== "PracticeNotFound") return handle(result.failure)
    void loadSets()
  }
  const takeOverAndEnd = async (id: PracticeSummary["id"]) => {
    const claimed = await call((client) => client.practice.claim({ params: { id } }))
    if (claimed._tag === "Failure" && claimed.failure._tag !== "PracticeNotFound") return handle(claimed.failure)
    setConfirming(undefined)
    await end(id)
  }

  const active = sets?.filter((set) => set.status !== "finished") ?? []
  const finished = sets?.filter((set) => set.status === "finished") ?? []
  const empty = options !== undefined && options.sections.every((section) => section.questions === 0)

  return (
    <>
      <h1 ref={heading} tabIndex={-1}>Practice</h1>
      <p className="lede">
        Answer one Question at a time. An untimed set shows how each is solved straight after; a timed set runs on
        the clock, shows it all at the end, and moves your Score Estimates.
      </p>
      {scores !== undefined && scores.sections.length > 0 && <Scores scores={scores} />}
      {active.length > 0 && (
        <section className="group" aria-labelledby="sets-active">
          <h2 id="sets-active">Sets in progress</h2>
          <ul className="set-list">
            {active.map((set) => (
              <li key={set.id}>
                <a className="set-name" {...linkProps(`/practice/${set.id}`)}>{set.title}</a>
                <span className="set-facts">
                  {set.answered} of {set.total} answered{set.status === "paused" ? ", paused" : ""}, started{" "}
                  {dayAndTime(set.createdAt)}
                </span>
                <button
                  type="button"
                  className="link-button"
                  aria-label={`End ${set.title}`}
                  onClick={() => void end(set.id)}
                >
                  End
                </button>
                {confirming === set.id && (
                  <EndElsewhere
                    title={set.title}
                    onEnd={() => void takeOverAndEnd(set.id)}
                    onKeep={() => setConfirming(undefined)}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="group" aria-labelledby="sets-start">
        <h2 id="sets-start">Start a set</h2>
        {options === undefined
          ? <p className="quiet" aria-busy="true">Loading what you can practise</p>
          : empty
          ? (
            <p className="empty">
              No Questions are published yet. The Curator adds books, and their Questions appear here once checked.
            </p>
          )
          : <StartForm options={options} onFailure={handle} />}
      </section>
      {finished.length > 0 && (
        <section className="group" aria-labelledby="sets-done">
          <h2 id="sets-done">Finished sets</h2>
          <ul className="set-list">
            {finished.map((set) => (
              <li key={set.id}>
                <a className="set-name" {...linkProps(`/practice/${set.id}`)}>{set.title}</a>
                <span className="set-facts">
                  {set.answered === 0 ? "Nothing answered" : `${set.correct} of ${set.answered} right`}
                  {set.endedBy === "time" ? ", time ran out" : ""}, {dayAndTime(set.finishedAt ?? set.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

// Asked when the set to end is open in another tab or on another device.
const EndElsewhere = (
  { title, onEnd, onKeep }: { readonly title: string; readonly onEnd: () => void; readonly onKeep: () => void }
) => {
  const first = useFocusOnMount<HTMLButtonElement>()
  return (
    <div className="end-elsewhere" role="group" aria-label={`End ${title}`}>
      <p>This set is open in another tab or on another device. End it from here anyway?</p>
      <div className="actions">
        <button type="button" className="button" ref={first} onClick={onEnd}>Take it over and end it</button>
        <button type="button" className="button button-quiet" onClick={onKeep}>Keep it going</button>
      </div>
    </div>
  )
}

// Each Section's Score Estimate from timed answers, with its likely range,
// and the Total once all three have one.
const Scores = ({ scores }: { readonly scores: ScoreEstimates }) => (
  <section className="group" aria-labelledby="scores-title">
    <h2 id="scores-title">Score Estimates</h2>
    <ul className="score-list">
      {scores.total !== null && (
        <li className="score-total">
          <span className="score-section">Total</span>
          <span className="score-value">{scores.total.score}</span>
          <span className="score-facts">
            likely {scores.total.low} to {scores.total.high}
            {scores.total.calibrated ? "" : ", not yet calibrated"}
          </span>
        </li>
      )}
      {scores.sections.map((each) => (
        <li key={each.section.id}>
          <span className="score-section">{each.section.name}</span>
          <span className="score-value">{each.score}</span>
          <span className="score-facts">
            likely {each.low} to {each.high}, from {each.ratedResponses} timed{" "}
            {each.ratedResponses === 1 ? "answer" : "answers"}
          </span>
        </li>
      ))}
    </ul>
    {scores.sections.some((each) => !each.calibrated) && (
      <p className="hint">
        Section scores run from 60 to 90. These are estimates from your timed answers, not yet calibrated against an
        Official Score; you can enter one under <a {...linkProps("/scores")}>Scores</a>.
      </p>
    )}
  </section>
)

const StartForm = (
  { options, onFailure }: { readonly options: PracticeOptions; readonly onFailure: (failure: { readonly _tag: string }) => void }
) => {
  const ids = {
    section: useId(),
    type: useId(),
    skill: useId(),
    size: useId(),
    book: useId(),
    set: useId(),
    from: useId(),
    to: useId(),
    timed: useId(),
    timedHint: useId(),
    preview: useId()
  }
  const [form, setForm] = useState<Form>(() => ({ ...blank, bookId: options.books[0]?.id ?? "" }))
  const [preview, setPreview] = useState<PracticePreview>()
  const [problem, setProblem] = useState<string>()
  const busy = useRef(false)
  const change = (patch: Partial<Form>) => {
    setProblem(undefined)
    setForm((current) => ({ ...current, ...patch }))
  }

  const chosen = choiceOf(form)
  const key = JSON.stringify("choice" in chosen ? chosen.choice : chosen.problem)

  // How many Questions the choices give, read again as they change.
  useEffect(() => {
    if (!("choice" in chosen)) return setPreview(undefined)
    let live = true
    const timer = setTimeout(() => {
      void call((client) => client.practice.preview({ payload: { choice: chosen.choice } })).then((result) => {
        if (!live) return
        if (result._tag === "Success") return setPreview(result.success)
        if (result.failure._tag === "FiltersInvalid") return setPreview(undefined)
        onFailure(result.failure)
      })
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // The choice is a new object each render; its key changes only when the
    // choice does.
  }, [key, onFailure])

  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!("choice" in chosen)) return setProblem(chosen.problem)
    if (busy.current) return
    busy.current = true
    const result = await call((client) => client.practice.start({ payload: { choice: chosen.choice } }))
    busy.current = false
    if (result._tag === "Success") return navigate(`/practice/${result.success.id}`)
    switch (result.failure._tag) {
      case "NoQuestionsMatch":
        return setProblem(
          result.failure.inSection > 0
            ? `No Questions to practise now: ${result.failure.inSection} ${
              result.failure.inSection === 1 ? "is" : "are"
            } in your Sectional or Mock, until it ends.`
            : chosen.choice.kind === "filters"
            ? "No Questions match these choices. Try fewer filters."
            : result.failure.heldForMocks > 0 || result.failure.unavailable > 0
            ? "Every item in that range is held back for Mocks or not in the Question Bank."
            : "That range has no items. Check the item numbers against the book."
        )
      case "FiltersInvalid":
        return setProblem(result.failure.problems.join(" "))
      case "BookNotFound":
        return setProblem("That book is no longer in the Question Bank.")
      default:
        return onFailure(result.failure)
    }
  }

  const section = options.sections.find((each) => each.id === form.section)
  const shownSections = options.sections.filter((each) => each.questions > 0)
  const types = (section === undefined ? shownSections : [section]).flatMap((each) =>
    each.questionTypes.filter((type) => type.questions > 0).map((type) => ({ ...type, section: each.name }))
  )
  // A Skill used in several Sections, as Quantitative Skills are in Data
  // Insights, is listed once with all its Questions.
  const skills = [
    ...(section === undefined ? shownSections : [section]).flatMap((each) => each.skills).reduce(
      (merged, skill) =>
        merged.set(skill.id, { ...skill, questions: (merged.get(skill.id)?.questions ?? 0) + skill.questions }),
      new Map<string, { readonly id: string; readonly name: string; readonly questions: number }>()
    ).values()
  ]
  const book = options.books.find((each) => each.id === form.bookId)
  const set = book?.sets.find((each) => each.name === form.set)

  return (
    <form className="practice-start" noValidate onSubmit={(event) => void start(event)}>
      <fieldset className="inline-field">
        <legend>Choose Questions</legend>
        <div className="inline-choices">
          <label className="inline-choice">
            <input
              type="radio"
              name="practice-mode"
              checked={form.mode === "filters"}
              onChange={() => change({ mode: "filters" })}
            />
            By topic and level
          </label>
          <label className="inline-choice">
            <input
              type="radio"
              name="practice-mode"
              checked={form.mode === "book"}
              disabled={options.books.length === 0}
              onChange={() => change({ mode: "book" })}
            />
            From a book, in order
          </label>
        </div>
      </fieldset>

      {form.mode === "filters"
        ? (
          <div className="practice-fields">
            <div className="select-row">
              <div className="field">
                <label htmlFor={ids.section}>Section</label>
                <select
                  id={ids.section}
                  value={form.section}
                  onChange={(event) => change({ section: event.target.value, questionType: "", skill: "" })}
                >
                  <option value="">Every Section</option>
                  {shownSections.map((each) => <option key={each.id} value={each.id}>{each.name} ({each.questions})</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor={ids.type}>Question Type</label>
                <select id={ids.type} value={form.questionType} onChange={(event) => change({ questionType: event.target.value })}>
                  <option value="">Any</option>
                  {types.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name} ({type.questions}){section === undefined && shownSections.length > 1 ? `, ${type.section}` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor={ids.skill}>Skill</label>
                <select id={ids.skill} value={form.skill} onChange={(event) => change({ skill: event.target.value })}>
                  <option value="">Any</option>
                  {skills.map((skill) => (
                    <option key={skill.id} value={skill.id}>{skill.name} ({skill.questions})</option>
                  ))}
                </select>
              </div>
            </div>
            <fieldset className="inline-field">
              <legend>Difficulty</legend>
              <div className="inline-choices">
                {(["", "easy", "medium", "hard"] as const).map((band) => (
                  <label key={band} className="inline-choice">
                    <input type="radio" name="practice-band" checked={form.band === band} onChange={() => change({ band })} />
                    {band === "" ? "Any" : bandNames[band]}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="inline-field">
              <legend>Which Questions</legend>
              <div className="inline-choices">
                {(["unseen", "any", "missed", "bookmarked"] as const).map((status) => (
                  <label key={status} className="inline-choice">
                    <input
                      type="radio"
                      name="practice-status"
                      checked={form.status === status}
                      onChange={() => change({ status })}
                    />
                    {statusLabels[status]}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="field">
              <label htmlFor={ids.size}>How many</label>
              <input
                id={ids.size}
                className="number-input"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={form.size}
                onChange={(event) => change({ size: event.target.value })}
              />
            </div>
          </div>
        )
        : (
          <div className="practice-fields">
            <div className="field">
              <label htmlFor={ids.book}>Book</label>
              <select
                id={ids.book}
                value={form.bookId}
                onChange={(event) => change({ bookId: event.target.value, set: "", from: "", to: "" })}
              >
                {options.books.map((each) => <option key={each.id} value={each.id}>{each.title}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor={ids.set}>Set</label>
              <select id={ids.set} value={form.set} onChange={(event) => change({ set: event.target.value, from: "", to: "" })}>
                <option value="">Every set</option>
                {book?.sets.map((each) => (
                  <option key={each.name} value={each.name}>
                    {each.name}, items {each.first} to {each.last}
                  </option>
                ))}
              </select>
            </div>
            {set !== undefined && (
              <div className="item-range">
                <div className="field">
                  <label htmlFor={ids.from}>From item</label>
                  <input
                    id={ids.from}
                    className="number-input"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder={String(set.first)}
                    value={form.from}
                    onChange={(event) => change({ from: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor={ids.to}>To item</label>
                  <input
                    id={ids.to}
                    className="number-input"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder={String(set.last)}
                    value={form.to}
                    onChange={(event) => change({ to: event.target.value })}
                  />
                </div>
              </div>
            )}
            <p className="hint">
              Items held for Mocks or not in the Question Bank are skipped and listed, so the book's numbering still
              lines up.
            </p>
          </div>
        )}

      <div className="check timed-choice">
        <input
          id={ids.timed}
          type="checkbox"
          checked={form.timed}
          aria-describedby={ids.timedHint}
          onChange={(event) => change({ timed: event.target.checked })}
        />
        <label htmlFor={ids.timed}>Time the set</label>
      </div>
      <p id={ids.timedHint} className="hint">
        A timed set gives each Question its Target Time, shows how each went at the end, and counts toward your Score
        Estimates. Its clock keeps running if you close the tab; pause it to stop it.
      </p>
      <p id={ids.preview} className="practice-preview" role="status">
        {"problem" in chosen ? chosen.problem : preview === undefined ? "" : previewText(preview, form.mode)}
      </p>
      <div className="actions">
        <button type="submit" className="button" aria-describedby={ids.preview}>Start the set</button>
      </div>
      {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
    </form>
  )
}
