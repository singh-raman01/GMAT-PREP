import { type FormEvent, useEffect, useId, useRef, useState } from "react"
import { mapProblems, setsWithoutKeys } from "../../../src/api/bookMapRules.ts"
import {
  type BookDetail,
  bookFilePath,
  ExtractedGroups,
  type MapRangeInput,
  type MapRole,
  MapRoleLabels,
  MapRoles,
  type TypeGroup,
  TypeGroupLabels,
  TypeGroups,
  TypeGroupSections
} from "../../../src/api/Books.ts"
import { formatDollars } from "../../../src/api/money.ts"
import { call, refusedStatus } from "../api.ts"
import { dayAndTime } from "../format.ts"
import { pageRuns } from "./bookText.ts"

// The Book Map on one screen: each range of pages, what it holds and which
// set it belongs to. The Curator corrects the proposal and confirms it; each
// confirmation is a new version. A newer map that arrives while the Curator
// is editing waits to be loaded instead of replacing the edits.

interface Row {
  readonly key: number
  readonly role: MapRole
  readonly group: TypeGroup
  readonly set: string
  // As typed.
  readonly firstPage: string
  readonly lastPage: string
}

let nextKey = 1
const rowOf = (range: MapRangeInput): Row => ({
  key: nextKey++,
  role: range.role,
  group: range.group,
  set: range.set,
  firstPage: String(range.firstPage),
  lastPage: String(range.lastPage)
})

// The map the rows start from: the latest confirmed version, else the
// latest proposal.
interface Source {
  readonly from: string
  readonly ranges: ReadonlyArray<MapRangeInput>
}

const latestOf = (detail: BookDetail): Source =>
  detail.confirmed !== null
    ? { from: `version-${detail.confirmed.version}`, ranges: detail.confirmed.ranges }
    : detail.proposal !== null
    ? { from: `proposal-${detail.proposal.createdAt}`, ranges: detail.proposal.ranges }
    : { from: "none", ranges: [] }

const pageNumber = (text: string) => (/^\s*\d{1,6}\s*$/.test(text) ? Number(text) : undefined)

// The rows as ranges, or the rows whose page numbers are not numbers.
const parse = (rows: ReadonlyArray<Row>) => {
  const ranges: Array<MapRangeInput> = []
  const unreadable: Array<number> = []
  rows.forEach((row, index) => {
    const firstPage = pageNumber(row.firstPage)
    const lastPage = pageNumber(row.lastPage)
    if (firstPage === undefined || lastPage === undefined || firstPage < 1 || lastPage < 1) {
      unreadable.push(index + 1)
      return
    }
    ranges.push({ role: row.role, group: row.group, set: row.set, firstPage, lastPage })
  })
  return { ranges, unreadable }
}

