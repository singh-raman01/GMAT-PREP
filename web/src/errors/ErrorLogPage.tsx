import { useCallback, useEffect, useId, useRef, useState } from "react"
import {
  cursorOf,
  type ErrorLogDetail,
  type ErrorLogEntry,
  type ErrorLogFilters,
  ErrorLogPageSize,
  type ErrorLogView
} from "../../../src/api/ErrorLog.ts"
import { bandNames } from "../../../src/api/difficulty.ts"
import type { PracticeQuestion } from "../../../src/api/Practice.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { calendarDay, dayAndTime, spokenDuration } from "../format.ts"
import { DebriefPanel } from "../practice/DebriefPanel.tsx"
import { AnsweredOptions } from "../practice/PracticeSet.tsx"
import { RichText } from "../RichText.tsx"
import { StimulusDetails } from "../stimulus/StimulusPane.tsx"
import { MyReports } from "../tutor/MyReports.tsx"

// The Error Log: every Question answered wrong, slowly or by a guess, one
// entry each, the latest first, a page at a time, with filters for every way
// to slice it.

interface Props {
  readonly onSessionLost: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

type Filters = { -readonly [K in keyof ErrorLogFilters]: ErrorLogFilters[K] }

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

// The filters a select sets, with the facet it lists.
const selects = [
  ["section", "Section", "sections"],
  ["questionType", "Question Type", "questionTypes"],
  ["skill", "Skill", "skills"],
  ["mistakeType", "Mistake Type", "mistakeTypes"],
  ["trapPattern", "Trap Pattern", "trapPatterns"],
  ["band", "Difficulty", "bands"],
  ["book", "Book", "books"],
  ["status", "Status", "statuses"]
] as const

// Why an entry is in the Error Log, in a few words.
const whyText = (entry: ErrorLogEntry) => {
  if (entry.reasons.includes("wrong")) {
    const kinds = [...new Set(entry.parts.map((part) =>
      part.mistakeType === null ? "not yet labelled" : part.mistakeType.name.toLowerCase()
    ))]
    const traps = [...new Set(entry.parts.flatMap((part) => (part.trapPattern === null ? [] : [part.trapPattern.name.toLowerCase()])))]
    return `Wrong: ${kinds.join(", ")}${traps.length === 0 ? "" : ` (${traps.join(", ")})`}`
  }
  return entry.reasons.includes("slow") && entry.reasons.includes("guessed")
    ? "Slow and guessed"
    : entry.reasons.includes("slow")
    ? "Slow"
    : "Guessed"
}

// Where the entry's Retry Ladder stands.
const stepsText = (steps: ReadonlyArray<number>) =>
  steps.length === 1 ? `step ${steps[0]}` : `steps ${steps.slice(0, -1).join(", ")} and ${steps.at(-1)}`

// How the run that resolved it went: each step's last outcome. A Sibling
// step with no Sibling left was skipped, and counts as passed.
const resolvedText = (ladder: NonNullable<ErrorLogEntry["ladder"]>) => {
  const last = new Map(ladder.steps.map((step) => [step.step, step.outcome] as const))
  const skipped = [1, 2, 3].filter((step) => last.get(step) === "skipped")
  if (skipped.length === 0) return " Resolved: its three retries were right."
  const right = [1, 2, 3].filter((step) => last.get(step) === "passed")
  return ` Resolved: ${right.length === 0 ? "" : `${stepsText(right)} right, `}${stepsText(skipped)} skipped, as no unseen Question like it was left.`
}

const ladderText = (entry: ErrorLogEntry) =>
  entry.status === "resolved" && entry.ladder !== null
    ? resolvedText(entry.ladder)
    : entry.ladder?.step != null && entry.ladder.dueOn !== null
    ? ` Retry step ${entry.ladder.step} on ${calendarDay(entry.ladder.dueOn)}.`
    : ""

const outcomeText = { passed: "right", missed: "missed", skipped: "skipped" } as const

// How often it came here: wrong answers are missed; a right one that was
// slow or guessed is only logged.
const countText = (entry: ErrorLogEntry) => {
  const verb = entry.reasons.includes("wrong") ? "Missed" : "Logged"
  return entry.misses === 1 ? `${verb} once` : `${verb} ${entry.misses} times`
}

// An answer as the screen showed it: a letter for a choice of five, else the
// option's words.
const answerText = (question: PracticeQuestion, selection: ErrorLogDetail["history"][number]["selection"]) =>
  selection.map((choice) => {
    const part = question.parts.find((each) => each.position === choice.part)
    if (part === undefined || part.kind === "single-choice") return choice.choice
    return part.options.find((option) => option.label === choice.choice)?.text ?? choice.choice
  }).join(", ")

const historyText = (item: ErrorLogDetail["history"][number], question: PracticeQuestion, timeZone: string) => {
  const where = item.sessionKind === "practice" ? "Practice Set" : item.sessionKind === "sectional" ? "Sectional" : "Mock"
  const answer = item.kind === "time-out" ? "time ran out" : answerText(question, item.selection) || "no answer"
  const result = item.correct === null ? "" : item.correct ? ", right" : ", wrong"
  const change = item.kind === "edit" ? ", changed in Review & Edit" : ""
  const time = item.kind === "first" ? `, ${spokenDuration(item.timeSpentMs)}` : ""
  return `${dayAndTime(item.at, timeZone)}, ${where}: ${answer}${result}${change}${time}${item.guessed ? ", marked as a guess" : ""}`
}

export const ErrorLogPage = ({ onSessionLost, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const ids = { from: useId(), to: useId(), base: useId() }
  const [filters, setFilters] = useState<Filters>({})
  const [log, setLog] = useState<ErrorLogView>()
  const [entries, setEntries] = useState<ReadonlyArray<ErrorLogEntry>>([])
  // Where the next page starts: after the last entry the pages gave. A label
  // change replaces an entry on screen with its latest miss, which may be
  // newer, so the cursor comes only from the pages.
  const cursor = useRef<string | undefined>(undefined)
  // Counted up as each page lands, so counts asked for before it are dropped.
  const pages = useRef(0)
  // Counted up at each label change, so a page asked for before one has its
  // counts asked for again.
  const edits = useRef(0)
  // The request whose first page is on screen: Show more waits for it, as
  // the cursor belongs to it.
  const landed = useRef(0)
  const [open, setOpen] = useState<string>()
  const [more, setMore] = useState(false)
  // The filters start open on a wide screen, folded on a narrow one.
  const [filtersOpen, setFiltersOpen] = useState(() => window.matchMedia("(min-width: 48rem)").matches)
  const summary = useRef<HTMLElement>(null)
  const request = useRef(0)

  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "NotUnlocked" ? onSessionLost() : onStopped(failure)),
    [onSessionLost, onStopped]
  )

