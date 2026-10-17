import { useCallback, useEffect, useRef, useState } from "react"
import { type RetriesView, type RetryDue, RetrySetMax } from "../../../src/api/Retries.ts"
import { call } from "../api.ts"
import { calendarDay } from "../format.ts"
import { linkProps, navigate } from "../router.ts"

// Retries on the Practice home: the Retry Ladder steps due today, started as
// a set for each timing, and what falls due over the next week. Hidden while
// nothing is due today or in the next 7 Study Days and no retry set runs.

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

// Steps alike in all the list says, shown as one row with their count.
const groupsOf = (due: ReadonlyArray<RetryDue>) => {
  const groups = new Map<string, { readonly first: RetryDue; count: number }>()
  for (const each of due) {
    const why = each.reasons.includes("wrong") ? "wrong" : each.reasons.includes("slow") ? "slow" : "guessed"
    const key = [each.questionType.id, each.primarySkill?.id, each.step, each.timed, why, each.dueOn].join("|")
    const found = groups.get(key)
    if (found === undefined) groups.set(key, { first: each, count: 1 })
    else found.count += 1
  }
  return [...groups.values()]
}

// Why the entries are on a ladder, what this step serves, and when it fell
// due.
const dueText = (each: RetryDue, count: number, today: string) => {
  const why = each.reasons.includes("wrong") ? "Missed" : each.reasons.includes("slow") ? "Slow" : "Guessed"
  const what = each.step === 1
    ? count === 1 ? "the same Question" : "the same Questions"
    : count === 1
    ? "a Question like it you have not seen"
    : "Questions like them you have not seen"
  const since = each.dueOn < today ? ` Due since ${calendarDay(each.dueOn)}.` : ""
  return `${why}${count === 1 ? "" : `, ${count} Questions`}. Step ${each.step}: ${what}, ${each.timed ? "timed" : "untimed"}.${since}`
}

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
      failure.skipped > 0
        ? `No unseen Question like it was left for ${plural(failure.skipped, "step", "steps")}, so ${
          failure.skipped === 1 ? "it moves" : "they move"
        } on to the next step.`
        : "Nothing is due with that timing now."
    )
    void load()
  }

  if (view === undefined) return null
  const coming = view.upcoming.filter((day) => day.steps > 0)
  if (view.due.length === 0 && view.waiting === 0 && coming.length === 0 && view.running === null) return null
  // A set takes at most RetrySetMax steps, the longest waiting first.
  const untimed = Math.min(view.untimed, RetrySetMax)
  const timed = Math.min(view.timed, RetrySetMax)
  const unlisted = view.untimed + view.timed - view.due.length
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
        ? <p className="quiet">{view.waiting > 0 ? "Nothing is ready today." : "Nothing is due today."}</p>
        : (
          <>
            <ul className="set-list retry-list">
              {groupsOf(view.due).map(({ first, count }) => (
                <li key={`${first.questionId}-${first.step}`} data-section={first.questionType.id.split(".")[0]}>
                  <span className="swatch" aria-hidden="true" />
                  <span className="set-name">
                    {first.questionType.name}
                    {first.primarySkill === null ? "" : `, ${first.primarySkill.name}`}
                  </span>
                  <span className="set-facts">{dueText(first, count, view.today)}</span>
                </li>
              ))}
            </ul>
            {unlisted > 0 && <p className="hint">And {plural(unlisted, "more step", "more steps")} after these.</p>}
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
      {(view.untimed > RetrySetMax || view.timed > RetrySetMax) && (
        <p className="hint">A set takes {RetrySetMax} at most, the longest waiting first.</p>
      )}
      {view.waiting > 0 && (
        <p className="hint">
          {view.waiting === 1
            ? "1 more step waits until its Question can be served again."
            : `${view.waiting} more steps wait until their Questions can be served again.`}
        </p>
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
