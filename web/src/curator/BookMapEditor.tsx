import { type FormEvent, useId, useRef, useState } from "react"
import { mapProblems, setsWithoutKeys } from "../../../src/api/bookMapRules.ts"
import {
  type BookDetail,
  bookFilePath,
  type MapRangeInput,
  type MapRole,
  MapRoleLabels,
  MapRoles,
  type TypeGroup,
  TypeGroupLabels,
  TypeGroups,
  TypeGroupSections
} from "../../../src/api/Books.ts"
import { call } from "../api.ts"
import { dayAndTime } from "../format.ts"
import { pageRuns } from "./bookText.ts"

// The Book Map on one screen: each range of pages, what it holds and which
// set it belongs to. The Curator corrects the proposal and confirms it; each
// confirmation is a new version.

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
  const ids = { title: useId(), sets: useId(), problems: useId() }
  const book = detail.book
  const pageCount = book.pageCount ?? 0
  const base = detail.confirmed?.ranges ?? detail.proposal?.ranges ?? []
  const [rows, setRows] = useState<ReadonlyArray<Row>>(() => base.map(rowOf))
  const [tried, setTried] = useState(false)
  const [serverProblems, setServerProblems] = useState<ReadonlyArray<string>>([])
  const [saved, setSaved] = useState("")
  // Extraction spends from the full run's cap; a Book mapped by hand before
  // any run needs one here.
  const needsCap = book.runCap === null
  const [cap, setCap] = useState(() =>
    String(book.preview === null ? 1 : Math.max(0.1, Math.ceil(book.preview.projectedCost * 1.5 * 100) / 100))
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

  const change = (key: number, patch: Partial<Row>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
    setServerProblems([])
    setSaved("")
  }
  const remove = (key: number) => {
    setRows((current) => current.filter((row) => row.key !== key))
    setSaved("")
  }
  const add = () => {
    const last = rows.at(-1)
    setRows((current) => [
      ...current,
      {
        key: nextKey++,
        role: "questions",
        group: last?.group ?? "ps",
        set: last?.set ?? "",
        firstPage: "",
        lastPage: ""
      }
    ])
    setSaved("")
  }
  const reset = (ranges: ReadonlyArray<MapRangeInput>) => {
    setRows(ranges.map(rowOf))
    setTried(false)
    setServerProblems([])
    setSaved("")
  }

  const confirm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setTried(true)
    setServerProblems([])
    const spendCap = Number(cap)
    const capProblem = needsCap && (!Number.isFinite(spendCap) || spendCap <= 0 || spendCap > 10_000)
      ? ["Enter a spend cap in dollars, above 0."]
      : []
    if (capProblem.length > 0) return setServerProblems(capProblem)
    if (problems.length > 0 || busy.current) return
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
        setSaved(`Version ${confirmed.version} confirmed; extraction started.`)
      }
      onConfirmed(result.success)
      return
    }
    switch (result.failure._tag) {
      case "BookMapInvalid":
        return setServerProblems(result.failure.problems)
      case "BookNotReady":
        return setServerProblems(["The book changed in the meantime; reload the page."])
      case "RunCapNeeded":
        return setServerProblems(["Enter a spend cap for extraction."])
      default:
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
      <h2 id={ids.title}>Book Map</h2>
      <p className="group-about">
        Each range tells extraction where to look. Ranges with the same set name belong together: questions, their
        answer key, their explanations and their difficulty labels.
      </p>
      <p className="map-source">{source}</p>
      <form noValidate onSubmit={(event) => void confirm(event)}>
        <datalist id={ids.sets}>
          {setNames.map((name) => <option key={name} value={name} />)}
        </datalist>
        {rows.length === 0
          ? <p className="empty">No ranges yet. Add the first one below.</p>
          : (
            <table className="ranges">
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
          <button type="button" className="button button-quiet" onClick={add}>Add a range</button>
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
          <div className="map-problems" role="alert" id={ids.problems}>
            <p className="problem">Fix these before confirming:</p>
            <ul>
              {shownProblems.map((problem) => <li key={problem}>{problem}</li>)}
            </ul>
          </div>
        )}
        <p className="map-hint">
          Confirming starts extracting the Problem Solving Questions into the Review Queue. A page read before is not
          read again, so fixing the Book Map later costs little.
        </p>
        {needsCap && (
          <div className="field cap-field confirm-cap">
            <label htmlFor={`${ids.title}-cap`}>Spend cap for extraction, in dollars</label>
            <input
              id={`${ids.title}-cap`}
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
            <button type="button" className="button button-quiet" onClick={() => reset(detail.proposal!.ranges)}>
              Start from the proposal
            </button>
          )}
          <button type="button" className="button button-quiet" onClick={() => reset(base)}>Undo changes</button>
          <p className="saved" role="status">{saved}</p>
        </div>
      </form>
    </section>
  )
}
