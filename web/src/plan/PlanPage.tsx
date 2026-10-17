import { type RefObject, useCallback, useEffect, useId, useRef, useState } from "react"
import type { PlanDayView, PlanItemView, PlanView } from "../../../src/api/Plan.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { calendarDay, hoursAndMinutes, longDay } from "../format.ts"
import { linkProps, navigate } from "../router.ts"
import { lessonPath } from "../lessons/paths.ts"
import { DailyLog } from "./DailyLog.tsx"
import { PlanSettingsForm } from "./PlanSettings.tsx"

// The Study Plan (docs/design.md, "Study Plan, Diagnostic and Daily Log"):
// today's work with a button to start each item, the days ahead with what
// did not fit, the Daily Log, and the plan's settings.

interface Props {
  readonly path: string
  readonly onSessionLost: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

const views = [
  { id: "today", name: "Today", path: "/plan" },
  { id: "ahead", name: "The days ahead", path: "/plan/ahead" },
  { id: "log", name: "Daily Log", path: "/plan/log" },
  { id: "settings", name: "Settings", path: "/plan/settings" }
] as const

const phaseNames: Record<PlanDayView["phase"], string> = {
  "diagnostic": "the Diagnostic",
  "weak-areas": "Weak Area work",
  "mixed": "mixed practice",
  "mocks": "a Mock week"
}

// The plan is read again when the page comes back into view, and every few
// minutes while it is shown, so a page left open sees a new Study Day.
const RereadMs = 5 * 60_000

// The weekly time a Mock needs, in minutes.
const MockMinutes = 145

// A Weak Area day with no Weak Area to work on yet is mixed practice; a day
// whose sets are not planned yet says so, unless its Mock or Sectional takes
// all of it.
const dayAbout = (day: PlanDayView) => {
  if (day.off) return "A day off."
  const whole = day.items.some((item) => (item.kind === "mock" || item.kind === "sectional") && item.minutes >= day.minutes)
  if (!day.setsPlanned && !whole) {
    return `${hoursAndMinutes(day.minutes)} planned, for ${phaseNames[day.phase]}. Its sets are planned nearer the day.`
  }
  if (!day.setsPlanned) return `${hoursAndMinutes(day.minutes)} planned, for ${phaseNames[day.phase]}.`
  const phase = day.phase === "weak-areas" && !day.items.some((item) => item.weakArea !== null) ? "mixed" : day.phase
  return `${hoursAndMinutes(day.minutes)} planned, for ${phaseNames[phase]}.`
}

export const PlanPage = ({ path, onSessionLost, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const todayHeading = useRef<HTMLHeadingElement>(null)
  const [plan, setPlan] = useState<PlanView>()
  const [made, setMade] = useState(false)
  const view = views.find((each) => each.path === path) ?? views[0]
  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "NotUnlocked" ? onSessionLost() : onStopped(failure)),
    [onSessionLost, onStopped]
  )
  const load = useCallback(async (background = false) => {
    const result = await call((client) => client.plan.view(), { background })
    if (result._tag === "Failure") return handle(result.failure)
    setPlan(result.success)
  }, [handle])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    const reread = () => {
      if (document.visibilityState === "visible") void load()
    }
    // The timed re-read is the page's own, so it leaves the unlock to end
    // after its 12 hours without use.
    const timed = () => {
      if (document.visibilityState === "visible") void load(true)
    }
    document.addEventListener("visibilitychange", reread)
    const timer = window.setInterval(timed, RereadMs)
    return () => {
      document.removeEventListener("visibilitychange", reread)
      window.clearInterval(timer)
    }
  }, [load])
  // Once the first plan is made, focus moves to its day.
  useEffect(() => {
    if (!made) return
    todayHeading.current?.focus()
    setMade(false)
  }, [made])

  return (
    <>
      <h1 ref={heading} tabIndex={-1}>Study Plan</h1>
      {plan === undefined
        ? <p className="quiet" aria-busy="true">Making your plan</p>
        : (
          <>
            <nav className="viewnav" aria-label="Plan views">
              {views.map((each) => (
                <a key={each.id} {...linkProps(each.path)} aria-current={each.id === view.id ? "page" : undefined}>
                  <span className={each.id === view.id ? "mark" : undefined}>{each.name}</span>
                </a>
              ))}
            </nav>
            {view.id === "log"
              ? <DailyLog onFailure={handle} />
              : view.id === "settings"
              ? (
                <PlanSettingsForm
                  plan={plan}
                  onSaved={(saved) => {
                    // The first plan is shown at once, on Today.
                    const first = plan.settings === null
                    setPlan(saved)
                    if (first) {
                      navigate("/plan")
                      setMade(true)
                    }
                  }}
                  onFailure={handle}
                />
              )
              : plan.settings === null
              ? (
                <>
                  <p className="lede">
                    Say when your test is and how much time you have, and the plan sets out each Study Day: a Diagnostic
                    first, then your Weak Areas, mixed practice, due Retries and, near the test, a Mock a week.
                  </p>
                  <PlanSettingsForm
                    plan={plan}
                    onSaved={(saved) => {
                      setPlan(saved)
                      if (view.id === "ahead") navigate("/plan")
                      setMade(true)
                    }}
                    onFailure={handle}
                  />
                </>
              )
              : view.id === "today"
              ? <Today plan={plan} heading={todayHeading} onPlan={setPlan} onReload={() => load()} onFailure={handle} />
              : <DaysAhead plan={plan} />}
          </>
        )}
    </>
  )
}

