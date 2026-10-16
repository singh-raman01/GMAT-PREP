import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react"
import { type BookDetail, bookFilePath, BookId, type BookView, type CostPreview } from "../../../src/api/Books.ts"
import { formatDollars } from "../../../src/api/money.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { dayAndTime } from "../format.ts"
import { linkProps } from "../router.ts"
import { BookMapEditor } from "./BookMapEditor.tsx"
import { bookStatusText, fileSize, pageCountText, pageRuns } from "./bookText.ts"
import { afterStreamClosed, useJobEvents } from "./jobEvents.ts"

interface Props {
  readonly id: string
  readonly notice: string | undefined
  readonly onLocked: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

const tokens = (count: number) => count.toLocaleString("en-US")

export const BookPage = ({ id, notice, onLocked, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const [detail, setDetail] = useState<BookDetail>()
  const [missing, setMissing] = useState(false)
  const [since, setSince] = useState<number | "now">()
  const mounted = useRef(true)

  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "CuratorNotUnlocked" ? onLocked() : onStopped(failure)),
    [onLocked, onStopped]
  )

  const load = useCallback(async (first: boolean) => {
    const result = await call((client) => client.books.get({ params: { id: BookId.make(id) } }))
    if (!mounted.current) return
    if (result._tag === "Failure") {
      return result.failure._tag === "BookNotFound" ? setMissing(true) : handle(result.failure)
    }
    setDetail(result.success)
    if (first) setSince(result.success.book.job?.revision ?? "now")
  }, [handle, id])

  useEffect(() => {
    mounted.current = true
    void load(true)
    return () => {
      mounted.current = false
    }
  }, [load])

  // The Book moves on as its job runs.
  useJobEvents(
    since,
    (job) => {
      if (job.id === detail?.book.job?.id) void load(false)
    },
    () =>
      void afterStreamClosed(() => {
        setSince(undefined)
        return load(true)
      }, onLocked, () => mounted.current)
  )

  const allBooks = <p className="back"><a className="quiet-link" {...linkProps("/curator")}>All books</a></p>

  if (missing) {
    return (
      <>
        {allBooks}
        <h1 ref={heading} tabIndex={-1}>No such book</h1>
        <p className="lede">This book is not on this install. It may have been added on another one.</p>
      </>
    )
  }
  if (detail === undefined) {
    return (
      <>
        {allBooks}
        <h1 ref={heading} tabIndex={-1}>Book</h1>
        <p className="quiet" aria-busy="true">Loading the book</p>
      </>
    )
  }

  const book = detail.book
  const replace = (next: BookView) => setDetail((current) => (current === undefined ? current : { ...current, book: next }))
  const editable = book.status === "map-proposed" || book.status === "mapped" || detail.proposal !== null ||
    detail.confirmed !== null

  return (
    <>
      {allBooks}
      <h1 ref={heading} tabIndex={-1}>{book.title}</h1>
      {notice !== undefined && <p className="notice" role="status">{notice}</p>}
      <p className="book-facts">
        {[
          book.edition,
          book.official ? "Official GMAC material" : undefined,
          pageCountText(book),
          fileSize(book.fileSize),
          `added ${dayAndTime(book.createdAt)}`
        ].filter((part) => part !== undefined && part !== "").join(", ")}
        {". "}
        <a href={bookFilePath(book.id)} target="_blank" rel="noopener">Open the PDF</a>
      </p>

      <BookProgress book={book} onChanged={replace} onFailure={handle} />
      {book.status === "previewed" && book.preview !== null && (
        <Preview book={book} preview={book.preview} onStarted={replace} onFailure={handle} />
      )}
      {book.status === "mapping" && book.job?.status === "cancelled" && book.preview !== null && (
        <Preview book={book} preview={book.preview} onStarted={replace} onFailure={handle} again />
      )}
      {editable
        ? (
          <BookMapEditor
            key={detail.proposal?.createdAt ?? 0}
            detail={detail}
            onConfirmed={setDetail}
            onFailure={handle}
          />
        )
        : (book.status === "previewed" || book.status === "mapping") && (
          <ManualMap detail={detail} onConfirmed={setDetail} onFailure={handle} />
        )}
    </>
  )
}

