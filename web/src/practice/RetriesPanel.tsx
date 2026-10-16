import { useCallback, useEffect, useRef, useState } from "react"
import type { RetriesView, RetryDue } from "../../../src/api/Retries.ts"
import { call } from "../api.ts"
import { calendarDay } from "../format.ts"
import { linkProps, navigate } from "../router.ts"

// Retries on the Practice home: the Retry Ladder steps due today, started as
// one set for each timing, and what falls due over the next week. Hidden
// while the Learner has nothing on a ladder.

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const stepText = (each: RetryDue) =>
  each.step === 1
    ? `Step 1, the same Question, ${each.timed ? "timed, as it was slow" : "untimed"}`
    : `Step ${each.step}, a Question like it you have not seen, timed`

const whyText = (each: RetryDue) =>
  each.reasons.includes("wrong") ? "missed" : each.reasons.includes("slow") ? "slow" : "guessed"

export const RetriesPanel = ({ onFailure }: { readonly onFailure: (failure: { readonly _tag: string }) => void }) => {
  const [view, setView] = useState<RetriesView>()
  const [problem, setProblem] = useState<string>()
  const busy = useRef(false)
  const mounted = useRef(true)

  const load = useCallback(async () => {
    const result = await call((client) => client.retries.due())
    if (!mounted.current) return
    if (result._tag === "Failure") return onFailure(result.failure)
    setView(result.success)
  }, [onFailure])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
    }
  }, [load])

  const start = async (timed: boolean) => {
    if (busy.current) return
    busy.current = true
    setProblem(undefined)
    const result = await call((client) => client.retries.start({ payload: { timed } }))
    busy.current = false
    if (result._tag === "Success") return navigate(`/practice/${result.success.id}`)
    const failure = result.failure
    if (failure._tag === "RetriesRunning") return navigate(`/practice/${failure.id}`)
    if (failure._tag !== "NoRetriesDue") return onFailure(failure)
    setProblem(
      [
        failure.skipped > 0
          ? `No unseen Question like it was left for ${plural(failure.skipped, "step", "steps")}, so ${
            failure.skipped === 1 ? "it moves" : "they move"
          } on to the next step.`
          : "",
        failure.held > 0
          ? `${plural(failure.held, "Question waits", "Questions wait")} for your Sectional or Mock to end.`
          : "",
        failure.skipped === 0 && failure.held === 0 ? "Nothing is due with that timing now." : ""
      ].filter((line) => line !== "").join(" ")
    )
    void load()
  }

  if (view === undefined) return null
  const coming = view.upcoming.filter((day) => day.steps > 0)
  if (view.due.length === 0 && coming.length === 0 && view.running === null) return null
  // A step waiting for a running Sectional or Mock is not started.
  const untimed = view.due.filter((each) => !each.timed && !each.held).length
  const timed = view.due.filter((each) => each.timed && !each.held).length
  return (
    <section className="group retries" aria-labelledby="retries-title">
      <h2 id="retries-title">Retries</h2>
      <p className="group-about">
        A Question you missed comes back 2, 7 and 21 Study Days later: first the Question itself, then two like it you
        have not seen. Get all three right and its Error Log entry is resolved.
      </p>
      {view.running !== null && (
        <p>
          <a className="set-name" {...linkProps(`/practice/${view.running}`)}>Go back to your retry set</a>
        </p>
      )}
      {view.due.length === 0
        ? <p className="quiet">Nothing is due today.</p>
        : (
          <>
            <ul className="set-list retry-list">
              {view.due.map((each) => (
                <li key={`${each.questionId}-${each.step}`} data-section={each.questionType.id.split(".")[0]}>
                  <span className="swatch" aria-hidden="true" />
                  <span className="set-name">
                    {each.questionType.name}
                    {each.primarySkill === null ? "" : `, ${each.primarySkill.name}`}
                  </span>
                  <span className="set-facts">
                    {stepText(each)}; {whyText(each)}
                    {each.dueOn < view.today ? `, due since ${calendarDay(each.dueOn)}` : ""}
                    {each.held ? ". Waits for your Sectional or Mock to end" : ""}.
                  </span>
                </li>
              ))}
            </ul>
            {view.running === null && (untimed > 0 || timed > 0) && (
              <div className="actions">
                {untimed > 0 && (
                  <button type="button" className="button" onClick={() => void start(false)}>
                    Start {plural(untimed, "untimed retry", "untimed retries")}
                  </button>
                )}
                {timed > 0 && (
                  <button type="button" className={untimed > 0 ? "button button-quiet" : "button"} onClick={() => void start(true)}>
                    Start {plural(timed, "timed retry", "timed retries")}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
      {coming.length > 0 && (
        <p className="hint">
          Coming up: {coming.map((day) => `${calendarDay(day.day)}, ${plural(day.steps, "step", "steps")}`).join("; ")}.
        </p>
      )}
    </section>
  )
}
