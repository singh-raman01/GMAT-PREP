import { useCallback, useEffect, useId, useRef, useState } from "react"
import { bookFilePath } from "../../../src/api/Books.ts"
import {
  PublishableReasons,
  type QuestionView,
  type ReasonCode,
  type ReviewItemView,
  type ReviewReason
} from "../../../src/api/Review.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { RichInline, RichText } from "../RichText.tsx"
import { afterStreamClosed, useJobEvents } from "./jobEvents.ts"

interface Props {
  readonly onLocked: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

const ReasonLabels: Record<ReasonCode, string> = {
  "structure": "Answer choices",
  "no-key": "No key",
  "key-conflict": "Key conflict",
  "render": "Does not render",
  "figure": "Needs a figure",
  "same-text-other-key": "Same text, other key",
  "near-match": "Near match",
  "key-changed": "Key changed",
  "source-key": "Another Source's key",
  "unread-page": "Page not read",
  "tags": "Tags",
  "solver-disagreement": "Solver disagreement",
  "approach-misses-key": "Approach misses the key",
  "option-notes": "Option notes",
  "difficulty": "Difficulty"
}

const RepeatCodes: ReadonlySet<ReasonCode> = new Set(["near-match", "same-text-other-key"])

type Action = "publish" | "withdraw" | "keepAsVariant" | "merge" | "dismiss"

// What an item is, in a few words: its first Source, or its page.
const itemName = (item: ReviewItemView) => {
  if (item.page !== null) return `${item.page.bookTitle}, page ${item.page.number}`
  const first = item.question?.sources[0]
  return first === undefined ? "A Question" : `${first.bookTitle}: ${first.set}, question ${first.number}`
}

const Done: Record<string, string> = {
  published: "Published",
  withdrawn: "Withdrawn",
  merged: "Merged",
  dismissed: "Dismissed"
}

export const ReviewQueue = ({ onLocked, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const [items, setItems] = useState<ReadonlyArray<ReviewItemView>>()
  const [announcement, setAnnouncement] = useState("")
  const [since, setSince] = useState<"now">()
  // The item whose heading takes focus next, after the one acted on goes.
  const [focusItem, setFocusItem] = useState<string>()
  const mounted = useRef(true)

  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "CuratorNotUnlocked" ? onLocked() : onStopped(failure)),
    [onLocked, onStopped]
  )

  const load = useCallback(async () => {
    const result = await call((client) => client.review.list())
    if (!mounted.current) return
    if (result._tag === "Failure") return handle(result.failure)
    setItems(result.success)
    setSince("now")
  }, [handle])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
    }
  }, [load])

  // Extraction adds items as it links each question set.
  useJobEvents(
    since,
    (job) => {
      if (job.kind === "book-extract") void load()
    },
    () => void afterStreamClosed(load, onLocked, () => mounted.current)
  )

  useEffect(() => {
    if (focusItem === undefined) return
    const target = focusItem === "" ? heading.current : document.getElementById(`item-${focusItem}`)
    target?.focus()
    setFocusItem(undefined)
  }, [focusItem, heading])

  const act = async (item: ReviewItemView, action: Action): Promise<ReadonlyArray<ReviewReason> | string | undefined> => {
    const params = { params: { id: item.id } }
    const result = await call((client) => client.review[action](params))
    if (result._tag === "Success") {
      const next = result.success
      if (next.status !== "open" && items !== undefined) {
        const index = items.findIndex((each) => each.id === next.id)
        const after = items[index + 1] ?? items[index - 1]
        setFocusItem(after?.id ?? "")
      }
      setItems((current) =>
        current?.flatMap((each) => (each.id !== next.id ? [each] : next.status === "open" ? [next] : []))
      )
      // Each announcement names its item, so two in a row are both read out.
      setAnnouncement(
        next.status === "open"
          ? `${itemName(item)} is kept as a Variant; it still waits for you.`
          : `${Done[next.decision ?? ""] ?? "Decided"}: ${itemName(item)}.`
      )
      return undefined
    }
    switch (result.failure._tag) {
      case "CannotPublish":
        return result.failure.reasons
      case "ReviewItemNotOpen":
      case "ReviewItemNotFound":
        void load()
        return "This item changed in the meantime; the queue was read again."
      default:
        handle(result.failure)
        return undefined
    }
  }

  const questions = items?.filter((item) => item.question !== null).length ?? 0
  const pages = items?.filter((item) => item.page !== null).length ?? 0

  return (
    <>
      <h1 ref={heading} tabIndex={-1}>Review Queue</h1>
      <p className="lede">
        Questions from your books wait here until you publish them, each with every problem found. Publishing puts a
        Question in the Question Bank for every Profile.
      </p>
      <p className="visually-hidden" role="status">{announcement}</p>
      {items === undefined
        ? <p className="quiet" aria-busy="true">Loading the Review Queue</p>
        : items.length === 0
        ? <p className="empty">Nothing waits for you. Questions arrive here as books are extracted.</p>
        : (
          <>
            <p className="queue-count">
              {[
                questions > 0 ? `${questions} ${questions === 1 ? "Question" : "Questions"}` : undefined,
                pages > 0 ? `${pages} ${pages === 1 ? "page" : "pages"}` : undefined
              ].filter((part) => part !== undefined).join(" and ")} {questions + pages === 1 ? "waits" : "wait"} for you.
            </p>
            <ul className="review-items">
              {items.map((item) => <ReviewItem key={item.id} item={item} onAct={act} />)}
            </ul>
          </>
        )}
    </>
  )
}