export const BookMapEditor = (
  { detail, onConfirmed, onFailure }: {
    readonly detail: BookDetail
    readonly onConfirmed: (detail: BookDetail) => void
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const ids = { title: useId(), sets: useId(), problems: useId(), add: useId() }
  const book = detail.book
  const pageCount = book.pageCount ?? 0
  const latest = latestOf(detail)
  const [rows, setRows] = useState<ReadonlyArray<Row>>(() => latest.ranges.map(rowOf))
  const [loadedFrom, setLoadedFrom] = useState(latest.from)
  const [proposalSeen, setProposalSeen] = useState(detail.proposal?.createdAt)
  // The Curator changed the rows since they were loaded or confirmed.
  const [edited, setEdited] = useState(false)
  // A newer map that arrived while the rows were edited.
  const [waiting, setWaiting] = useState<{ readonly text: string; readonly ranges: ReadonlyArray<MapRangeInput> }>()
  const [tried, setTried] = useState(false)
  const [serverProblems, setServerProblems] = useState<ReadonlyArray<string>>([])
  const [saved, setSaved] = useState("")
  const [focusTarget, setFocusTarget] = useState<string>()
  const heading = useRef<HTMLHeadingElement>(null)
  const table = useRef<HTMLTableElement>(null)
  // Extraction spends from the full run's cap. A Book mapped by hand before
  // any run needs one here, and so does a run that has spent its cap.
  const capSpent = book.runCap !== null && book.runSpent >= book.runCap
  const needsCap = book.runCap === null || capSpent
  const [cap, setCap] = useState(() =>
    String(
      book.runCap !== null
        ? Math.ceil(book.runCap * 2 * 100) / 100
        : book.preview === null
        ? 1
        : Math.max(0.1, Math.ceil(book.preview.projectedCost * 1.5 * 100) / 100)
    )
  )
  const busy = useRef(false)

  const { ranges, unreadable } = parse(rows)
  const problems = [
    ...unreadable.map((row) => `Range ${row}: enter the first and last page as numbers.`),
    ...mapProblems(ranges, pageCount)
  ]
  const shownProblems = tried ? (serverProblems.length > 0 ? serverProblems : problems) : []
  const unkeyed = setsWithoutKeys(ranges)
  const covered = new Set(ranges.flatMap((range) =>
    Array.from({ length: Math.max(0, Math.min(range.lastPage, pageCount) - range.firstPage + 1) }, (_, i) => range.firstPage + i)
  ))
  const uncovered = Array.from({ length: pageCount }, (_, i) => i + 1).filter((number) => !covered.has(number))
  const setNames = [...new Set(rows.map((row) => row.set.trim()).filter((name) => name !== ""))]
  // Question pages of groups extraction does not read yet.
  const notExtracted = [
    ...new Set(ranges.filter((range) => range.role === "questions" && range.group !== "sc" && !ExtractedGroups.has(range.group))
      .map((range) => TypeGroupLabels[range.group]))
  ]

  const setInputId = (key: number) => `${ids.title}-set-${key}`

  // Focus moves once the rows it names are on screen.
  useEffect(() => {
    if (focusTarget === undefined) return
    document.getElementById(focusTarget)?.focus()
    setFocusTarget(undefined)
  }, [focusTarget])

  const edit = () => {
    setEdited(true)
    setServerProblems([])
    setSaved("")
  }
  const change = (key: number, patch: Partial<Row>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
    edit()
  }
  const remove = (key: number) => {
    const index = rows.findIndex((row) => row.key === key)
    const next = rows[index + 1] ?? rows[index - 1]
    setRows((current) => current.filter((row) => row.key !== key))
    setFocusTarget(next === undefined ? ids.add : setInputId(next.key))
    edit()
  }
  const add = () => {
    const last = rows.at(-1)
    const key = nextKey++
    setRows((current) => [
      ...current,
      { key, role: "questions", group: last?.group ?? "ps", set: last?.set ?? "", firstPage: "", lastPage: "" }
    ])
    setFocusTarget(setInputId(key))
    edit()
  }
  // Replaces the rows. Focus inside the table would fall to the page, so it
  // moves to the heading.
  const load = (ranges: ReadonlyArray<MapRangeInput>, changed: boolean) => {
    if (table.current?.contains(document.activeElement) === true) heading.current?.focus()
    setRows(ranges.map(rowOf))
    setEdited(changed)
    setWaiting(undefined)
    setTried(false)
    setServerProblems([])
    setSaved("")
  }

  // A newer map: a proposal the run just made, or a version confirmed in
  // another tab. Unedited rows take it; edited ones keep the edits and offer it.
  useEffect(() => {
    const proposalChanged = detail.proposal !== null && detail.proposal.createdAt !== proposalSeen
    if (latest.from === loadedFrom && !proposalChanged) return
    setProposalSeen(detail.proposal?.createdAt)
    if (latest.from !== loadedFrom) {
      setLoadedFrom(latest.from)
      if (!edited) return load(latest.ranges, false)
      return setWaiting({
        text: detail.confirmed !== null
          ? `Version ${detail.confirmed.version} was confirmed elsewhere.`
          : "The Book Map model proposed a map.",
        ranges: latest.ranges
      })
    }
    if (detail.proposal !== null) {
      setWaiting({ text: "The Book Map model proposed a new map.", ranges: detail.proposal.ranges })
    }
  }, [latest.from, detail.proposal?.createdAt])

  // Problems go in a box that takes focus once, when confirming fails, so it
  // is read out then and not again on each keystroke.
  const showProblems = (found: ReadonlyArray<string>) => {
    setServerProblems(found)
    setFocusTarget(ids.problems)
  }

  const confirm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setTried(true)
    setServerProblems([])
    const spendCap = Number(cap)
    const capProblem = !needsCap
      ? []
      : !Number.isFinite(spendCap) || spendCap <= 0 || spendCap > 10_000
      ? ["Enter a spend cap in dollars, above 0."]
      : capSpent && spendCap <= book.runSpent
      ? [`Enter a cap above the ${formatDollars(book.runSpent)} the run already spent.`]
      : []
    if (capProblem.length > 0) return showProblems(capProblem)
    if (problems.length > 0) return setFocusTarget(ids.problems)
    if (busy.current) return
    busy.current = true
    const result = await call((client) =>
      client.books.confirmMap({
        params: { id: book.id },
        payload: needsCap ? { ranges, spendCap } : { ranges }
      })
    )
    busy.current = false
    if (result._tag === "Success") {
      const confirmed = result.success.confirmed
      setTried(false)
      if (confirmed !== null) {
        setRows(confirmed.ranges.map(rowOf))
        setLoadedFrom(`version-${confirmed.version}`)
        setEdited(false)
        setWaiting(undefined)
        setSaved(`Version ${confirmed.version} confirmed; extraction started.`)
      }
      onConfirmed(result.success)
      return
    }
    switch (result.failure._tag) {
      case "BookMapInvalid":
        return showProblems(result.failure.problems)
      case "BookNotReady":
        return showProblems(["The book changed in the meantime; reload the page."])
      case "RunCapNeeded":
        return showProblems(["Enter a spend cap for extraction."])
      default:
        // A map the API's checks refuse, which the checks here should have
        // caught first.
        if (refusedStatus(result.failure) === 400) {
          return showProblems(["The app could not accept this Book Map. Check each set name and page number."])
        }
        return onFailure(result.failure)
    }
  }

  const source = detail.confirmed !== null
    ? `Version ${detail.confirmed.version}, confirmed ${dayAndTime(detail.confirmed.confirmedAt)}.`
    : detail.proposal !== null
    ? `Proposed by ${detail.proposal.model || "the Book Map model"} on ${dayAndTime(detail.proposal.createdAt)}; not confirmed yet.`
    : "No proposal yet: enter the ranges yourself."

  return (
    <section className="group book-map" aria-labelledby={ids.title}>
      <h2 id={ids.title} ref={heading} tabIndex={-1}>Book Map</h2>
      <p className="group-about">
        Each range tells extraction where to look. Ranges with the same set name belong together: questions, their
        answer key, their explanations and their difficulty labels.
      </p>
      <p className="map-source">{source}</p>
      {waiting !== undefined && (
        <div className="map-waiting" role="status">
          <p>{waiting.text} Your changes are kept until you load it.</p>
          <div className="actions">
            <button type="button" className="button button-quiet" onClick={() => load(waiting.ranges, false)}>
              Load it
            </button>
            <button type="button" className="button button-quiet" onClick={() => setWaiting(undefined)}>
              Keep my changes
            </button>
          </div>
        </div>
      )}
      <form noValidate onSubmit={(event) => void confirm(event)}>
        <datalist id={ids.sets}>
          {setNames.map((name) => <option key={name} value={name} />)}
        </datalist>
        {rows.length === 0
          ? <p className="empty">No ranges yet. Add the first one below.</p>
          : (
            <table className="ranges" ref={table}>
              <thead>
                <tr>
                  <th scope="col">Set</th>
                  <th scope="col">Holds</th>
                  <th scope="col">Questions</th>
                  <th scope="col">First page</th>
                  <th scope="col">Last page</th>
                  <th scope="col"><span className="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const label = `range ${index + 1}`
                  const first = pageNumber(row.firstPage)
                  return (
                    <tr key={row.key}>
                      <td data-label="Set">
                        <input
                          id={setInputId(row.key)}
                          type="text"
                          list={ids.sets}
                          autoComplete="off"
                          aria-label={`Set, ${label}`}
                          value={row.set}
                          onChange={(event) => change(row.key, { set: event.target.value })}
                        />
                      </td>
                      <td data-label="Holds">
                        <select
                          aria-label={`Holds, ${label}`}
                          value={row.role}
                          onChange={(event) => change(row.key, { role: event.target.value as MapRole })}
                        >
                          {MapRoles.map((role) => <option key={role} value={role}>{MapRoleLabels[role]}</option>)}
                        </select>
                      </td>
                      <td data-label="Questions">
                        <span className="group-pick" data-section={TypeGroupSections[row.group] ?? undefined}>
                          <span className="swatch" aria-hidden="true" />
                          <select
                            aria-label={`Questions, ${label}`}
                            value={row.group}
                            onChange={(event) => change(row.key, { group: event.target.value as TypeGroup })}
                          >
                            {TypeGroups.map((group) => <option key={group} value={group}>{TypeGroupLabels[group]}</option>)}
                          </select>
                        </span>
                      </td>
                      <td data-label="First page">
                        <input
                          type="text"
                          inputMode="numeric"
                          autoComplete="off"
                          className="page-input"
                          aria-label={`First page, ${label}`}
                          value={row.firstPage}
                          onChange={(event) => change(row.key, { firstPage: event.target.value })}
                        />
                      </td>
                      <td data-label="Last page">
                        <input
                          type="text"
                          inputMode="numeric"
                          autoComplete="off"
                          className="page-input"
                          aria-label={`Last page, ${label}`}
                          value={row.lastPage}
                          onChange={(event) => change(row.key, { lastPage: event.target.value })}
                        />
                      </td>
                      <td className="row-actions">
                        {first !== undefined && first <= pageCount && (
                          <a href={`${bookFilePath(book.id)}#page=${first}`} target="_blank" rel="noopener">
                            Open page {first}
                          </a>
                        )}
                        <button
                          type="button"
                          className="link-button"
                          aria-label={`Remove ${label}`}
                          onClick={() => remove(row.key)}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        <div className="actions">
          <button id={ids.add} type="button" className="button button-quiet" onClick={add}>Add a range</button>
        </div>
        {rows.length > 0 && uncovered.length > 0 && (
          <p className="hint map-hint">
            Not in any range: {uncovered.length === 1 ? "page" : "pages"} {pageRuns(uncovered)}. Extraction skips{" "}
            {uncovered.length === 1 ? "it" : "them"}.
          </p>
        )}
        {unkeyed.length > 0 && (
          <p className="hint map-hint">
            {unkeyed.length === 1
              ? `The set ${unkeyed[0]} has no answer key. Its Questions`
              : `The sets ${unkeyed.join(", ")} have no answer key. Their Questions`} will be held in the Review Queue
            until a key is mapped.
          </p>
        )}
        {shownProblems.length > 0 && (
          <div className="map-problems" id={ids.problems} tabIndex={-1}>
            <p className="problem">Fix these before confirming:</p>
            <ul>
              {shownProblems.map((problem) => <li key={problem}>{problem}</li>)}
            </ul>
          </div>
        )}
        {notExtracted.length > 0 && (
          <p className="hint map-hint">
            Questions in {notExtracted.join(", ")} ranges are not extracted yet; their answer keys and explanations are
            still read.{notExtracted.includes(TypeGroupLabels.mixed)
              ? " Give each run of mixed pages the type of the questions it holds to extract them."
              : ""}
          </p>
        )}
        <p className="map-hint">
          Confirming starts extracting the Questions: each is checked and published, or held in the Review Queue. A
          page read before is not read again, so fixing the Book Map later costs little.
        </p>
        {needsCap && (
          <div className="field cap-field confirm-cap">
            <label htmlFor={`${ids.title}-cap`}>
              {capSpent ? "Spend cap for the whole run, in dollars" : "Spend cap for extraction, in dollars"}
            </label>
            {capSpent && (
              <p id={`${ids.title}-cap-hint`} className="hint">
                The run has spent its cap of {formatDollars(book.runCap!)}. A new cap covers what it spent too.
              </p>
            )}
            <input
              id={`${ids.title}-cap`}
              aria-describedby={capSpent ? `${ids.title}-cap-hint` : undefined}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={cap}
              onChange={(event) => setCap(event.target.value)}
            />
          </div>
        )}
        <div className="actions confirm-actions">
          <button type="submit" className="button">Confirm Book Map</button>
          {detail.confirmed !== null && detail.proposal !== null && (
            <button type="button" className="button button-quiet" onClick={() => load(detail.proposal!.ranges, true)}>
              Start from the proposal
            </button>
          )}
          <button type="button" className="button button-quiet" onClick={() => load(latest.ranges, false)}>
            Undo changes
          </button>
          <p className="saved" role="status">{saved}</p>
        </div>
      </form>
    </section>
  )
}
