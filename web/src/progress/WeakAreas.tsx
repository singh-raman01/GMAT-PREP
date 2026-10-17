import { useCallback, useState } from "react"
import type { WeakAreaView } from "../../../src/api/Analytics.ts"
import { call } from "../api.ts"
import { navigate } from "../router.ts"
import { levelText, paceText, plural, useReading } from "./reading.ts"

// Weak Areas: the Skills and Question Types that cost the most points, the
// gap below the Section's level times how often the exam asks, each with
// what went wrong and a set that works on it.

const mixText = (area: WeakAreaView) =>
  area.mix.length === 0 ? "" : ` What went wrong: ${area.mix.map((each) => `${each.kind.name} ${each.count}`).join(", ")}.`

// Exam frequency counts a secondary Skill at half, so it is a share of the
// exam's weight rather than of its Questions.
const shareText = (frequency: number) =>
  frequency <= 0
    ? "None of the exam's Questions carry it yet."
    : frequency < 0.005
    ? "It carries under 1% of the exam's weight."
    : `It carries about ${Math.round(frequency * 100)}% of the exam's weight, a secondary Skill counting half.`

export const WeakAreas = ({ onFailure }: { readonly onFailure: (failure: { readonly _tag: string }) => void }) => {
  const read = useCallback(() => call((client) => client.analytics.weakAreas()), [])
  const view = useReading(read, onFailure)
  const [problem, setProblem] = useState<{ readonly id: string; readonly text: string }>()
  // The Weak Area whose set is starting.
  const [starting, setStarting] = useState<string>()

  const practise = async (area: WeakAreaView) => {
    if (starting !== undefined) return
    setStarting(area.ability.scope.id)
    setProblem(undefined)
    const result = await call((client) => client.practice.start({ payload: { choice: area.remedy.choice } }))
    setStarting(undefined)
    if (result._tag === "Success") return navigate(`/practice/${result.success.id}`)
    if (result.failure._tag === "NoQuestionsMatch") {
      return setProblem({
        id: area.ability.scope.id,
        text: result.failure.inSection > 0
          ? "Its Questions are in your Sectional or Mock now. Practise it once that ends."
          : "No Question with it is in the Question Bank to practise now."
      })
    }
    onFailure(result.failure)
  }

  if (view === undefined) return <p className="quiet" aria-busy="true">Working out your Weak Areas</p>
  if (view.ratedResponses === 0) {
    return (
      <p className="empty">
        Weak Areas come from your timed answers to Questions you had not seen. Take a timed Practice Set, a Sectional or
        a Mock, and they show here.
      </p>
    )
  }
  return (
    <>
      <p className="group-about">
        Where you lose the most points: how far each Skill or Question Type sits below your level in its Section, times
        how often the exam asks it, from {plural(view.ratedResponses, "Rated Response", "Rated Responses")}.
      </p>
      {view.areas.length === 0
        ? (
          <p className="empty">
            Nothing sits below your level yet. Skills and Question Types need 8 Rated Responses before they can show
            here.
          </p>
        )
        : (
          <ol className="set-list weak-list">
            {view.areas.map((area) => (
              <li key={`${area.ability.kind}-${area.ability.scope.id}`} data-section={area.ability.section.id}>
                <span className="swatch" aria-hidden="true" />
                <span className="set-name">{area.ability.scope.name}</span>
                <span className="set-facts">
                  {area.ability.kind === "skill" ? "Skill" : "Question Type"}. {levelText(area.ability.gap, area.ability.section.name)},
                  from {plural(area.ability.evidence, "Rated Response", "Rated Responses")}. {shareText(area.frequency)}
                  {area.ability.slow && area.ability.pace !== null ? ` Slow: your right answers take ${paceText(area.ability.pace)}.` : ""}
                  {mixText(area)}
                </span>
                <button
                  type="button"
                  className="button button-quiet"
                  aria-disabled={starting !== undefined}
                  aria-busy={starting === area.ability.scope.id}
                  onClick={() => void practise(area)}
                >
                  {starting === area.ability.scope.id ? "Starting" : `Practise 10${area.remedy.timed ? ", timed" : ""}`}
                  <span className="visually-hidden"> on {area.ability.scope.name}</span>
                </button>
                {problem?.id === area.ability.scope.id && <p className="problem" role="alert">{problem.text}</p>}
              </li>
            ))}
          </ol>
        )}
      <p className="hint measure">
        {view.thin > 0
          ? `${plural(view.thin, "more Skill or Question Type has", "more Skills and Question Types have")} under 8 Rated Responses, not enough to say yet. `
          : ""}
        {view.frequencyBasis === "official"
          ? "How often the exam asks comes from the Books marked official."
          : "How often the exam asks comes from the whole Question Bank, until a Book marked official is added."}
      </p>
    </>
  )
}