// What the Book is doing now, and what to do when its job stopped.
const BookProgress = (
  { book, onChanged, onFailure }: {
    readonly book: BookView
    readonly onChanged: (book: BookView) => void
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const [problem, setProblem] = useState<string>()
  const job = book.job
  const working = job !== null && (job.status === "queued" || job.status === "running")
  const progress = job !== null && job.status === "running" && job.stepsTotal !== null && job.stepsTotal > 1
    ? Math.min(1, job.stepsDone / job.stepsTotal)
    : undefined
  const canReadAgain = (book.status === "added" || book.status === "unreadable") &&
    (job === null || job.status === "failed" || job.status === "cancelled")

  const readAgain = async () => {
    const result = await call((client) => client.books.readAgain({ params: { id: book.id } }))
    if (result._tag === "Success") return onChanged(result.success)
    if (result.failure._tag === "BookNotReady") return setProblem("The book changed in the meantime; reload the page.")
    onFailure(result.failure)
  }

  return (
    <section className="book-progress" aria-live="polite">
      <p className="book-status">{bookStatusText(book)}</p>
      {working && job?.note !== null && job?.note !== undefined && <p className="job-note">{job.note}</p>}
      {progress !== undefined && (
        <div
          className="progress"
          role="progressbar"
          aria-label="Progress"
          aria-valuemin={0}
          aria-valuemax={job?.stepsTotal ?? 0}
          aria-valuenow={job?.stepsDone ?? 0}
        >
          <div className="progress-done" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      {book.status === "unreadable" && book.note !== null && <p className="problem">{book.note}</p>}
      {job !== null && book.status !== "unreadable" && (job.status === "paused" || job.status === "failed") && (
        <p className={job.status === "failed" ? "problem" : "job-note"}>
          {job.note} <a {...linkProps("/curator/jobs")}>Manage the job in Jobs</a>.
        </p>
      )}
      {canReadAgain && (
        <div className="actions">
          <button type="button" className="button button-quiet" onClick={() => void readAgain()}>
            Read the book again
          </button>
        </div>
      )}
      {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
    </section>
  )
}

// A cap with room above the projection, as the default.
const suggestedCap = (preview: CostPreview) => Math.max(0.1, Math.ceil(preview.projectedCost * 1.5 * 100) / 100)

const Preview = (
  { book, preview, onStarted, onFailure, again = false }: {
    readonly book: BookView
    readonly preview: CostPreview
    readonly onStarted: (book: BookView) => void
    readonly onFailure: (failure: { readonly _tag: string }) => void
    readonly again?: boolean
  }
) => {
  const capId = useId()
  const [cap, setCap] = useState(() => String(suggestedCap(preview)))
  const [problem, setProblem] = useState<string>()
  const busy = useRef(false)

  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy.current) return
    const spendCap = Number(cap)
    if (!Number.isFinite(spendCap) || spendCap <= 0 || spendCap > 10_000) {
      return setProblem("Enter a cap in dollars, above 0.")
    }
    busy.current = true
    const result = await call((client) => client.books.start({ params: { id: book.id }, payload: { spendCap } }))
    busy.current = false
    if (result._tag === "Success") return onStarted(result.success)
    switch (result.failure._tag) {
      case "LlmNotConfigured":
        return setProblem(`Set ${result.failure.missing.join(", ")} in Settings first.`)
      case "BookNotReady":
        return setProblem("The book changed in the meantime; reload the page.")
      default:
        return onFailure(result.failure)
    }
  }

  const scanned = book.scannedPages
  return (
    <section className="group" aria-labelledby={`${capId}-title`}>
      <h2 id={`${capId}-title`}>Cost preview</h2>
      <dl className="facts">
        <div>
          <dt>Sample</dt>
          <dd>
            {preview.sampledPages.length === 0
              ? "No page has a text layer, so nothing was sampled."
              : `${preview.sampledPages.length} pages read by ${preview.model}: ${tokens(preview.sampleTokens)} tokens, ${
                formatDollars(preview.sampleCost)
              }.`}
          </dd>
        </div>
        <div>
          <dt>Full run</dt>
          <dd>
            {preview.projectedPages === 0
              ? "The sample covered every page with text."
              : `The other ${preview.projectedPages} pages with text: about ${tokens(preview.projectedTokens)} tokens, ${
                formatDollars(preview.projectedCost)
              }.`} The Book Map model reads them and proposes the Book Map for you to check.
          </dd>
        </div>
        {scanned.length > 0 && (
          <div>
            <dt>Scanned pages</dt>
            <dd>
              {scanned.length === 1 ? `Page ${pageRuns(scanned)} has` : `Pages ${pageRuns(scanned)} have`} no text layer.
              {book.scannedRoute === "image"
                ? ` The extraction model reads images, so ${scanned.length === 1 ? "it" : "they"} will be read as ${
                  scanned.length === 1 ? "a picture" : "pictures"
                }.`
                : ` The extraction model cannot read images, so ${
                  scanned.length === 1 ? "it goes" : "they go"
                } to the Review Queue for you. To have ${
                  scanned.length === 1 ? "it" : "them"
                } read, choose an extraction model that reads images in Settings before you start.`}
            </dd>
          </div>
        )}
      </dl>
      <form className="start-run" noValidate onSubmit={(event) => void start(event)}>
        <div className="field cap-field">
          <label htmlFor={capId}>Spend cap in dollars</label>
          <p id={`${capId}-hint`} className="hint">
            The run pauses if it reaches this. The suggested cap allows half again the projected cost.
          </p>
          <input
            id={capId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={cap}
            aria-describedby={`${capId}-hint`}
            aria-invalid={problem !== undefined}
            onChange={(event) => setCap(event.target.value)}
          />
        </div>
        <div className="actions">
          <button type="submit" className="button">{again ? "Start the full run again" : "Start the full run"}</button>
        </div>
        {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
      </form>
    </section>
  )
}

// Before any proposal: the Curator can map the Book by hand instead of
// waiting for, or paying for, the Book Map model.
const ManualMap = (
  { detail, onConfirmed, onFailure }: {
    readonly detail: BookDetail
    readonly onConfirmed: (detail: BookDetail) => void
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const [open, setOpen] = useState(false)
  if (open) return <BookMapEditor detail={detail} onConfirmed={onConfirmed} onFailure={onFailure} />
  return (
    <p className="aside">
      You can also map the book yourself.{" "}
      <button type="button" className="link-button" onClick={() => setOpen(true)}>Enter the Book Map by hand</button>
    </p>
  )
}
