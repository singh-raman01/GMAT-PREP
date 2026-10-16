import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react"
import { bandNames, type DifficultyBand } from "../../../src/api/difficulty.ts"
import type { BatchView, GeneratedQuestionType } from "../../../src/api/Generation.ts"
import type { TaxonomyView } from "../../../src/api/Taxonomy.ts"
import { skillsFor } from "../../../src/api/taxonomyRules.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { dayAndTime } from "../format.ts"
import { linkProps } from "../router.ts"
import { afterStreamClosed, useJobEvents } from "./jobEvents.ts"

// Generation batches: the Curator asks for Data Insights Questions of one
// Question Type, aimed at a Skill and a Difficulty Band, and follows each
// batch as its job writes, checks and publishes them.

interface Props {
  readonly onLocked: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

const Types: ReadonlyArray<readonly [GeneratedQuestionType, string]> = [
  ["di.ta", "Table Analysis"],
  ["di.gi", "Graphics Interpretation"],
  ["di.tpa", "Two-Part Analysis"],
  ["di.msr", "Multi-Source Reasoning"]
]
const typeName = (type: GeneratedQuestionType) => Types.find(([id]) => id === type)?.[1] ?? type

const Bands: ReadonlyArray<DifficultyBand> = ["easy", "medium", "hard"]

const sentence = (note: string) => (/[.!?]$/.test(note.trim()) ? note.trim() : `${note.trim()}.`)

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export const Generation = ({ onLocked, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const [batches, setBatches] = useState<ReadonlyArray<BatchView>>()
  const [taxonomy, setTaxonomy] = useState<TaxonomyView>()
  const [since, setSince] = useState<"now">()
  const mounted = useRef(true)

  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "CuratorNotUnlocked" ? onLocked() : onStopped(failure)),
    [onLocked, onStopped]
  )

  const load = useCallback(async () => {
    const result = await call((client) => client.generation.batches())
    if (!mounted.current) return
    if (result._tag === "Failure") return handle(result.failure)
    setBatches(result.success)
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
      if (job.kind === "di-generate" || job.kind === "question-refresh") void load()
    },
    () => void afterStreamClosed(load, onLocked, () => mounted.current)
  )

  const skillName = (id: string) => {
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
      <h1 ref={heading} tabIndex={-1}>Generate</h1>
      <p className="lede">
        The generator writes Data Insights Questions on data of its own. Code works out every answer from the data, a
        second reading checks that each statement says what its data shows, and each Question then goes through the
        Publish Gate. A quarter of each batch is held back for Mocks.
      </p>
      <NewBatch
        taxonomy={taxonomy}
        onStarted={(batch) => setBatches((current) => [batch, ...(current ?? []).filter((each) => each.id !== batch.id)])}
        onFailure={handle}
      />
      <section className="group" aria-labelledby="batches-title">
        <h2 id="batches-title">Batches</h2>
        {batches === undefined
          ? <p className="quiet" aria-busy="true">Loading the batches</p>
          : batches.length === 0
          ? <p className="empty">No batch yet. Start one above.</p>
          : (
            <ul className="batches">
              {batches.map((batch) => <Batch key={batch.id} batch={batch} skillName={skillName} />)}
            </ul>
          )}
      </section>
    </>
  )
}

