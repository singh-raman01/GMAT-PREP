import type { Effect } from "effect"
import { type FormEvent, type RefObject, useCallback, useEffect, useId, useRef, useState } from "react"
import { bookFilePath } from "../../../src/api/Books.ts"
import {
  type ApproachView,
  type CannotPublish,
  type DraftsView,
  type KeysDiffer,
  type OptionNoteView,
  PublishableReasons,
  type QuestionView,
  type ReasonCode,
  type ReviewItemView,
  type ReviewReason
} from "../../../src/api/Review.ts"
import type { TaxonomyView } from "../../../src/api/Taxonomy.ts"
import { bandOf } from "../../../src/api/difficulty.ts"
import { call, type Client } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { linkProps } from "../router.ts"
import { RichText } from "../RichText.tsx"
import { afterStreamClosed, useJobEvents } from "./jobEvents.ts"
import { StimulusDetails } from "../stimulus/StimulusPane.tsx"
import { partName, PartsWithKeys } from "./QuestionParts.tsx"

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
  "source-key": "Another Source's key",
  "unread-page": "Page not read",
  "tags": "Tags",
  "solver-disagreement": "Solver disagreement",
  "approach-misses-key": "Approach misses the key",
  "option-notes": "Option notes",
  "teaching-text": "Teaching text",
  "difficulty": "Difficulty",
  "not-enriched": "Not enriched",
  "predicate-disagreement": "Predicates disagree",
  "inference": "Inference to confirm",
  "inference-unconfirmed": "Inference unconfirmed"
}

const RepeatCodes: ReadonlySet<ReasonCode> = new Set(["near-match", "same-text-other-key"])
// Problems that leave a Question's text or figure in doubt.
const UnsureCodes: ReadonlySet<ReasonCode> = new Set(["structure", "render", "figure"])

type Action = "publish" | "withdraw" | "keepAsVariant" | "usePassage" | "merge" | "dismiss" | "checkAgain"

const send = (client: Client, action: Action, id: ReviewItemView["id"]): Effect.Effect<
  ReviewItemView,
  { readonly _tag: string }
> => {
  const params = { params: { id } }
  switch (action) {
    case "publish":
      return client.review.publish(params)
    case "withdraw":
      return client.review.withdraw(params)
    case "keepAsVariant":
      return client.review.keepAsVariant(params)
    case "usePassage":
      return client.review.usePassage(params)
    case "merge":
      return client.review.merge(params)
    case "dismiss":
      return client.review.dismiss(params)
    case "checkAgain":
      return client.review.checkAgain(params)
  }
}

const isCannotPublish = (failure: { readonly _tag: string }): failure is CannotPublish => failure._tag === "CannotPublish"
const isKeysDiffer = (failure: { readonly _tag: string }): failure is KeysDiffer => failure._tag === "KeysDiffer"

// Taxonomy names by id, for Skills, Strategies, Mistake Types and Trap
// Patterns; an id the Taxonomy does not hold shows as itself.
type Names = (id: string) => string

const namesOf = (taxonomy: TaxonomyView | undefined): Names => {
  if (taxonomy === undefined) return (id) => id
  const names = new Map<string, string>()
  for (const mistakeType of taxonomy.mistakeTypes) names.set(mistakeType.id, mistakeType.name)
  for (const section of taxonomy.sections) {
    for (const topic of section.topics) for (const skill of topic.skills) names.set(skill.id, skill.name)
    for (const strategy of section.strategies) names.set(strategy.id, strategy.name)
    for (const trap of section.trapPatterns) names.set(trap.id, trap.name)
  }
  return (id) => names.get(id) ?? id
}