const sourceText = (question: QuestionView) =>
  question.sources.map((source) => `${source.bookTitle}, ${source.set}, question ${source.number}, page ${source.page}`)
    .join("; ")

const QuestionBody = ({ question }: { readonly question: QuestionView }) => (
  <div className="question-body">
    <RichText source={question.stem} />
    <ol className="choices">
      {question.options.map((option) => (
        <li key={option.label} className={option.label === question.key ? "choice is-key" : "choice"}>
          <span className="choice-letter">
            {option.label === question.key ? <span className="mark">{option.label}</span> : option.label}
          </span>
          <span className="choice-text">
            <RichInline source={option.text} />
          </span>
          {option.label === question.key && <span className="visually-hidden">(the key)</span>}
        </li>
      ))}
    </ol>
  </div>
)

const ReviewItem = (
  { item, onAct }: {
    readonly item: ReviewItemView
    readonly onAct: (item: ReviewItemView, action: Action) => Promise<ReadonlyArray<ReviewReason> | string | undefined>
  }
) => {
  const headingId = useId()
  const [problem, setProblem] = useState<string>()
  const [checkingMerge, setCheckingMerge] = useState(false)
  const busy = useRef(false)
  const run = async (action: Action) => {
    if (busy.current) return
    busy.current = true
    const outcome = await onAct(item, action)
    busy.current = false
    if (outcome === undefined) return setProblem(undefined)
    setProblem(
      typeof outcome === "string"
        ? outcome
        : `Publishing waits for: ${outcome.map((reason) => ReasonLabels[reason.code].toLowerCase()).join(", ")}.`
    )
  }
  // Every button is read out with the item it acts on.
  const about = { "aria-describedby": headingId }
  const title = (
    <h2 id={headingId} className="review-heading">
      <span id={`item-${item.id}`} tabIndex={-1}>{itemName(item)}</span>
    </h2>
  )

  if (item.page !== null) {
    return (
      <li className="review-item">
        {title}
        <p className="review-source">
          <a href={`${bookFilePath(item.page.bookId)}#page=${item.page.number}`} target="_blank" rel="noopener">
            Open page {item.page.number}
          </a>
        </p>
        <Reasons reasons={item.reasons} />
        <div className="actions">
          <button type="button" className="button button-quiet" {...about} onClick={() => void run("dismiss")}>
            Dismiss
          </button>
        </div>
        {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
      </li>
    )
  }

  const question = item.question!
  const first = question.sources[0]
  const canPublish = item.reasons.every((reason) => PublishableReasons.has(reason.code))
  const repeats = item.related !== null && item.reasons.some((reason) => RepeatCodes.has(reason.code))
  return (
    <li className="review-item">
      {title}
      <p className="review-source">
        {sourceText(question)}
        {first !== undefined && (
          <>
            {". "}
            <a href={`${bookFilePath(first.bookId)}#page=${first.page}`} target="_blank" rel="noopener">
              Open page {first.page}
            </a>
          </>
        )}
      </p>
      {item.reasons.length === 0
        ? <p className="review-clear">No problems found. Check it against the book, then publish it.</p>
        : <Reasons reasons={item.reasons} />}
      <QuestionBody question={question} />
      {question.key === null && <p className="quiet">The Book gives no key for it.</p>}
      {question.explanation !== null && (
        <details className="explanation">
          <summary>The Book's explanation</summary>
          <RichText source={question.explanation} />
        </details>
      )}
      {item.related !== null && (
        <div className="related">
          <p className="related-label">The other Question, from {sourceText(item.related)}</p>
          <QuestionBody question={item.related} />
        </div>
      )}
      <div className="actions">
        {canPublish && (
          <button type="button" className="button" {...about} onClick={() => void run("publish")}>Publish</button>
        )}
        {repeats && (
          <>
            <button type="button" className="button button-quiet" {...about} onClick={() => void run("keepAsVariant")}>
              Keep as a Variant
            </button>
            <button
              type="button"
              className="button button-quiet"
              {...about}
              aria-expanded={checkingMerge}
              onClick={() => setCheckingMerge(true)}
            >
              Merge into the other
            </button>
          </>
        )}
        <button type="button" className="button button-quiet" {...about} onClick={() => void run("withdraw")}>
          Withdraw
        </button>
      </div>
      {checkingMerge && (
        <div className="merge-check" role="group" aria-label="Merge into the other Question">
          <p>
            This Question's Sources join the other Question, and this one is removed. Merging cannot be undone.
          </p>
          <div className="actions">
            <button type="button" className="button" {...about} onClick={() => void run("merge")}>Merge</button>
            <button type="button" className="button button-quiet" onClick={() => setCheckingMerge(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
    </li>
  )
}

const Reasons = ({ reasons }: { readonly reasons: ReadonlyArray<ReviewReason> }) => (
  <ul className="reasons">
    {reasons.map((reason) => (
      <li key={`${reason.code}-${reason.detail}`}>
        <span className="reason-label">{ReasonLabels[reason.code]}</span> {reason.detail}
      </li>
    ))}
  </ul>
)
