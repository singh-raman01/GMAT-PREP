import { useCallback, useEffect, useRef, useState } from "react"
import type { SectionalOptions, SectionalSummary, SectionReadiness } from "../../../src/api/Sectionals.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { dayAndTime } from "../format.ts"
import { linkProps, navigate } from "../router.ts"

// Sectionals: one Section alone, as on the exam. Each Section says whether
// enough unseen Questions are held for Mocks to start one, and what is
// missing when they are not.

interface Props {
  readonly onSessionLost: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export const SectionalsHome = ({ onSessionLost, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const [options, setOptions] = useState<SectionalOptions>()
  const [done, setDone] = useState<ReadonlyArray<SectionalSummary>>()
  const [problem, setProblem] = useState<string>()
  const busy = useRef(false)
  const mounted = useRef(true)

  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "NotUnlocked" ? onSessionLost() : onStopped(failure)),
    [onSessionLost, onStopped]
  )

  const load = useCallback(async () => {
    const [read, listed] = await Promise.all([
      call((client) => client.sectionals.options()),
      call((client) => client.sectionals.list())
    ])
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

  const start = async (section: string) => {
    if (busy.current) return
    busy.current = true
    setProblem(undefined)
    const result = await call((client) => client.sectionals.start({ payload: { section } }))
    busy.current = false
    if (result._tag === "Success") return navigate(`/sectionals/${result.success.id}`)
    switch (result.failure._tag) {
      case "SectionalRunning":
        return navigate(`/sectionals/${result.failure.id}`)
      case "MockRunning":
        return navigate(`/mocks/${result.failure.id}`)
      case "ReserveTooSmall":
        setProblem("Too few unseen Questions are held for Mocks now. The list below says what is missing.")
        return void load()
      default:
        return handle(result.failure)
    }
  }

  const running = options?.running ?? null
  const mock = options?.mock ?? null
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>Sectionals</h1>
      <p className="lede">
        One Section on its own, as on the exam: 45 minutes, Questions that adapt to your answers, and no going back.
        If time is left after the last Question, you can change up to three answers.
      </p>
      {running !== null && (
        <section className="group" aria-labelledby="sectional-running">
          <h2 id="sectional-running">In progress</h2>
          <p>
            <a className="set-name" {...linkProps(`/sectionals/${running}`)}>Go back to your Sectional</a>
          </p>
          <p className="hint">Its clock keeps running while you are away, and the Section ends when time is up.</p>
        </section>
      )}
      {mock !== null && (
        <section className="group" aria-labelledby="sectional-mock">
          <h2 id="sectional-mock">Mock in progress</h2>
          <p>
            <a className="set-name" {...linkProps(`/mocks/${mock}`)}>Go back to your Mock</a>
          </p>
          <p className="hint">A Sectional can start once the Mock is over.</p>
        </section>
      )}
      <section className="group" aria-labelledby="sectional-start">
        <h2 id="sectional-start">Start a Sectional</h2>
        {options === undefined ? <p className="quiet" aria-busy="true">Checking what each Section holds</p> : (
          <ul className="section-starts">
            {options.sections.map((readiness) => (
              <SectionStart
                key={readiness.section.id}
                readiness={readiness}
                blocked={running !== null || mock !== null}
                onStart={() => void start(readiness.section.id)}
              />
            ))}
          </ul>
        )}
        {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
      </section>
      {done !== undefined && done.length > 0 && (
        <section className="group" aria-labelledby="sectional-done">
          <h2 id="sectional-done">Finished Sectionals</h2>
          <ul className="set-list">
            {done.map((each) => (
              <li key={each.id}>
                <a className="set-name" {...linkProps(`/sectionals/${each.id}`)}>{each.section.name}</a>
                <span className="set-facts">
                  {each.score === null ? "No score" : `${each.score}, likely ${each.low} to ${each.high}`},{" "}
                  {dayAndTime(each.finishedAt ?? each.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

const SectionStart = (
  { readiness, blocked, onStart }: {
    readonly readiness: SectionReadiness
    readonly blocked: boolean
    readonly onStart: () => void
  }
) => {
  const short = readiness.groups.filter((group) => group.unseen < group.needed)
  return (
    <li className="section-start" data-section={readiness.section.id}>
      <div className="section-start-head">
        <span className="swatch" aria-hidden="true" />
        <span className="section-start-name">{readiness.section.name}</span>
        <span className="set-facts">
          {plural(readiness.questions, "Question", "Questions")}, {readiness.minutes} minutes
        </span>
        {readiness.ready && (
          <button
            type="button"
            className="button"
            disabled={blocked}
            aria-label={`Start a ${readiness.section.name} Sectional`}
            onClick={onStart}
          >
            Start
          </button>
        )}
      </div>
      {!readiness.ready && (
        <div className="section-short">
          <p>Not enough unseen Questions are held for Mocks yet. A start needs twice the Section's count:</p>
          <ul>
            {short.map((group) => (
              <li key={group.group.id}>
                {group.group.name}: {group.unseen} of the {group.needed} needed (Easy {group.byBand.easy}, Medium{" "}
                {group.byBand.medium}, Hard {group.byBand.hard})
              </li>
            ))}
          </ul>
          <p className="hint">
            The app holds back a quarter of each Book's Questions, and of each batch the Curator generates, for Mocks and
            Sectionals, so more Books add more.
          </p>
        </div>
      )}
    </li>
  )
}