  useEffect(() => {
    const mine = ++request.current
    void call((client) => client.errorLog.list({ query: filters })).then((result) => {
      if (mine !== request.current) return
      if (result._tag === "Failure") return handle(result.failure)
      const last = result.success.entries.at(-1)
      cursor.current = last === undefined ? undefined : cursorOf(last)
      pages.current++
      landed.current = mine
      setLog(result.success)
      setEntries(result.success.entries)
    })
  }, [filters, handle])

  // The counts, from the pages' cursor, without moving the list. A page that
  // lands first may carry counts from before a label change, so they are
  // asked for again from its cursor.
  const recount = useCallback(() => {
    const mine = request.current
    const page = pages.current
    const after = cursor.current
    const query = { ...filters, ...(after === undefined ? {} : { after }), limit: 0 }
    void call((client) => client.errorLog.list({ query })).then((result) => {
      if (mine !== request.current || result._tag === "Failure") return
      if (page !== pages.current) return recount()
      setLog((current) => (current === undefined ? current : { ...current, ...result.success, entries: current.entries }))
    })
  }, [filters])

  const showMore = async () => {
    if (more || landed.current !== request.current) return
    setMore(true)
    const mine = request.current
    const after = cursor.current
    const edited = edits.current
    const result = await call((client) => client.errorLog.list({ query: { ...filters, ...(after === undefined ? {} : { after }) } }))
    setMore(false)
    if (mine !== request.current) return
    if (result._tag === "Failure") return handle(result.failure)
    const last = result.success.entries.at(-1)
    if (last !== undefined) cursor.current = cursorOf(last)
    pages.current++
    setLog(result.success)
    setEntries((current) => [...current, ...result.success.entries])
    // A label changed while the page was on its way: its counts may be older.
    if (edited !== edits.current) recount()
  }

