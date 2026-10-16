import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react"
import { type GoldenCandidate, type GoldenReport, type GoldenView, TagAgreementNeeded } from "../../../src/api/Golden.ts"
import type { TaxonomyView } from "../../../src/api/Taxonomy.ts"
import { skillsFor } from "../../../src/api/taxonomyRules.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { dayAndTime } from "../format.ts"
import { linkProps } from "../router.ts"
import { RichInline, RichText } from "../RichText.tsx"
import { afterStreamClosed, useJobEvents } from "./jobEvents.ts"

// The golden set: the Curator approves the first Book's Questions with their
// Skills, and checks them against the current prompts and models.

interface Props {
  readonly onLocked: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

const percent = (share: number) => `${Math.round(share * 100)}%`

export const GoldenSet = ({ onLocked, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const [view, setView] = useState<GoldenView>()
  const [taxonomy, setTaxonomy] = useState<TaxonomyView>()
  const [since, setSince] = useState<"now">()
  const [announcement, setAnnouncement] = useState("")
  const mounted = useRef(true)

  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "CuratorNotUnlocked" ? onLocked() : onStopped(failure)),
    [onLocked, onStopped]
  )

  const load = useCallback(async () => {
    const result = await call((client) => client.golden.get())
    if (!mounted.current) return
    if (result._tag === "Failure") return handle(result.failure)
    setView(result.success)
    setSince("now")
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
      if (job.kind === "golden-check" || job.kind === "book-extract") void load()
    },
    () => void afterStreamClosed(load, onLocked, () => mounted.current)
  )

  const skillName = (id: string | null) => {
    if (id === null) return "none"
    for (const section of taxonomy?.sections ?? []) {
      for (const topic of section.topics) {
        const skill = topic.skills.find((each) => each.id === id)
        if (skill !== undefined) return skill.name
      }
    }
    return id
  }

  return (
    <>
      <h1 ref={heading} tabIndex={-1}>Golden set</h1>
      <p className="lede">
        The first {view?.limit ?? 100} Questions you approve from the first book. Check each against the book, confirm
        or correct its Skills, and approve it. Every change of prompt or model is then checked against them: text,
        answer choices and keys must stay exact, and Skills must match yours on{" "}
        {percent(TagAgreementNeeded)} of them.
      </p>
      <p className="visually-hidden" role="status">{announcement}</p>
      {view === undefined
        ? <p className="quiet" aria-busy="true">Loading the golden set</p>
        : view.book === null
        ? (
          <p className="empty">
            No book yet. <a {...linkProps("/curator")}>Add one</a>; its Questions appear here once they are extracted.
          </p>
        )
        : (
          <>
            <Check view={view} onChanged={setView} onFailure={handle} />
            {view.report !== null && <Report report={view.report} />}
            <section className="group" aria-labelledby="golden-questions">
              <h2 id="golden-questions">Questions from {view.book.title}</h2>
              <p className="group-about">
                {view.approved} of {view.limit} approved.
                {view.candidates.length === 0 && " None is published or held yet."}
              </p>
              <ul className="golden-items">
                {view.candidates.map((candidate) => (
                  <Candidate
                    key={candidate.questionId}
                    candidate={candidate}
                    taxonomy={taxonomy}
                    skillName={skillName}
                    full={view.approved >= view.limit}
                    onChanged={(next, message) => {
                      setView(next)
                      setAnnouncement(message)
                    }}
                    onFailure={handle}
                  />
                ))}
              </ul>
            </section>
          </>
        )}
    </>
  )
}

