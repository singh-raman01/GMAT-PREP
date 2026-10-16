import { useCallback, useEffect, useId, useRef, useState } from "react"
import type { ErrorLogDetail, ErrorLogEntry, ErrorLogFilters, ErrorLogView } from "../../../src/api/ErrorLog.ts"
import { bandNames } from "../../../src/api/difficulty.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { dayAndTime, spokenDuration } from "../format.ts"
import { DebriefPanel } from "../practice/DebriefPanel.tsx"
import { AnsweredOptions } from "../practice/PracticeSet.tsx"
import { RichText } from "../RichText.tsx"
import { StimulusDetails } from "../stimulus/StimulusPane.tsx"

// The Error Log: every Question answered wrong, slowly or by a guess, one
// entry each, the latest first, with filters for every way to slice it.

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
  ["mistakeType", "What went wrong", "mistakeTypes"],
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
  return entry.reasons.map((reason) => (reason === "slow" ? "Slow" : "Guessed")).join(" and ")
}

const historyText = (item: ErrorLogDetail["history"][number]) => {
  const where = item.sessionKind === "practice" ? "Practice Set" : item.sessionKind === "sectional" ? "Sectional" : "Mock"
  const answer = item.kind === "time-out"
    ? "time ran out"
    : item.selection.map((choice) => choice.choice).join(", ") || "no answer"
  const result = item.correct === null ? "" : item.correct ? ", right" : ", wrong"
  const change = item.kind === "edit" ? ", changed in Review & Edit" : ""
  const time = item.kind === "first" ? `, ${spokenDuration(item.timeSpentMs)}` : ""
  return `${dayAndTime(item.at)}, ${where}: ${answer}${result}${change}${time}${item.guessed ? ", marked as a guess" : ""}`
}

export const ErrorLogPage = ({ onSessionLost, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const ids = { from: useId(), to: useId(), base: useId() }
  const [filters, setFilters] = useState<Filters>({})
  const [log, setLog] = useState<ErrorLogView>()
  const [open, setOpen] = useState<string>()
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
      setLog(result.success)
    })
  }, [filters, handle])

  const set = (key: keyof Filters, value: string) =>
    setFilters((current) => {
      const next = { ...current }
      if (value === "") delete next[key]
      else (next as Record<string, string>)[key] = value
      return next
    })

  const filtered = Object.keys(filters).length > 0
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>Error Log</h1>
      <p className="lede">
        Every Question you answered wrong, slowly or by a guess, one entry each with every answer you gave it. Say what
        went wrong in each one: the label decides what you practise next.
      </p>
      {log === undefined ? <p className="quiet" aria-busy="true">Reading your Error Log</p> : log.total === 0
        ? <p className="empty">Nothing yet. Questions you miss in Practice Sets, Sectionals and Mocks come here.</p>
        : (
          <>
            <section className="group error-filters" aria-labelledby={`${ids.base}-filters`}>
              <h2 id={`${ids.base}-filters`} className="visually-hidden">Filters</h2>
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
                <div className="field">
                  <label htmlFor={ids.from}>Missed from</label>
                  <input id={ids.from} type="date" value={filters.from ?? ""} onChange={(event) => set("from", event.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor={ids.to}>Missed to</label>
                  <input id={ids.to} type="date" value={filters.to ?? ""} onChange={(event) => set("to", event.target.value)} />
                </div>
              </div>
              <p className="filter-count" role="status">
                {filtered ? `${log.entries.length} of ${plural(log.total, "entry", "entries")}` : plural(log.total, "entry", "entries")}
                {filtered && (
                  <>
                    {" "}
                    <button type="button" className="link-button" onClick={() => setFilters({})}>Clear the filters</button>
                  </>
                )}
              </p>
            </section>
            <ol className="error-list">
              {log.entries.map((entry) => (
                <EntryRow
                  key={entry.questionId}
                  entry={entry}
                  open={open === entry.questionId}
                  onToggle={() => setOpen((current) => (current === entry.questionId ? undefined : entry.questionId))}
                  onFailure={handle}
                />
              ))}
            </ol>
          </>
        )}
    </>
  )
}

const EntryRow = (
  { entry, open, onToggle, onFailure }: {
    readonly entry: ErrorLogEntry
    readonly open: boolean
    readonly onToggle: () => void
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const panel = useId()
  const [detail, setDetail] = useState<ErrorLogDetail>()
  useEffect(() => {
    if (!open) return
    void call((client) => client.errorLog.get({ params: { questionId: entry.questionId } })).then((result) => {
      if (result._tag === "Success") return setDetail(result.success)
      onFailure(result.failure)
    })
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
      <div className="error-stem">
        <RichText source={entry.stem} />
      </div>
      <p className="set-facts">
        {whyText(entry)}. {entry.misses === 1 ? "Missed once" : `Missed ${entry.misses} times`}, last{" "}
        {dayAndTime(entry.lastMissedAt)}
        {entry.books.length === 0 ? "" : `, from ${entry.books.map((book) => book.name).join(" and ")}`}
        {entry.status === "withdrawn" ? ". Withdrawn from the Question Bank, so this entry is closed" : ""}.
      </p>
      {open && (
        <div id={panel} className="error-detail">
          {detail === undefined ? <p className="quiet" aria-busy="true">Opening the entry</p> : (
            <>
              {detail.served.question.stimulus !== null && <StimulusDetails stimulus={detail.served.question.stimulus} />}
              <div className="question-body">
                <RichText source={detail.served.question.stem} />
                <AnsweredOptions served={detail.served} />
              </div>
              {detail.served.debrief !== null && (
                <DebriefPanel
                  debrief={detail.served.debrief}
                  response={detail.served.response}
                  timed={detail.timed}
                  parts={detail.served.question.parts}
                  mistakes={detail.served.mistakes}
                />
              )}
              <h3 className="history-title">Every answer you gave it</h3>
              <ul className="error-history">
                {detail.history.map((item, index) => <li key={index}>{historyText(item)}</li>)}
              </ul>
            </>
          )}
        </div>
      )}
    </li>
  )
}
