import { useCallback, useEffect, useId, useRef, useState } from "react"
import type { MockOptions, MockSummary } from "../../../src/api/Mocks.ts"
import type { PaperMarkView } from "../../../src/api/PaperMarks.ts"
import type { PracticeOptions } from "../../../src/api/Practice.ts"
import type { BookId } from "../../../src/api/Books.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { dayAndTime } from "../format.ts"
import { linkProps, navigate } from "../router.ts"

// Mocks: the whole exam, in the order the Learner picks. Below, the Books
// done on paper, whose Questions Mocks hold back until unseen ones run out.

interface Props {
  readonly onSessionLost: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const orders = (ids: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> =>
  ids.length <= 1 ? [ids] : ids.flatMap((id) => orders(ids.filter((other) => other !== id)).map((rest) => [id, ...rest]))

export const MocksHome = ({ onSessionLost, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const [options, setOptions] = useState<MockOptions>()
  const [done, setDone] = useState<ReadonlyArray<MockSummary>>()
  const [order, setOrder] = useState<ReadonlyArray<string>>()
  const [problem, setProblem] = useState<string>()
  const busy = useRef(false)
  const mounted = useRef(true)

  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "NotUnlocked" ? onSessionLost() : onStopped(failure)),
    [onSessionLost, onStopped]
  )

  const load = useCallback(async () => {
    const [read, listed] = await Promise.all([call((client) => client.mocks.options()), call((client) => client.mocks.list())])
    if (!mounted.current) return
    if (read._tag === "Failure") return handle(read.failure)
    if (listed._tag === "Failure") return handle(listed.failure)
    setOptions(read.success)
    setDone(listed.success.filter((each) => each.finished))
  }, [handle])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
    }
  }, [load])

  const names = new Map(options?.sections.map((each) => [each.section.id, each.section.name] as const) ?? [])
  const choices = orders(options?.sections.map((each) => each.section.id) ?? [])
  const chosen = order ?? choices[0]

  const start = async () => {
    if (busy.current || chosen === undefined) return
    busy.current = true
    setProblem(undefined)
    const result = await call((client) => client.mocks.start({ payload: { order: [...chosen] } }))
    busy.current = false
    if (result._tag === "Success") return navigate(`/mocks/${result.success.id}`)
    switch (result.failure._tag) {
      case "MockRunning":
        return navigate(`/mocks/${result.failure.id}`)
      case "SectionalRunning":
        return navigate(`/sectionals/${result.failure.id}`)
      case "MockReserveTooSmall":
        setProblem("Too few unseen Questions are held for Mocks now. The list above says what is missing.")
        return void load()
      case "MockOrderInvalid":
        return setProblem(result.failure.problems.join(" "))
      default:
        return handle(result.failure)
    }
  }

  const running = options?.running ?? null
  const sectional = options?.sectional ?? null
  const short = options?.sections.filter((each) => !each.ready) ?? []
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>Mocks</h1>
      <p className="lede">
        The whole exam: Quantitative Reasoning, Verbal Reasoning and Data Insights, 45 minutes each, in the order you
        choose, with one optional 10-minute break after the first or second Section.
      </p>
      {running !== null && (
        <section className="group" aria-labelledby="mock-running">
          <h2 id="mock-running">In progress</h2>
          <p>
            <a className="set-name" {...linkProps(`/mocks/${running}`)}>Go back to your Mock</a>
          </p>
          <p className="hint">Its clocks keep running while you are away, and the next Section starts when a break ends.</p>
        </section>
      )}
      <section className="group" aria-labelledby="mock-start">
        <h2 id="mock-start">Start a Mock</h2>
        {options === undefined ? <p className="quiet" aria-busy="true">Checking what each Section holds</p> : (
          <>
            {short.length > 0 && (
              <div className="section-short">
                <p>
                  Not enough unseen Questions are held for Mocks yet. Each group needs twice what a Section asks of it:
                </p>
                <ul>
                  {short.flatMap((section) =>
                    section.groups.filter((group) => group.unseen < group.needed).map((group) => (
                      <li key={`${section.section.id}-${group.group.id}`}>
                        {section.section.name}, {group.group.name}: {group.unseen} of the {group.needed} needed
                      </li>
                    ))
                  )}
                </ul>
                <p className="hint">
                  The app holds back a quarter of each Book's Questions, and of each batch the Curator generates, so more
                  Books add more.
                </p>
              </div>
            )}
            {sectional !== null && (
              <p className="hint">
                Your Sectional is still running. <a {...linkProps(`/sectionals/${sectional}`)}>Finish it</a> to start a
                Mock.
              </p>
            )}
            <fieldset className="inline-field mock-order">
              <legend>Order of the Sections</legend>
              <div className="order-choices">
                {choices.map((each) => {
                  const key = each.join(",")
                  return (
                    <label key={key} className="inline-choice">
                      <input
                        type="radio"
                        name="mock-order"
                        checked={chosen?.join(",") === key}
                        onChange={() => setOrder(each)}
                      />
                      {each.map((id) => names.get(id) ?? id).join(", then ")}
                    </label>
                  )
                })}
              </div>
            </fieldset>
            <div className="actions">
              <button
                type="button"
                className="button"
                disabled={!options.ready || running !== null || sectional !== null}
                onClick={() => void start()}
              >
                Start the Mock
              </button>
            </div>
          </>
        )}
        {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
      </section>
      {done !== undefined && done.length > 0 && (
        <section className="group" aria-labelledby="mock-done">
          <h2 id="mock-done">Finished Mocks</h2>
          <ul className="set-list">
            {done.map((each) => (
              <li key={each.id}>
                <a className="set-name" {...linkProps(`/mocks/${each.id}`)}>
                  {each.total === null
                    ? "No Total"
                    : `${each.total.score}, likely ${each.total.low} to ${each.total.high}${
                      each.total.calibrated ? "" : ", not yet calibrated"
                    }`}
                </a>
                <span className="set-facts">
                  {each.order.map((section) => section.name).join(", ")}, {dayAndTime(each.finishedAt ?? each.createdAt)}
                  {each.rescored ? ", rescored" : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <PaperMarks onFailure={handle} onChanged={() => void load()} />
    </>
  )
}

// Books, or pages of them, the Learner worked on paper.
// A mark changes which Questions are unseen, so the start check is read again.
const PaperMarks = (
  { onFailure, onChanged }: {
    readonly onFailure: (failure: { readonly _tag: string }) => void
    readonly onChanged: () => void
  }
) => {
  const ids = { book: useId(), from: useId(), to: useId(), pagesHint: useId() }
  const [marks, setMarks] = useState<ReadonlyArray<PaperMarkView>>()
  const [books, setBooks] = useState<PracticeOptions["books"]>()
  const [bookId, setBookId] = useState("")
  const [whole, setWhole] = useState(true)
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [problem, setProblem] = useState<string>()
  const busy = useRef(false)

  useEffect(() => {
    void Promise.all([call((client) => client.paperMarks.list()), call((client) => client.practice.options())]).then(
      ([listed, read]) => {
        if (listed._tag === "Failure") return onFailure(listed.failure)
        if (read._tag === "Failure") return onFailure(read.failure)
        setMarks(listed.success)
        setBooks(read.success.books)
        setBookId((current) => current === "" ? read.success.books[0]?.id ?? "" : current)
      }
    )
  }, [onFailure])

  const page = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined)

  const add = async () => {
    if (busy.current || bookId === "") return
    const firstPage = whole ? null : page(from)
    const lastPage = whole ? null : page(to)
    if (firstPage === undefined || lastPage === undefined) return setProblem("Give the first and last page as numbers.")
    busy.current = true
    setProblem(undefined)
    const result = await call((client) =>
      client.paperMarks.add({ payload: { bookId: bookId as BookId, firstPage, lastPage } })
    )
    busy.current = false
    if (result._tag === "Success") {
      setMarks(result.success)
      setFrom("")
      setTo("")
      return onChanged()
    }
    switch (result.failure._tag) {
      case "PaperMarkInvalid":
        return setProblem(result.failure.problems.join(" "))
      case "BookNotFound":
        return setProblem("That Book is no longer in the Question Bank.")
      default:
        return onFailure(result.failure)
    }
  }

  const remove = async (id: string) => {
    if (busy.current) return
    busy.current = true
    const result = await call((client) => client.paperMarks.remove({ params: { id } }))
    busy.current = false
    if (result._tag === "Success") {
      setMarks(result.success)
      return onChanged()
    }
    if (result.failure._tag === "PaperMarkNotFound") {
      const listed = await call((client) => client.paperMarks.list())
      if (listed._tag === "Success") setMarks(listed.success)
      return
    }
    onFailure(result.failure)
  }

  return (
    <section className="group" aria-labelledby="paper-title">
      <h2 id="paper-title">Done on paper</h2>
      <p className="group-about">
        Mark the Books, or the pages of them, you worked through on paper. Their Questions count as seen: Mocks and
        Sectionals serve them only when unseen ones run out, Practice Sets can use them, and they never move your Score
        Estimates.
      </p>
      {books === undefined || marks === undefined ? <p className="quiet" aria-busy="true">Reading your marks</p> : (
        <>
          {marks.length > 0 && (
            <ul className="set-list">
              {marks.map((mark) => (
                <li key={mark.id}>
                  <span className="set-name">
                    {mark.book.title}
                    {mark.firstPage === null ? ", the whole Book" : `, PDF pages ${mark.firstPage} to ${mark.lastPage}`}
                  </span>
                  <span className="set-facts">{plural(mark.questions, "Question", "Questions")}</span>
                  <button
                    type="button"
                    className="link-button"
                    aria-label={`Remove the mark on ${mark.book.title}${
                      mark.firstPage === null ? "" : `, PDF pages ${mark.firstPage} to ${mark.lastPage}`
                    }`}
                    onClick={() => void remove(mark.id)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {books.length === 0 ? <p className="hint">No Book has Questions in the Question Bank yet.</p> : (
            <div className="practice-fields">
              <div className="field">
                <label htmlFor={ids.book}>Book</label>
                <select id={ids.book} value={bookId} onChange={(event) => setBookId(event.target.value)}>
                  {books.map((book) => <option key={book.id} value={book.id}>{book.title}</option>)}
                </select>
              </div>
              <fieldset className="inline-field">
                <legend>Which pages</legend>
                <div className="inline-choices">
                  <label className="inline-choice">
                    <input type="radio" name="paper-pages" checked={whole} onChange={() => setWhole(true)} />
                    The whole Book
                  </label>
                  <label className="inline-choice">
                    <input type="radio" name="paper-pages" checked={!whole} onChange={() => setWhole(false)} />
                    A page range
                  </label>
                </div>
              </fieldset>
              {!whole && (
                <div className="item-range">
                  <div className="field">
                    <label htmlFor={ids.from}>From PDF page</label>
                    <input
                      id={ids.from}
                      aria-describedby={ids.pagesHint}
                      className="number-input"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={from}
                      onChange={(event) => setFrom(event.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={ids.to}>To PDF page</label>
                    <input
                      id={ids.to}
                      aria-describedby={ids.pagesHint}
                      className="number-input"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={to}
                      onChange={(event) => setTo(event.target.value)}
                    />
                  </div>
                  <p id={ids.pagesHint} className="hint">
                    The page numbers of the PDF file, counted from its first page, which can differ from those printed on
                    the pages.
                  </p>
                </div>
              )}
              <div className="actions">
                <button type="button" className="button button-quiet" onClick={() => void add()}>
                  Mark as done on paper
                </button>
              </div>
            </div>
          )}
          {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
        </>
      )}
    </section>
  )
}