  // A label changed in an open entry: the entry shows it at once, and the
  // counts follow without moving the list, even when the entry no longer
  // matches the filters.
  const changed = useCallback((entry: ErrorLogEntry) => {
    setEntries((current) => current.map((each) => (each.questionId === entry.questionId ? entry : each)))
    edits.current++
    recount()
  }, [recount])

  const set = (key: keyof Filters, value: string) =>
    setFilters((current) => {
      const next = { ...current }
      if (value === "") delete next[key]
      else (next as Record<string, string>)[key] = value
      return next
    })

  const clear = () => {
    setFilters({})
    summary.current?.focus()
  }

  const filtered = Object.keys(filters).length > 0
  const timeZone = log?.timeZone ?? "UTC"
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>Error Log</h1>
      <p className="lede">
        Every Question you answered wrong, slowly or by a guess, one entry each with every answer you gave it. Say what
        went wrong in each one, so the patterns show.
      </p>
      {log !== undefined && log.held > 0 && (
        <p className="hint">
          {log.held === 1
            ? "1 entry waits while its Question is in your Sectional or Mock. It comes back once that ends."
            : `${log.held} entries wait while their Questions are in your Sectional or Mock. They come back once that ends.`}
        </p>
      )}
      {log === undefined ? <p className="quiet" aria-busy="true">Reading your Error Log</p> : log.total === 0
        ? log.held > 0
          ? null
          : <p className="empty">Nothing yet. Questions you miss in Practice Sets, Sectionals and Mocks come here.</p>
        : (
          <>
            <details className="error-filters" open={filtersOpen} onToggle={(event) => setFiltersOpen(event.currentTarget.open)}>
              <summary ref={summary}>
                Filters{filtered ? ` (${Object.keys(filters).length} in use)` : ""}
              </summary>
              <div className="filter-grid">
                {selects.map(([key, label, facet]) => {
                  const values = log.facets[facet]
                  if (values.length === 0) return null
                  const id = `${ids.base}-${key}`
                  return (
                    <div className="field" key={key}>
                      <label htmlFor={id}>{label}</label>
                      <select id={id} value={filters[key] ?? ""} onChange={(event) => set(key, event.target.value)}>
                        <option value="">Any</option>
                        {values.map((value) => (
                          <option key={value.id} value={value.id}>
                            {key === "band" ? bandNames[value.id as keyof typeof bandNames] : value.name} ({value.entries})
                          </option>
                        ))}
                      </select>
                    </div>
                  )
                })}
                <div className="field field-date">
                  <label htmlFor={ids.from}>Missed from</label>
                  <input id={ids.from} type="date" value={filters.from ?? ""} onChange={(event) => set("from", event.target.value)} />
                </div>
                <div className="field field-date">
                  <label htmlFor={ids.to}>Missed to</label>
                  <input id={ids.to} type="date" value={filters.to ?? ""} onChange={(event) => set("to", event.target.value)} />
                </div>
              </div>
            </details>
            <div className="filter-count">
              <p role="status">
                {filtered ? `${log.matching} of ${plural(log.total, "entry", "entries")}` : plural(log.total, "entry", "entries")}
              </p>
              {filtered && <button type="button" className="link-button" onClick={clear}>Clear the filters</button>}
            </div>
            <ol className="error-list">
              {entries.map((entry) => (
                <EntryRow
                  key={entry.questionId}
                  entry={entry}
                  timeZone={timeZone}
                  open={open === entry.questionId}
                  onToggle={() => setOpen((current) => (current === entry.questionId ? undefined : entry.questionId))}
                  onChanged={changed}
                  onFailure={handle}
                />
              ))}
            </ol>
            {log.more > 0 && (
              <div className="actions">
                <button type="button" className="button button-quiet" onClick={() => void showMore()} disabled={more}>
                  Show {Math.min(log.more, ErrorLogPageSize)} more
                </button>
              </div>
            )}
          </>
        )}
      <MyReports onFailure={handle} />
    </>
  )
}