// The Section orders a Mock can take, the plan's own first.
const orders = (ids: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> =>
  ids.length <= 1 ? [ids] : ids.flatMap((id) => orders(ids.filter((other) => other !== id)).map((rest) => [id, ...rest]))
const SectionNames: Readonly<Record<string, string>> = { quant: "Quantitative", verbal: "Verbal", di: "Data Insights" }

const forText = (item: PlanItemView, today: boolean) => {
  if (item.diagnostic) return "Shows where each Section starts, and counts as your first Mock."
  if (item.kind === "mock") return "One of your Mock weeks."
  if (item.kind === "sectional") return "In place of a Mock, as your weekly time is under one."
  if (item.kind === "retries") return today ? "Questions you missed, due back today." : "Questions you missed, due back by that day."
  if (item.kind === "lesson") {
    const area = item.weakArea?.scope.name ?? item.lesson?.subject.name ?? "a Weak Area"
    return item.lesson?.part === "methods"
      ? `For ${area}, a Weak Area whose misses most often take the wrong approach: its Lesson's ways to solve it.`
      : `For ${area}, a Weak Area whose misses are most often a concept gap: its Lesson, then the Lesson's 5-Question check.`
  }
  if (item.weakArea === null) return `Mixed practice in ${item.section?.name ?? "a Section"}.`
  const area = item.weakArea.scope.name
  const section = item.section?.name ?? "its Section"
  if (item.remedy?.id === "trap") {
    return item.trapPattern === null
      ? `For ${area}, a Weak Area whose misses are most often traps.`
      : `For ${area}, a Weak Area whose misses are most often traps: Questions in ${section} that set the same trap.`
  }
  if (item.remedy?.id === "slow") return `For ${area}, a Weak Area where right answers come slowly.`
  return `For ${area}, a Weak Area.${item.remedy === null ? "" : ` Most often: ${item.remedy.name.toLowerCase()}.`}`
}

const ItemRow = (
  { item, today, onPlan, onReload, onNotice, onFailure }: {
    readonly item: PlanItemView
    readonly today: boolean
    readonly onPlan: (plan: PlanView) => void
    readonly onReload: () => Promise<void>
    // A message for the day as a whole, for when this row may be gone.
    readonly onNotice: (notice: string) => void
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const orderId = useId()
  const [order, setOrder] = useState<ReadonlyArray<string>>(["quant", "verbal", "di"])
  const [problem, setProblem] = useState<string>()
  const busy = useRef(false)

  const start = async () => {
    if (busy.current) return
    busy.current = true
    setProblem(undefined)
    const result = await call((client) =>
      client.plan.start({ params: { id: item.id }, payload: item.kind === "mock" ? { order: [...order] } : {} })
    )
    busy.current = false
    if (result._tag === "Success") {
      const where = result.success.kind === "mock" ? "mocks" : result.success.kind === "sectional" ? "sectionals" : "practice"
      return navigate(`/${where}/${result.success.id}`)
    }
    const failure = result.failure
    switch (failure._tag) {
      case "PlanItemNotOpen":
        onPlan(failure.plan)
        return onNotice("Your plan changed while this page was open, so nothing started. Here is the plan as it stands.")
      case "NoQuestionsMatch":
        return setProblem("No Question is left for this set. Practise something else today, or add a Book with more.")
      case "NoRetriesDue":
        void onReload()
        return onNotice("No Retries are due now: they were taken, or are waiting for a running Sectional or Mock.")
      case "RetriesRunning":
        return navigate(`/practice/${failure.id}`)
      case "SectionalRunning":
        return navigate(`/sectionals/${failure.id}`)
      case "MockRunning":
        return navigate(`/mocks/${failure.id}`)
      case "ReserveTooSmall":
      case "MockReserveTooSmall":
        return setProblem("Too few unseen Questions are held for Mocks now. The plan counts on the next Mock once there are more.")
      default:
        return onFailure(failure)
    }
  }

  const goBack = () => {
    if (item.sessionId === null) return
    navigate(`/${item.kind === "mock" ? "mocks" : item.kind === "sectional" ? "sectionals" : "practice"}/${item.sessionId}`)
  }

  return (
    <li className={`plan-item plan-item-${item.status}`}>
      <span className="set-name">{item.status === "done" ? <span className="mark">{item.title}</span> : item.title}</span>
      <span className="set-facts">
        {hoursAndMinutes(item.minutes)}. {forText(item, today)}
        {item.status === "done" ? " Done." : ""}
      </span>
      {today && item.status === "planned" && item.kind === "mock" && (
        <label className="plan-order" htmlFor={orderId}>
          <span>Section order</span>
          <select id={orderId} value={order.join(",")} onChange={(event) => setOrder(event.target.value.split(","))}>
            {orders(["quant", "verbal", "di"]).map((each) => (
              <option key={each.join(",")} value={each.join(",")}>{each.map((id) => SectionNames[id]).join(", ")}</option>
            ))}
          </select>
        </label>
      )}
      {today && item.kind === "lesson" && item.lesson !== null && (item.status === "planned" || item.status === "started") && (
        <a className="button button-quiet" {...linkProps(`${lessonPath(item.lesson.subject.id, item.lesson.part)}?item=${item.id}`)}>
          {item.status === "planned" ? "Read it" : "Go back to it"}
          <span className="visually-hidden">: {item.title}</span>
        </a>
      )}
      {today && item.kind !== "lesson" && item.status === "planned" && (
        <button type="button" className="button button-quiet" onClick={() => void start()}>
          Start<span className="visually-hidden"> {item.title}</span>
        </button>
      )}
      {item.kind !== "lesson" && item.status === "started" && (
        <button type="button" className="button button-quiet" onClick={goBack}>
          Go back to it<span className="visually-hidden">: {item.title}</span>
        </button>
      )}
      {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
    </li>
  )
}

// Where the Diagnostic stands in the plan: today, a later day, or dropped
// with the reason.
const diagnosticWhere = (plan: PlanView) => {
  const items = plan.plan.flatMap((day) => day.items)
  if (items.some((item) => item.diagnostic && item.status === "started")) return "Part of it is under way; go back to it from today's list."
  const next = items.find((item) => item.diagnostic && item.status === "planned")
  if (next !== undefined) return next.day === plan.today ? "It is on today's plan." : `It is planned for ${longDay(next.day)}.`
  const dropped = plan.dropped.find((item) => item.diagnostic)
  return dropped === undefined ? "" : `It could not be planned: ${dropped.reason}`
}

const DiagnosticPanel = (
  { plan, onSkipped, onFailure }: {
    readonly plan: PlanView
    readonly onSkipped: (plan: PlanView) => void
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const [asking, setAsking] = useState(false)
  const [problem, setProblem] = useState<string>()
  const skipButton = useRef<HTMLButtonElement>(null)
  const keepButton = useRef<HTMLButtonElement>(null)
  const busy = useRef(false)
  useEffect(() => {
    if (asking) keepButton.current?.focus()
  }, [asking])
  const skip = async () => {
    if (busy.current) return
    busy.current = true
    const result = await call((client) => client.plan.skipDiagnostic())
    busy.current = false
    if (result._tag === "Failure") {
      if (result.failure._tag === "NotUnlocked") return onFailure(result.failure)
      return setProblem("The Diagnostic was not skipped. Try again.")
    }
    onSkipped(result.success)
  }
  const keep = () => {
    setAsking(false)
    window.requestAnimationFrame(() => skipButton.current?.focus())
  }
  const left = plan.diagnostic.sectionsLeft.map((section) => section.name).join(", ")
  const stillToTake = left === "" ? "" : `: ${left} still to take`
  const where = diagnosticWhere(plan)
  return (
    <section className="group plan-diagnostic" aria-labelledby="diagnostic-title">
      <h2 id="diagnostic-title">The Diagnostic</h2>
      <p className="group-about">
        {plan.diagnostic.form === "mock"
          ? "A full Mock shows where each Section starts, so your practice is pitched where about two in three come out right."
          : (plan.settings?.weeklyMinutes ?? 0) < MockMinutes
          ? `Your weekly time is under a Mock, so the Diagnostic is the three Sectionals, one a day${stillToTake}.`
          : `You began the Diagnostic as Sectionals, so it goes on one a day${stillToTake}.`}
        {where === "" ? "" : ` ${where}`} Skip it and each Section starts at Medium until it has 20 Rated Responses.
      </p>
      {asking
        ? (
          <div className="plan-confirm" role="group" aria-labelledby="skip-question">
            <p id="skip-question">Skip the Diagnostic for good? The plan will not offer it again.</p>
            <div className="actions">
              <button type="button" className="button" onClick={() => void skip()}>Skip it</button>
              <button ref={keepButton} type="button" className="button button-quiet" onClick={keep}>Keep it</button>
            </div>
          </div>
        )
        : (
          <div className="actions">
            <button ref={skipButton} type="button" className="button button-quiet" onClick={() => setAsking(true)}>
              Skip the Diagnostic
            </button>
          </div>
        )}
      {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
    </section>
  )
}

const Today = (
  { plan, heading, onPlan, onReload, onFailure }: {
    readonly plan: PlanView
    readonly heading: RefObject<HTMLHeadingElement | null>
    readonly onPlan: (plan: PlanView) => void
    readonly onReload: () => Promise<void>
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const day = plan.plan.find((each) => each.day === plan.today)
  const [notice, setNotice] = useState<string>()
  const done = day?.items.filter((item) => item.status === "done").length ?? 0
  const noticed = (text: string) => {
    setNotice(text)
    heading.current?.focus()
  }
  return (
    <>
      {plan.diagnostic.state === "pending" && (
        <DiagnosticPanel
          plan={plan}
          onSkipped={(skipped) => {
            onPlan(skipped)
            heading.current?.focus()
          }}
          onFailure={onFailure}
        />
      )}
      <section className="group" aria-labelledby="today-title">
        <h2 id="today-title" ref={heading} tabIndex={-1}>Today, {longDay(plan.today)}</h2>
        <div role="status">{notice !== undefined && <p className="problem">{notice}</p>}</div>
        {day === undefined
          ? <p className="empty">Nothing is planned for today.</p>
          : (
            <>
              <p className="group-about">
                {dayAbout(day)}
                {day.items.length > 0 && done > 0 ? ` ${done} of ${day.items.length} done.` : ""}
              </p>
              {day.items.length === 0
                ? <p className="empty">{day.off ? "Rest, or practise anything you like." : "Today's time is used up."}</p>
                : (
                  <ol className="set-list plan-items">
                    {day.items.map((item) => (
                      <ItemRow
                        key={item.id}
                        item={item}
                        today
                        onPlan={onPlan}
                        onReload={onReload}
                        onNotice={noticed}
                        onFailure={onFailure}
                      />
                    ))}
                  </ol>
                )}
            </>
          )}
        {plan.notes.map((note) => <p key={note} className="hint measure">{note}</p>)}
      </section>
      {plan.targets !== null && (
        <section className="group" aria-labelledby="targets-title">
          <h2 id="targets-title">Targets</h2>
          <p className="group-about">
            A Total of {plan.targets.total} takes about {plan.targets.sections[0]?.target ?? 0} in each Section.{" "}
            <a {...linkProps("/scores")}>Your Score Estimates</a> say where you stand.
          </p>
          <ul className="set-list">
            {plan.targets.sections.map((each) => (
              <li key={each.section.id}>
                <span className="set-name">{each.section.name}</span>
                <span className="set-facts">
                  {each.estimate === null
                    ? `Target ${each.target}; no estimate yet.`
                    : each.estimate >= each.target
                    ? `At ${each.estimate}, on or past the target of ${each.target}.`
                    : `At ${each.estimate}, ${each.target - each.estimate} below the target of ${each.target}.`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

// The days ahead show a week at first, the rest on request.
const FirstDays = 7

const DaysAhead = ({ plan }: { readonly plan: PlanView }) => {
  const ahead = plan.plan.filter((day) => day.day > plan.today)
  const [all, setAll] = useState(false)
  const shown = all ? ahead : ahead.slice(0, FirstDays)
  const events = ahead.flatMap((day) => day.items.filter((item) => item.kind === "mock" || item.kind === "sectional"))
  return (
    <>
      {events.length > 0 && (
        <p className="group-about">
          {events.map((item) => `${item.title} on ${longDay(item.day)}`).join("; ")}.
        </p>
      )}
      {ahead.length === 0
        ? <p className="empty">No days are planned after today.</p>
        : shown.map((day) => (
          <section key={day.day} className="group plan-day" aria-labelledby={`day-${day.day}`}>
            <h2 id={`day-${day.day}`} tabIndex={-1}>{longDay(day.day)}</h2>
            <p className="group-about">{dayAbout(day)}</p>
            {day.items.length > 0 && (
              <ol className="set-list plan-items">
                {day.items.map((item) => (
                  <li key={item.id} className="plan-item">
                    <span className="set-name">{item.title}</span>
                    <span className="set-facts">{hoursAndMinutes(item.minutes)}. {forText(item, false)}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        ))}
      {shown.length < ahead.length && (
        <div className="actions plan-more">
          <button
            type="button"
            className="button button-quiet"
            onClick={() => {
              setAll(true)
              // Focus moves to the first day shown now, as the button goes.
              const first = ahead[FirstDays]
              window.requestAnimationFrame(() => document.getElementById(`day-${first?.day}`)?.focus())
            }}
          >
            Show the other {ahead.length - shown.length} days
          </button>
        </div>
      )}
      <section className="group" aria-labelledby="dropped-title">
        <h2 id="dropped-title">What did not fit</h2>
        {plan.dropped.length === 0
          ? <p className="quiet">Everything the plan wanted fits your time.</p>
          : (
            <>
              <p className="group-about">The plan drops work it has no time for, the lowest first, rather than pile it onto later days.</p>
              <ul className="set-list">
                {plan.dropped.map((item) => (
                  <li key={item.id}>
                    <span className="set-name">{item.title}</span>
                    <span className="set-facts">{calendarDay(item.day)}. {item.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        {plan.notes.map((note) => <p key={note} className="hint measure">{note}</p>)}
      </section>
    </>
  )
}
