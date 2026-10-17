import { useCallback, useEffect, useId, useRef, useState } from "react"
import {
  type OfficialScoreKind,
  OfficialScoreKindNames,
  type OfficialScoreView,
  type ScoreEstimates
} from "../../../src/api/Scores.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"

// Scores: the Profile's Score Estimates with the Total, and the Official
// Scores that calibrate them.

interface Props {
  readonly onSessionLost: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

const kinds = Object.keys(OfficialScoreKindNames) as Array<OfficialScoreKind>

// A new form starts on today in the Profile's time zone, as the server gives
// it: the latest day an Official Score can be dated.
const blankForm = (today = "") => ({ takenOn: today, kind: "practice-exam" as OfficialScoreKind, total: "", quant: "", verbal: "", di: "" })
type Form = ReturnType<typeof blankForm>

const sectionNames: Readonly<Record<string, string>> = { quant: "Quantitative", verbal: "Verbal", di: "Data Insights" }

const listed = (names: ReadonlyArray<string>) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`

// What an Official Score does for the Score Estimates.
const usedText = (score: OfficialScoreView) =>
  score.calibrates.length === 0
    ? "Not used: it was taken before your first Score Estimates"
    : `Calibrates ${listed(score.calibrates.map((section) => sectionNames[section] ?? section))}`

// A day as the date input gives it, read as written, not in a time zone.
const dayText = (day: string) =>
  new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(
    Date.parse(`${day}T00:00:00Z`)
  )

// What the form gets wrong, before the server checks it again.
const formProblems = (form: Form) => {
  const problems: Array<string> = []
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.takenOn)) problems.push("Give the date you took it.")
  const whole = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined)
  const total = whole(form.total)
  if (total === undefined || total < 205 || total > 805 || total % 10 !== 5) {
    problems.push("The Total is a number from 205 to 805 that ends in 5.")
  }
  for (const [name, text] of [["Quantitative Reasoning", form.quant], ["Verbal Reasoning", form.verbal], ["Data Insights", form.di]]) {
    const score = whole(text!)
    if (score === undefined || score < 60 || score > 90) problems.push(`The ${name} score is a number from 60 to 90.`)
  }
  return problems
}

export const ScoresPage = ({ onSessionLost, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const ids = { date: useId(), total: useId(), quant: useId(), verbal: useId(), di: useId() }
  const [estimates, setEstimates] = useState<ScoreEstimates>()
  const [official, setOfficial] = useState<ReadonlyArray<OfficialScoreView>>()
  const [form, setForm] = useState<Form>(() => blankForm())
  const [problems, setProblems] = useState<ReadonlyArray<string>>([])
  const [saved, setSaved] = useState<string>()
  const busy = useRef(false)

  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "NotUnlocked" ? onSessionLost() : onStopped(failure)),
    [onSessionLost, onStopped]
  )

  const load = useCallback(async () => {
    const [read, listed] = await Promise.all([
      call((client) => client.scores.estimates()),
      call((client) => client.scores.official())
    ])
    if (read._tag === "Failure") return handle(read.failure)
    if (listed._tag === "Failure") return handle(listed.failure)
    setEstimates(read.success)
    setOfficial(listed.success)
    setForm((current) => (current.takenOn === "" ? { ...current, takenOn: read.success.today } : current))
  }, [handle])

  useEffect(() => void load(), [load])

  const change = (changes: Partial<Form>) => {
    setForm((current) => ({ ...current, ...changes }))
    setSaved(undefined)
  }

  const add = async () => {
    const found = formProblems(form)
    setProblems(found)
    setSaved(undefined)
    if (found.length > 0 || busy.current) return
    busy.current = true
    const result = await call((client) =>
      client.scores.addOfficial({
        payload: {
          takenOn: form.takenOn,
          kind: form.kind,
          total: Number(form.total),
          quant: Number(form.quant),
          verbal: Number(form.verbal),
          di: Number(form.di)
        }
      })
    )
    busy.current = false
    if (result._tag === "Failure") {
      if (result.failure._tag === "OfficialScoreInFuture") return setProblems(["That date is still to come."])
      return handle(result.failure)
    }
    setOfficial(result.success)
    setForm(blankForm(estimates?.today))
    const added = result.success.find((each) =>
      each.takenOn === form.takenOn && each.total === Number(form.total) && each.quant === Number(form.quant)
    )
    setSaved(
      added === undefined || added.calibrates.length === 0
        ? "Official Score added. It was taken before your first Score Estimates, so it cannot calibrate them: they come from your answers after it."
        : `Official Score added. Your Score Estimates now follow it in ${
          listed(added.calibrates.map((section) => sectionNames[section] ?? section))
        }.`
    )
    void load()
  }

  const remove = async (id: string) => {
    if (busy.current) return
    busy.current = true
    const result = await call((client) => client.scores.removeOfficial({ params: { id } }))
    busy.current = false
    if (result._tag === "Failure" && result.failure._tag !== "OfficialScoreNotFound") return handle(result.failure)
    void load()
  }

  return (
    <>
      <h1 ref={heading} tabIndex={-1}>Scores</h1>
      <p className="lede">
        Your Score Estimates come from your timed answers, Sectionals and Mocks. Each Official Score you enter lines them
        up with GMAC's scale.
      </p>
      <section className="group" aria-labelledby="estimates-title">
        <h2 id="estimates-title">Score Estimates</h2>
        {estimates === undefined ? <p className="quiet" aria-busy="true">Working out your estimates</p> : estimates.sections
            .length === 0
          ? <p className="empty">No estimate yet. Timed Practice Sets, Sectionals and Mocks give one.</p>
          : (
            <>
              <ul className="score-list">
                {estimates.total !== null && (
                  <li className="score-total">
                    <span className="score-section">Total</span>
                    <span className="score-value">{estimates.total.score}</span>
                    <span className="score-facts">
                      likely {estimates.total.low} to {estimates.total.high}, on the 205 to 805 scale
                      {estimates.total.calibrated ? "" : ", not yet calibrated"}
                    </span>
                  </li>
                )}
                {estimates.sections.map((each) => (
                  <li key={each.section.id}>
                    <span className="score-section">{each.section.name}</span>
                    <span className="score-value">{each.score}</span>
                    <span className="score-facts">
                      likely {each.low} to {each.high}
                      {each.calibrated ? "" : ", not yet calibrated"}
                    </span>
                  </li>
                ))}
              </ul>
              {estimates.total === null && (
                <p className="hint">The Total shows once all three Sections have an estimate.</p>
              )}
            </>
          )}
      </section>
      <section className="group" aria-labelledby="official-title">
        <h2 id="official-title">Official Scores</h2>
        <p className="group-about">
          Scores from official practice exams or the GMAT itself. Each is matched with your estimates as they stood that
          day: one shifts each Section's estimates to match it, and more fit the scale to them.
        </p>
        {official !== undefined && official.length > 0 && (
          <ul className="set-list">
            {official.map((each) => (
              <li key={each.id}>
                <span className="set-name">{each.total}</span>
                <span className="set-facts">
                  {OfficialScoreKindNames[each.kind]}, {dayText(each.takenOn)}: Quantitative {each.quant}, Verbal{" "}
                  {each.verbal}, Data Insights {each.di}. {usedText(each)}.
                </span>
                <button
                  type="button"
                  className="link-button"
                  aria-label={`Remove the ${each.total} from ${dayText(each.takenOn)}`}
                  onClick={() => void remove(each.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="practice-fields">
          <div className="field">
            <label htmlFor={ids.date}>Date taken</label>
            <input
              id={ids.date}
              type="date"
              value={form.takenOn}
              max={estimates?.today}
              onChange={(event) => change({ takenOn: event.target.value })}
            />
          </div>
          <fieldset className="inline-field">
            <legend>Which exam</legend>
            <div className="inline-choices">
              {kinds.map((kind) => (
                <label key={kind} className="inline-choice">
                  <input type="radio" name="official-kind" checked={form.kind === kind} onChange={() => change({ kind })} />
                  {OfficialScoreKindNames[kind]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="score-fields">
            {([
              [ids.total, "Total", "total"],
              [ids.quant, "Quantitative", "quant"],
              [ids.verbal, "Verbal", "verbal"],
              [ids.di, "Data Insights", "di"]
            ] as const).map(([id, label, key]) => (
              <div className="field" key={key}>
                <label htmlFor={id}>{label}</label>
                <input
                  id={id}
                  className="number-input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={form[key]}
                  onChange={(event) => change({ [key]: event.target.value })}
                />
              </div>
            ))}
          </div>
          <div className="actions">
            <button type="button" className="button" onClick={() => void add()}>Add the score</button>
          </div>
        </div>
        {problems.length > 0 && <p className="problem" role="alert">{problems.join(" ")}</p>}
        {saved !== undefined && <p className="saved" role="status">{saved}</p>}
      </section>
    </>
  )
}