type Opened =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Held" }
  | { readonly _tag: "Shown"; readonly detail: ErrorLogDetail }

const EntryRow = (
  { entry, timeZone, open, onToggle, onChanged, onFailure }: {
    readonly entry: ErrorLogEntry
    readonly timeZone: string
    readonly open: boolean
    readonly onToggle: () => void
    readonly onChanged: (entry: ErrorLogEntry) => void
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const panel = useId()
  const [opened, setOpened] = useState<Opened>({ _tag: "Loading" })
  useEffect(() => {
    if (!open) return
    let live = true
    setOpened({ _tag: "Loading" })
    void call((client) => client.errorLog.get({ params: { questionId: entry.questionId } })).then((result) => {
      if (!live) return
      if (result._tag === "Success") return setOpened({ _tag: "Shown", detail: result.success })
      if (result.failure._tag === "ErrorLogEntryHeld") return setOpened({ _tag: "Held" })
      onFailure(result.failure)
    })
    return () => {
      live = false
    }
  }, [open, entry.questionId, onFailure])
  const about = [entry.questionType.name, entry.primarySkill?.name, `${bandNames[entry.band].toLowerCase()} difficulty`]
    .filter((part) => part !== undefined).join(", ")
  return (
    <li className="error-entry" data-section={entry.section.id} data-status={entry.status}>
      <div className="error-head">
        <span className="swatch" aria-hidden="true" />
        <span className="error-about">{about}</span>
        <button type="button" className="link-button" aria-expanded={open} aria-controls={panel} onClick={onToggle}>
          {open ? "Close" : "Open"}
          <span className="visually-hidden"> the entry, {about}</span>
        </button>
      </div>
      {!open && (
        <div className="error-stem">
          <RichText source={entry.stem} />
        </div>
      )}
      <p className="set-facts">
        {whyText(entry)}. {countText(entry)}, last {dayAndTime(entry.lastMissedAt, timeZone)}
        {entry.books.length === 0 ? "" : `, from ${entry.books.map((book) => book.name).join(" and ")}`}
        {entry.status === "withdrawn" ? ". Withdrawn from the Question Bank, so this entry is closed" : ""}.
        {entry.status === "withdrawn" ? "" : ladderText(entry)}
      </p>
      <div id={panel} className="error-detail" hidden={!open}>
        {!open ? null : opened._tag === "Loading"
          ? <p className="quiet" aria-busy="true">Opening the entry</p>
          : opened._tag === "Held"
          ? <p className="hint">This Question is in your Sectional or Mock now. Its entry opens once that ends.</p>
          : (
            <>
              {opened.detail.served.question.stimulus !== null && (
                <StimulusDetails stimulus={opened.detail.served.question.stimulus} />
              )}
              <div className="question-body">
                <RichText source={opened.detail.served.question.stem} />
                <AnsweredOptions served={opened.detail.served} />
              </div>
              {opened.detail.served.debrief !== null && (
                <DebriefPanel
                  debrief={opened.detail.served.debrief}
                  response={opened.detail.served.response}
                  timed={opened.detail.timed}
                  parts={opened.detail.served.question.parts}
                  mistakes={opened.detail.served.mistakes}
                  onMistakeChanged={onChanged}
                  onFailure={onFailure}
                  questionId={opened.detail.served.question.id}
                />
              )}
              {opened.detail.entry.ladder !== null && opened.detail.entry.ladder.steps.length > 0 && (
                <>
                  <h3 className="history-title">Retries</h3>
                  <ul className="error-history">
                    {opened.detail.entry.ladder.steps.map((step, index) => (
                      <li key={index}>
                        Step {step.step}, {calendarDay(step.on)}: {outcomeText[step.outcome]}
                        {step.note === null ? "" : `. ${step.note}`}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <h3 className="history-title">Every answer you gave it</h3>
              <ul className="error-history">
                {opened.detail.history.map((item, index) => (
                  <li key={index}>{historyText(item, opened.detail.served.question, timeZone)}</li>
                ))}
              </ul>
            </>
          )}
      </div>
    </li>
  )
}