const NewBatch = (
  { taxonomy, onStarted, onFailure }: {
    readonly taxonomy: TaxonomyView | undefined
    readonly onStarted: (batch: BatchView) => void
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const id = useId()
  const [type, setType] = useState<GeneratedQuestionType>("di.ta")
  const [skill, setSkill] = useState("")
  const [band, setBand] = useState<DifficultyBand>("medium")
  const [count, setCount] = useState("5")
  const [cap, setCap] = useState("2")
  const [problem, setProblem] = useState<{ readonly text: string; readonly field: "count" | "cap" | null }>()
  const [started, setStarted] = useState("")
  const busy = useRef(false)
  // The Skills the Question Type takes, by Section, its own Section first.
  const offered = new Set(taxonomy === undefined ? [] : skillsFor(taxonomy, type).map((each) => each.id))
  const own = type.slice(0, type.indexOf("."))
  const groups = (taxonomy?.sections ?? [])
    .toSorted((a, b) => Number(b.id === own) - Number(a.id === own))
    .map((section) => ({
      name: section.name,
      skills: section.topics.flatMap((topic) => topic.skills).filter((each) => offered.has(each.id))
    }))
    .filter((group) => group.skills.length > 0)
  // A Skill of another Question Type gives way to the first of this one's.
  const chosen = offered.has(skill) ? skill : groups[0]?.skills[0]?.id ?? ""

  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const items = Number(count)
    if (!Number.isInteger(items) || items < 1 || items > 20) {
      return setProblem({ text: "Enter how many, from 1 to 20.", field: "count" })
    }
    const spendCap = Number(cap)
    if (!Number.isFinite(spendCap) || spendCap <= 0 || spendCap > 10_000) {
      return setProblem({ text: "Enter a cap in dollars, above 0.", field: "cap" })
    }
    if (chosen === "") return setProblem({ text: "Wait for the Skills to load, then choose one.", field: null })
    if (busy.current) return
    busy.current = true
    const result = await call((client) =>
      client.generation.start({ payload: { questionType: type, skill: chosen, band, count: items, spendCap } })
    )
    busy.current = false
    if (result._tag === "Success") {
      setProblem(undefined)
      setStarted(`Batch ${result.success.number} started.`)
      return onStarted(result.success)
    }
    setStarted("")
    switch (result.failure._tag) {
      case "SkillNotForType":
        return setProblem({ text: "Choose one of the Skills listed for this Question Type.", field: null })
      case "LlmNotConfigured":
        return setProblem({ text: `Set ${result.failure.missing.join(", ")} in Settings first.`, field: null })
      default:
        return onFailure(result.failure)
    }
  }

  return (
    <section className="group" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>New batch</h2>
      <p className="group-about">
        Each Question costs a call to write it, one to read each statement again, and the calls every Question's checks
        take, so a batch has a spend cap of its own.
      </p>
      <form className="new-batch" noValidate onSubmit={(event) => void start(event)}>
        <div className="field">
          <label htmlFor={`${id}-type`}>Question Type</label>
          <select id={`${id}-type`} value={type} onChange={(event) => setType(event.target.value as GeneratedQuestionType)}>
            {Types.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-skill`}>Skill</label>
          <select id={`${id}-skill`} value={chosen} onChange={(event) => setSkill(event.target.value)}>
            {groups.map((group) => (
              <optgroup key={group.name} label={group.name}>
                {group.skills.map((each) => <option key={each.id} value={each.id}>{each.name}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-band`}>Difficulty</label>
          <select id={`${id}-band`} value={band} onChange={(event) => setBand(event.target.value as DifficultyBand)}>
            {Bands.map((each) => <option key={each} value={each}>{bandNames[each]}</option>)}
          </select>
        </div>
        <div className="field count-field">
          <label htmlFor={`${id}-count`}>{type === "di.msr" ? "Sets of three Questions" : "Questions"}</label>
          <input
            id={`${id}-count`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={count}
            aria-invalid={problem?.field === "count"}
            onChange={(event) => setCount(event.target.value)}
          />
        </div>
        <div className="field cap-field">
          <label htmlFor={`${id}-cap`}>Spend cap in dollars</label>
          <input
            id={`${id}-cap`}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={cap}
            aria-invalid={problem?.field === "cap"}
            onChange={(event) => setCap(event.target.value)}
          />
        </div>
        <div className="actions">
          <button type="submit" className="button">Start the batch</button>
          <p className="saved" role="status">{started}</p>
        </div>
        {problem !== undefined && <p className="problem" role="alert">{problem.text}</p>}
      </form>
    </section>
  )
}

const Batch = ({ batch, skillName }: { readonly batch: BatchView; readonly skillName: (id: string) => string }) => {
  const job = batch.job
  const live = job !== null && (job.status === "queued" || job.status === "running" || job.status === "paused")
  const asked = batch.questionType === "di.msr"
    ? plural(batch.count, "set of three Questions", "sets of three Questions")
    : plural(batch.count, "Question", "Questions")
  return (
    <li className="batch">
      <h3 className="batch-title">
        Batch {batch.number}: {typeName(batch.questionType)}, {skillName(batch.skill)}
      </h3>
      <p className="batch-asked">
        {bandNames[batch.band]}, {asked}, started {dayAndTime(batch.createdAt)}.
      </p>
      <p className="batch-counts">
        {batch.published} published, {batch.held} held, {batch.reserved} for Mocks
        {batch.checking > 0 && `, ${batch.checking} being checked`}
        {batch.withdrawn > 0 && `, ${batch.withdrawn} withdrawn`}.
        {batch.failed > 0 && ` ${plural(batch.failed, "item", "items")} could not be made valid.`}
        {batch.held > 0 && (
          <>
            {" "}
            <a {...linkProps("/curator/review")}>Review the held ones</a>
          </>
        )}
      </p>
      {job !== null && job.status !== "done" && (
        <p className="job-note" aria-live={live ? "polite" : undefined}>
          {job.status === "paused"
            ? `Paused: ${sentence(job.note ?? "paused")}`
            : live
            ? `Working: ${sentence(job.note ?? "starting")}`
            : `The batch ${job.status === "failed" ? "failed" : "stopped"}: ${sentence(job.note ?? "no reason given")}`}{" "}
          <a {...linkProps("/curator/jobs")}>Jobs</a>
        </p>
      )}
    </li>
  )
}