const Check = (
  { view, onChanged, onFailure }: {
    readonly view: GoldenView
    readonly onChanged: (view: GoldenView) => void
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const capId = useId()
  const [cap, setCap] = useState("1")
  const [problem, setProblem] = useState<{ readonly text: string; readonly aboutCap: boolean }>()
  const busy = useRef(false)
  const job = view.job
  const running = job !== null && (job.status === "queued" || job.status === "running" || job.status === "paused")

  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const spendCap = Number(cap)
    if (!Number.isFinite(spendCap) || spendCap <= 0 || spendCap > 10_000) {
      return setProblem({ text: "Enter a cap in dollars, above 0.", aboutCap: true })
    }
    if (running) return setProblem({ text: "A check is running already. Its report shows here when it is done.", aboutCap: false })
    if (busy.current) return
    busy.current = true
    const result = await call((client) => client.golden.check({ payload: { spendCap } }))
    busy.current = false
    if (result._tag === "Success") {
      setProblem(undefined)
      return onChanged(result.success)
    }
    switch (result.failure._tag) {
      case "GoldenSetEmpty":
        return setProblem({ text: "Approve at least one Question first.", aboutCap: false })
      case "LlmNotConfigured":
        return setProblem({ text: `Set ${result.failure.missing.join(", ")} in Settings first.`, aboutCap: false })
      case "GoldenCheckRunning":
        return setProblem({ text: "A check is running already. Its report shows here when it is done.", aboutCap: false })
      default:
        return onFailure(result.failure)
    }
  }

  return (
    <section className="group" aria-labelledby={`${capId}-title`}>
      <h2 id={`${capId}-title`}>Check</h2>
      <p className="group-about">
        Reads the approved Questions' pages again and tags them again with the models in Settings. It spends like
        extraction, so it has a cap of its own.
      </p>
      {job !== null && (
        <p className="job-note" aria-live="polite">
          {running
            ? `Checking: ${job.note ?? "starting"}.`
            : job.status === "done"
            ? `Last checked ${dayAndTime(job.updatedAt)}.`
            : `The last check ${job.status === "failed" ? "failed" : "stopped"}: ${job.note ?? ""}`}{" "}
          <a {...linkProps("/curator/jobs")}>Jobs</a>
        </p>
      )}
      <form className="start-run" noValidate onSubmit={(event) => void start(event)}>
        <div className="field cap-field">
          <label htmlFor={capId}>Spend cap in dollars</label>
          <input
            id={capId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={cap}
            aria-invalid={problem?.aboutCap === true}
            onChange={(event) => setCap(event.target.value)}
          />
        </div>
        <div className="actions">
          <button type="submit" className="button" aria-disabled={running}>Check the golden set</button>
        </div>
        {problem !== undefined && <p className="problem" role="alert">{problem.text}</p>}
      </form>
    </section>
  )
}

const Report = ({ report }: { readonly report: GoldenReport }) => (
  <section className="group" aria-labelledby="golden-report">
    <h2 id="golden-report">Last check: {report.passed ? "passed" : "failed"}</h2>
    <dl className="facts">
      <div>
        <dt>Text exact</dt>
        <dd>{report.textExact} of {report.items}</dd>
      </div>
      <div>
        <dt>Answer choices exact</dt>
        <dd>{report.partsExact} of {report.items}</dd>
      </div>
      <div>
        <dt>Keys exact</dt>
        <dd>{report.keysExact} of {report.items}</dd>
      </div>
      <div>
        <dt>Skills match</dt>
        <dd>
          {percent(report.tagAgreement)}, against {percent(TagAgreementNeeded)} needed
        </dd>
      </div>
    </dl>
    {report.misses.length > 0 && (
      <ul className="golden-misses">
        {report.misses.map((miss) => (
          <li key={miss.questionId}>
            <span className="reason-label">{miss.set}, question {miss.number}</span> {miss.detail}
          </li>
        ))}
      </ul>
    )}
  </section>
)

const Candidate = (
  { candidate, taxonomy, skillName, full, onChanged, onFailure }: {
    readonly candidate: GoldenCandidate
    readonly taxonomy: TaxonomyView | undefined
    readonly skillName: (id: string | null) => string
    readonly full: boolean
    readonly onChanged: (view: GoldenView, message: string) => void
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const ids = { heading: useId(), primary: useId(), second: useId(), third: useId() }
  const [primary, setPrimary] = useState(candidate.primarySkill ?? "")
  const [second, setSecond] = useState(candidate.secondarySkills[0] ?? "")
  const [third, setThird] = useState(candidate.secondarySkills[1] ?? "")
  const [problem, setProblem] = useState<string>()
  const busy = useRef(false)
  const approveButton = useRef<HTMLButtonElement>(null)
  const offered = taxonomy === undefined ? [] : skillsFor(taxonomy, candidate.questionType)
  const name = `${candidate.set}, question ${candidate.number}`

  const approve = async () => {
    if (primary === "") return setProblem("Choose its main Skill.")
    if (busy.current) return
    busy.current = true
    const secondarySkills = [...new Set([second, third].filter((skill) => skill !== "" && skill !== primary))]
    const result = await call((client) =>
      client.golden.approve({ params: { questionId: candidate.questionId }, payload: { primarySkill: primary, secondarySkills } })
    )
    busy.current = false
    if (result._tag === "Success") {
      setProblem(undefined)
      return onChanged(result.success, `${name} is approved.`)
    }
    switch (result.failure._tag) {
      case "GoldenTagsInvalid":
        return setProblem(result.failure.problems.join(" "))
      case "GoldenSetFull":
        return setProblem(`The golden set holds ${result.failure.limit} Questions already.`)
      case "NotGoldenCandidate":
        return setProblem("This Question changed in the meantime; reload the page.")
      default:
        return onFailure(result.failure)
    }
  }

  const remove = async () => {
    const result = await call((client) => client.golden.remove({ params: { questionId: candidate.questionId } }))
    if (result._tag === "Success") {
      onChanged(result.success, `${name} is out of the golden set.`)
      // The button that was pressed is gone; focus stays with the Question.
      return requestAnimationFrame(() => approveButton.current?.focus())
    }
    if (result.failure._tag === "NotGoldenCandidate") return setProblem("It was not in the golden set.")
    onFailure(result.failure)
  }

  const about = { "aria-describedby": ids.heading }
  const skillSelect = (id: string, label: string, value: string, set: (value: string) => void, optional: boolean) => (
    <div className="field">
      <label htmlFor={id}>
        {label}
        <span className="visually-hidden">, {name}</span>
      </label>
      <select id={id} value={value} onChange={(event) => set(event.target.value)}>
        <option value="">{optional ? "None" : "Choose a Skill"}</option>
        {offered.map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}
      </select>
    </div>
  )

  return (
    <li className="golden-item" data-approved={candidate.approved}>
      <h3 id={ids.heading} className="review-heading">
        {name}, page {candidate.page}
        {candidate.approved && <span className="tag golden-tag">Approved</span>}
      </h3>
      <div className="question-body">
        <RichText source={candidate.stem} />
        <ol className="choices">
          {candidate.options.map((option) => (
            <li key={option.label} className={option.label === candidate.key ? "choice is-key" : "choice"}>
              <span className="choice-letter">
                {option.label === candidate.key ? <span className="mark">{option.label}</span> : option.label}
              </span>
              <span className="choice-text">
                <RichInline source={option.text} />
                {option.label === candidate.key && <span className="visually-hidden">(the key)</span>}
              </span>
            </li>
          ))}
        </ol>
      </div>
      <p className="quiet">
        {candidate.approved ? "Your Skills" : "The model's Skills"}: {skillName(candidate.primarySkill)}
        {candidate.secondarySkills.length > 0 && `, also ${candidate.secondarySkills.map(skillName).join(", ")}`}.
        {candidate.status === "held" && " It waits in the Review Queue."}
        {candidate.bookKey !== candidate.key &&
          ` The Book prints ${candidate.bookKey ?? "no key"}, which a check expects; the key is now ${candidate.key ?? "none"}.`}
      </p>
      <div className="golden-tags">
        {skillSelect(ids.primary, "Main Skill", primary, setPrimary, false)}
        {skillSelect(ids.second, "Second Skill", second, setSecond, true)}
        {skillSelect(ids.third, "Third Skill", third, setThird, true)}
      </div>
      <div className="actions">
        <button
          ref={approveButton}
          type="button"
          className="button"
          {...about}
          aria-disabled={!candidate.approved && full}
          onClick={() => void approve()}
        >
          {candidate.approved ? "Update its Skills" : "Approve"}
        </button>
        {candidate.approved && (
          <button type="button" className="button button-quiet" {...about} onClick={() => void remove()}>
            Take out
          </button>
        )}
      </div>
      {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
    </li>
  )
}