// What an item is, in a few words: its first Source, or its page.
const itemName = (item: ReviewItemView) => {
  if (item.page !== null) return `${item.page.bookTitle}, page ${item.page.number}`
  const generated = item.question?.generated
  if (generated !== null && generated !== undefined) {
    return generated.question === null
      ? `Generated batch ${generated.batch}, item ${generated.item}`
      : `Generated batch ${generated.batch}, set ${generated.item}, question ${generated.question}`
  }
  const first = item.question?.sources[0]
  return first === undefined ? "A Question" : `${first.bookTitle}: ${first.set}, question ${first.number}`
}

const Done: Record<string, string> = {
  published: "Published",
  withdrawn: "Withdrawn",
  merged: "Merged",
  dismissed: "Dismissed"
}

// Jobs whose progress adds or changes items.
const QueueJobs: ReadonlySet<string> = new Set(["book-extract", "question-refresh"])

export const ReviewQueue = ({ onLocked, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const [items, setItems] = useState<ReadonlyArray<ReviewItemView>>()
  const [taxonomy, setTaxonomy] = useState<TaxonomyView>()
  const [announcement, setAnnouncement] = useState("")
  const [since, setSince] = useState<"now">()
  // The item whose heading takes focus next, after the one acted on goes.
  const [focusItem, setFocusItem] = useState<string>()
  const [waiting, setWaiting] = useState<DraftsView>()
  // Items sent off to be checked again, by name, to say so when they return.
  const away = useRef(new Map<string, string>())
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
    const back = result.success.filter((item) => away.current.has(item.id))
    for (const item of back) away.current.delete(item.id)
    if (back.length > 0) {
      setAnnouncement(`Back in the queue, held again: ${back.map((item) => itemName(item)).join("; ")}.`)
    }
    const drafts = await call((client) => client.review.drafts())
    if (mounted.current && drafts._tag === "Success") setWaiting(drafts.success)
  }, [handle])

  useEffect(() => {
    mounted.current = true
    void load()
    void call((client) => client.bank.taxonomy()).then((result) => {
      if (mounted.current && result._tag === "Success") setTaxonomy(result.success)
    })
    return () => {
      mounted.current = false
    }
  }, [load])

  useJobEvents(
    since,
    (job) => {
      if (QueueJobs.has(job.kind)) void load()
    },
    () => void afterStreamClosed(load, onLocked, () => mounted.current)
  )

  useEffect(() => {
    if (focusItem === undefined) return
    const target = focusItem === "" ? heading.current : document.getElementById(`item-${focusItem}`)
    target?.focus()
    setFocusItem(undefined)
  }, [focusItem, heading])

  // Takes an item off the list, moving focus to the next one.
  const leave = (gone: string) => {
    if (items !== undefined) {
      const index = items.findIndex((each) => each.id === gone)
      setFocusItem((items[index + 1] ?? items[index - 1])?.id ?? "")
    }
    setItems((current) => current?.filter((each) => each.id !== gone))
  }

  const act = async (item: ReviewItemView, action: Action): Promise<ReadonlyArray<ReviewReason> | string | undefined> => {
    const result = await call((client) => send(client, action, item.id))
    if (result._tag === "Success") {
      const next = result.success
      // Each announcement names its item, so two in a row are both read out.
      if (action === "checkAgain" || action === "usePassage") {
        leave(next.id)
        away.current.set(next.id, itemName(item))
        setAnnouncement(
          action === "usePassage"
            ? `${itemName(item)} now asks about the other Question's passage. It is being checked again and comes back here if it is held.`
            : `${itemName(item)} is being checked again. It comes back here if it is held.`
        )
        void load()
        return undefined
      }
      if (next.status === "open") setItems((current) => current?.map((each) => (each.id === next.id ? next : each)))
      else leave(next.id)
      setAnnouncement(
        next.status === "open"
          ? `${itemName(item)} is kept as a Variant; it still waits for you.`
          : `${Done[next.decision ?? ""] ?? "Decided"}: ${itemName(item)}.`
      )
      return undefined
    }
    const failure = result.failure
    if (isCannotPublish(failure)) return failure.reasons
    if (isKeysDiffer(failure)) {
      return `Its key is ${failure.key}, by your Key Override, and the other Question's is ${
        failure.relatedKey ?? "not known"
      }. Change one of the keys first, so they agree.`
    }
    if (failure._tag === "NoOtherPassage") {
      void load()
      return "The two Questions no longer ask about different passages; the queue was read again."
    }
    if (failure._tag === "MergeTargetChecking") {
      void load()
      return "The other Question is still waiting for its checks. Merge into it once it is published or held."
    }
    if (failure._tag === "ReviewItemNotOpen" || failure._tag === "ReviewItemNotFound") {
      void load()
      return "This item changed in the meantime; the queue was read again."
    }
    handle(failure)
    return undefined
  }

  const checkDrafts = async () => {
    const result = await call((client) => client.review.checkDrafts())
    if (!mounted.current) return
    if (result._tag === "Failure") return handle(result.failure)
    setWaiting(result.success)
    setAnnouncement("The waiting Questions are being checked. Any that are held come here.")
  }

  const changeKey = async (
    item: ReviewItemView,
    part: number,
    key: string,
    reason: string
  ): Promise<string | undefined> => {
    const result = await call((client) => client.review.overrideKey({ params: { id: item.id }, payload: { part, key, reason } }))
    if (result._tag === "Success") {
      leave(item.id)
      away.current.set(item.id, itemName(item))
      const which = (item.question?.parts.length ?? 1) > 1 ? `Part ${part + 1}'s key` : "the key"
      setAnnouncement(`${itemName(item)}: ${which} is now ${key}. It is being checked again and comes back if it is held.`)
      void load()
      return undefined
    }
    switch (result.failure._tag) {
      case "KeyNotAnOption":
        return `Choose one of its answer choices: ${result.failure.options.join(", ")}.`
      case "ReviewItemNotOpen":
      case "ReviewItemNotFound":
        void load()
        return "This item changed in the meantime; the queue was read again."
      default:
        handle(result.failure)
        return undefined
    }
  }

  const names = namesOf(taxonomy)
  const questions = items?.filter((item) => item.question !== null).length ?? 0
  const pages = items?.filter((item) => item.page !== null).length ?? 0

  return (
    <>
      <h1 ref={heading} tabIndex={-1}>Review Queue</h1>
      <p className="lede">
        Questions that pass every check are published on their own. The rest wait here, each with every reason, until
        you publish, change the key of, or withdraw them.
      </p>
      <p className="visually-hidden" role="status">{announcement}</p>
      {waiting !== undefined && (waiting.checking > 0 || waiting.paused > 0 || waiting.stranded > 0) && (
        <div className="drafts-note">
          {waiting.checking > 0 && (
            <p>
              {waiting.checking} {waiting.checking === 1 ? "Question is" : "Questions are"}{" "}
              being checked. Any that are held come here.
            </p>
          )}
          {waiting.paused > 0 && (
            <p>
              {waiting.paused} {waiting.paused === 1 ? "Question waits" : "Questions wait"}{" "}
              for a paused job. <a {...linkProps("/curator/jobs")}>Resume it in Jobs</a>.
            </p>
          )}
          {waiting.stranded > 0 && (
            <>
              <p>
                {waiting.stranded} {waiting.stranded === 1 ? "Question waits" : "Questions wait"}{" "}
                for a check no job will run, as after a job was cancelled.
              </p>
              <div className="actions">
                <button type="button" className="button button-quiet" onClick={() => void checkDrafts()}>
                  Check {waiting.stranded === 1 ? "it" : "them"} now
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {items === undefined
        ? <p className="quiet" aria-busy="true">Loading the Review Queue</p>
        : items.length === 0
        ? <p className="empty">Nothing waits for you. Questions a check holds arrive here as books are extracted.</p>
        : (
          <>
            <p className="queue-count">
              {[
                questions > 0 ? `${questions} ${questions === 1 ? "Question" : "Questions"}` : undefined,
                pages > 0 ? `${pages} ${pages === 1 ? "page" : "pages"}` : undefined
              ].filter((part) => part !== undefined).join(" and ")} {questions + pages === 1 ? "waits" : "wait"} for you.
            </p>
            <ul className="review-items">
              {items.map((item) => (
                <ReviewItem key={item.id} item={item} names={names} onAct={act} onChangeKey={changeKey} />
              ))}
            </ul>
          </>
        )}
    </>
  )
}

const sourceText = (question: QuestionView) =>
  question.generated !== null
    ? question.generated.question === null
      ? `Generated in batch ${question.generated.batch}, item ${question.generated.item}`
      : `Generated in batch ${question.generated.batch}, set ${question.generated.item}, question ${question.generated.question}`
    : question.sources.map((source) => `${source.bookTitle}, ${source.set}, question ${source.number}, page ${source.page}`)
      .join("; ")

const OptionNote = ({ note, names }: { readonly note: OptionNoteView; readonly names: Names }) => (
  <span className="option-note">
    {note.trapNote}{" "}
    <span className="note-tags">
      {names(note.mistakeType)}
      {note.trapPattern !== null && `, ${names(note.trapPattern)}`}
    </span>
  </span>
)

const QuestionBody = ({ question, names }: { readonly question: QuestionView; readonly names: Names }) => (
  <div className="question-body">
    {question.stimulus !== null && <StimulusDetails stimulus={question.stimulus} />}
    <RichText source={question.stem} />
    <PartsWithKeys
      parts={question.parts}
      keys={question.parts.map((part) => part.key)}
      extra={(part, label) => {
        const note = question.optionNotes.find((each) => each.part === part && each.label === label)
        return note === undefined ? null : <OptionNote note={note} names={names} />
      }}
    />
  </div>
)

const seconds = (total: number) => (total < 60 ? `${total} seconds` : `${Math.round(total / 6) / 10} minutes`)

const Approach = ({ approach, names }: { readonly approach: ApproachView; readonly names: Names }) => (
  <li className="approach">
    <p className="approach-head">
      {names(approach.strategy)}, {approach.author === "book" ? "the Book's explanation" : "written by the model"}
      {approach.answer !== null && `, reaching ${approach.answer}`}. About {seconds(approach.expectedSeconds)}.
    </p>
    <p className="approach-when">Valid when {approach.validWhen.charAt(0).toLowerCase() + approach.validWhen.slice(1)}</p>
    <RichText source={approach.steps} className="approach-steps" />
  </li>
)

// What enrichment gave the Question, for checking it.
const Enrichment = ({ question, names }: { readonly question: QuestionView; readonly names: Names }) => {
  if (question.primarySkill === null && question.solverAnswers.length === 0) return null
  const skills = [question.primarySkill, ...question.secondarySkills].filter((skill): skill is string => skill !== null)
  return (
    <div className="enrichment">
      <dl className="facts">
        {skills.length > 0 && (
          <div>
            <dt>Skills</dt>
            <dd>{skills.map(names).join(", ")}</dd>
          </div>
        )}
        {question.difficultyEstimate !== null && (
          <div>
            <dt>Difficulty</dt>
            <dd>
              Estimated {question.difficultyEstimate.toFixed(1)}, {bandOf(question.difficultyEstimate)}
              {question.bookLabel !== null && `; the Book says ${question.bookLabel}`}
            </dd>
          </div>
        )}
        {question.solverAnswers.length > 0 && (
          <div>
            <dt>Independent solves</dt>
            <dd>{question.solverAnswers.join(", ")}</dd>
          </div>
        )}
      </dl>
      {question.approaches.length > 0 && (
        <details className="approaches">
          <summary>
            {question.approaches.length === 1 ? "One Approach" : `${question.approaches.length} Approaches`}
          </summary>
          <ol>
            {question.approaches.map((approach, index) => <Approach key={index} approach={approach} names={names} />)}
          </ol>
        </details>
      )}
    </div>
  )
}

// Replacing the key, with the reason kept beside it.
const KeyChange = (
  { id, question, unsure, about, onChange, onCancel }: {
    readonly id: string
    readonly question: QuestionView
    // Its text is in doubt, so nothing is written for it until that is settled.
    readonly unsure: boolean
    readonly about: { readonly "aria-describedby": string }
    readonly onChange: (part: number, key: string, reason: string) => Promise<string | undefined>
    readonly onCancel: () => void
  }
) => {
  const ids = { choices: useId(), reason: useId(), part: useId() }
  const [position, setPosition] = useState(0)
  const part = question.parts[position] ?? question.parts[0]!
  const several = question.parts.length > 1
  const [key, setKey] = useState<string>()
  const [reason, setReason] = useState("")
  const [problem, setProblem] = useState<string>()
  const busy = useRef(false)
  const legend = useFocusOnMount<HTMLLegendElement>()
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (key === undefined) return setProblem("Choose the right answer.")
    if (reason.trim().length < 3) return setProblem("Say why the key changes, such as the Book's errata.")
    if (busy.current) return
    busy.current = true
    const outcome = await onChange(position, key, reason.trim())
    busy.current = false
    setProblem(outcome)
  }
  return (
    <form id={id} className="key-change" noValidate onSubmit={(event) => void submit(event)}>
      {several && (
        <div className="field">
          <label htmlFor={ids.part}>Part</label>
          <select
            id={ids.part}
            value={position}
            onChange={(event) => {
              setPosition(Number(event.target.value))
              setKey(undefined)
            }}
          >
            {question.parts.map((each, index) => <option key={index} value={index}>{partName(each, index)}</option>)}
          </select>
        </div>
      )}
      <fieldset>
        <legend ref={legend} tabIndex={-1}>{several ? `The right answer for Part ${position + 1}` : "The right answer"}</legend>
        <div className="key-choices">
          {part.options.map((option) => (
            <label key={option.label} className="key-choice">
              <input
                type="radio"
                name={ids.choices}
                value={option.label}
                checked={key === option.label}
                onChange={() => setKey(option.label)}
              />
              {option.label}
              {(several || part.kind !== "single-choice") && <span className="quiet"> {option.text}</span>}
              {option.label === part.key && <span className="quiet"> (now)</span>}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="field">
        <label htmlFor={ids.reason}>Why</label>
        <textarea id={ids.reason} rows={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
      </div>
      <p className="hint">
        {key === undefined || key === part.key
          ? "The key stays, now as your decision, and the Question goes through every check again."
          : unsure
          ? "The key changes. Approaches and wrong-choice notes wait until its text is no longer in doubt, so it comes back here."
          : "Its Approaches and wrong-choice notes are written again for the new key, and it goes through every check again."}
      </p>
      <div className="actions">
        <button type="submit" className="button" {...about}>Change the key</button>
        <button type="button" className="button button-quiet" onClick={onCancel}>Cancel</button>
      </div>
      {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
    </form>
  )
}

const ReviewItem = (
  { item, names, onAct, onChangeKey }: {
    readonly item: ReviewItemView
    readonly names: Names
    readonly onAct: (item: ReviewItemView, action: Action) => Promise<ReadonlyArray<ReviewReason> | string | undefined>
    readonly onChangeKey: (item: ReviewItemView, part: number, key: string, reason: string) => Promise<string | undefined>
  }
) => {
  const headingId = useId()
  const ids = { merge: useId(), key: useId() }
  const [problem, setProblem] = useState<string>()
  const [checkingMerge, setCheckingMerge] = useState(false)
  const [changingKey, setChangingKey] = useState(false)
  const mergeButton = useRef<HTMLButtonElement>(null)
  const keyButton = useRef<HTMLButtonElement>(null)
  const mergeCheck = useRef<HTMLParagraphElement>(null)
  const busy = useRef(false)
  // Closing a form puts focus back on the button that opened it.
  const close = (hide: () => void, opener: RefObject<HTMLButtonElement | null>) => {
    hide()
    requestAnimationFrame(() => opener.current?.focus())
  }
  useEffect(() => {
    if (checkingMerge) mergeCheck.current?.focus()
  }, [checkingMerge])
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
  // Two passages that differ only a little are one passage printed twice.
  const otherPassage = repeats && question.stimulus?.kind === "passage" && item.related?.stimulus?.kind === "passage" &&
    item.related.stimulus.body !== question.stimulus.body
  const override = question.keyOverrides.at(-1)
  return (
    <li className="review-item">
      {title}
      {question.generated === null && (
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
      )}
      {item.reasons.length === 0
        ? <p className="review-clear">No problems found. Check it against the book, then publish it.</p>
        : <Reasons reasons={item.reasons} />}
      <QuestionBody question={question} names={names} />
      {question.key === null && <p className="quiet">The Book gives no key for it.</p>}
      {override !== undefined && (
        <p className="quiet">
          You changed {question.parts.length > 1 ? `Part ${override.part + 1}'s key` : "the key"} from{" "}
          {override.previousKey ?? "none"} to {override.newKey}: {override.reason}
        </p>
      )}
      <Enrichment question={question} names={names} />
      {question.explanation !== null && (
        <details className="explanation">
          <summary>The Book's explanation</summary>
          <RichText source={question.explanation} />
        </details>
      )}
      {item.related !== null && (
        <div className="related">
          <p className="related-label">The other Question, from {sourceText(item.related)}</p>
          <QuestionBody question={item.related} names={names} />
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
            {otherPassage && (
              <button type="button" className="button button-quiet" {...about} onClick={() => void run("usePassage")}>
                Use the other passage
              </button>
            )}
            <button
              ref={mergeButton}
              type="button"
              className="button button-quiet"
              {...about}
              aria-expanded={checkingMerge}
              aria-controls={ids.merge}
              onClick={() => setCheckingMerge(true)}
            >
              Merge into the other
            </button>
          </>
        )}
        {item.checkable && (
          <button type="button" className="button button-quiet" {...about} onClick={() => void run("checkAgain")}>
            Check again
          </button>
        )}
        {question.parts.some((part) => part.options.length > 0) && (
          <button
            ref={keyButton}
            type="button"
            className="button button-quiet"
            {...about}
            aria-expanded={changingKey}
            aria-controls={ids.key}
            onClick={() => setChangingKey(true)}
          >
            Change the key
          </button>
        )}
        <button type="button" className="button button-quiet" {...about} onClick={() => void run("withdraw")}>
          Withdraw
        </button>
      </div>
      {otherPassage && (
        <p className="hint">
          Use the other passage when the two passages are the same one printed twice: this Question keeps its words, asks
          about the other Question's passage, and is checked again.
        </p>
      )}
      {item.checkable && (
        <p className="hint">Check again asks once more for the tags, solves, Approaches or notes a reply left unusable.</p>
      )}
      {checkingMerge && (
        <div id={ids.merge} className="merge-check" role="group" aria-label="Merge into the other Question">
          <p ref={mergeCheck} tabIndex={-1}>
            This Question's Sources join the other Question, and this one is removed
            {question.golden ? ", with its golden-set approval" : ""}. Merging cannot be undone.
          </p>
          <div className="actions">
            <button type="button" className="button" {...about} onClick={() => void run("merge")}>Merge</button>
            <button
              type="button"
              className="button button-quiet"
              onClick={() => close(() => setCheckingMerge(false), mergeButton)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {changingKey && (
        <KeyChange
          id={ids.key}
          question={question}
          unsure={item.reasons.some((reason) => UnsureCodes.has(reason.code))}
          about={about}
          onChange={(part, key, reason) => onChangeKey(item, part, key, reason)}
          onCancel={() => close(() => setChangingKey(false), keyButton)}
        />
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
