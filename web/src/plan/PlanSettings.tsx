import { useId, useMemo, useRef, useState } from "react"
import type { PlanView } from "../../../src/api/Plan.ts"
import { call } from "../api.ts"
import { dayAndTime, hoursAndMinutes, longDay } from "../format.ts"

// The Study Plan's settings (decisions 81 and 92): the test date, the
// target Total, weekly time, days off, and the Profile's time zone and
// rollover hour, a change to which waits for the next rollover.

interface Props {
  readonly plan: PlanView
  readonly onSaved: (plan: PlanView) => void
  readonly onFailure: (failure: { readonly _tag: string }) => void
}

// Monday first, as a week is read.
const Weekdays = [
  { day: 1, name: "Monday" },
  { day: 2, name: "Tuesday" },
  { day: 3, name: "Wednesday" },
  { day: 4, name: "Thursday" },
  { day: 5, name: "Friday" },
  { day: 6, name: "Saturday" },
  { day: 0, name: "Sunday" }
] as const

const hourName = (hour: number) =>
  hour === 0 ? "Midnight" : hour === 12 ? "Noon" : hour < 12 ? `${hour} am` : `${hour - 12} pm`

const zones = (() => {
  try {
    return Intl.supportedValuesOf("timeZone")
  } catch {
    return []
  }
})()

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

interface Form {
  readonly testDate: string
  readonly target: string
  readonly hours: string
  readonly daysOff: ReadonlyArray<number>
  readonly timeZone: string
  readonly rolloverHour: number
}

const formOf = (plan: PlanView): Form => ({
  testDate: plan.settings?.testDate ?? "",
  target: plan.settings?.targetTotal === null || plan.settings === null ? "" : String(plan.settings.targetTotal),
  hours: plan.settings === null ? "10" : String(Math.round((plan.settings.weeklyMinutes / 60) * 100) / 100),
  daysOff: plan.settings?.daysOff ?? [0],
  timeZone: plan.days.pending?.timeZone ?? plan.days.timeZone,
  rolloverHour: plan.days.pending?.rolloverHour ?? plan.days.rolloverHour
})

type Field = "testDate" | "target" | "hours" | "daysOff"

export const PlanSettingsForm = ({ plan, onSaved, onFailure }: Props) => {
  const ids = { testDate: useId(), target: useId(), hours: useId(), zone: useId(), rollover: useId() }
  const [form, setForm] = useState<Form>(() => formOf(plan))
  const [problems, setProblems] = useState<ReadonlyArray<{ readonly field: Field | "form"; readonly text: string }>>([])
  const [saved, setSaved] = useState<string>()
  const busy = useRef(false)
  const zoneChoices = useMemo(() => (zones.includes(form.timeZone) ? zones : [form.timeZone, ...zones]), [form.timeZone])
  const change = (next: Partial<Form>) => {
    setForm((current) => ({ ...current, ...next }))
    setSaved(undefined)
  }
  const problemOf = (field: Field) => problems.find((each) => each.field === field)

  const save = async () => {
    if (busy.current) return
    const found: Array<{ readonly field: Field | "form"; readonly text: string }> = []
    const hours = Number(form.hours.replace(",", "."))
    if (!Number.isFinite(hours) || hours < 1 || hours > 60) found.push({ field: "hours", text: "Give the hours a week as a number from 1 to 60." })
    const target = form.target.trim() === "" ? null : Number(form.target)
    if (target !== null && (!Number.isInteger(target) || target < 205 || target > 805)) {
      found.push({ field: "target", text: "Give the target as a Total from 205 to 805, or leave it empty." })
    }
    if (form.testDate !== "" && form.testDate <= plan.today) found.push({ field: "testDate", text: "Choose a test date after today." })
    if (form.daysOff.length >= 7) found.push({ field: "daysOff", text: "Keep at least one day of the week for study." })
    setProblems(found)
    if (found.length > 0) return
    busy.current = true
    const result = await call((client) =>
      client.plan.saveSettings({
        payload: {
          testDate: form.testDate === "" ? null : form.testDate,
          targetTotal: target,
          weeklyMinutes: Math.round(hours * 60),
          daysOff: [...form.daysOff],
          timeZone: form.timeZone,
          rolloverHour: form.rolloverHour
        }
      })
    )
    busy.current = false
    if (result._tag === "Success") {
      setSaved(plan.settings === null ? undefined : "Saved. The plan is made again from today.")
      return onSaved(result.success)
    }
    if (result.failure._tag === "PlanSettingsInvalid") {
      return setProblems(result.failure.problems.map((text) => ({ field: "form", text })))
    }
    if (result.failure._tag === "InvalidTimeZone") {
      return setProblems([{ field: "form", text: `This browser's time zone list has no ${result.failure.timeZone}. Choose another.` }])
    }
    onFailure(result.failure)
  }

  const describedBy = (field: Field, hint?: string) =>
    [problemOf(field) === undefined ? undefined : `${field}-error`, hint].filter((each) => each !== undefined).join(" ") ||
    undefined
  const fieldError = (field: Field) => {
    const problem = problemOf(field)
    return problem === undefined ? null : <p id={`${field}-error`} className="field-error">{problem.text}</p>
  }

  return (
    <form
      className="plan-settings"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <div className="field">
        <label htmlFor={ids.testDate}>Test date</label>
        <p id={`${ids.testDate}-hint`} className="hint">Leave it empty to plan two weeks at a time.</p>
        <input
          id={ids.testDate}
          type="date"
          value={form.testDate}
          min={nextDay(plan.today)}
          aria-invalid={problemOf("testDate") !== undefined}
          aria-describedby={describedBy("testDate", `${ids.testDate}-hint`)}
          onChange={(event) => change({ testDate: event.target.value })}
        />
        {fieldError("testDate")}
      </div>
      <div className="field">
        <label htmlFor={ids.target}>Target Total</label>
        <p id={`${ids.target}-hint`} className="hint">From 205 to 805. Each Section's target is the score that, in all three, reaches it.</p>
        <input
          id={ids.target}
          className="number-input"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={form.target}
          aria-invalid={problemOf("target") !== undefined}
          aria-describedby={describedBy("target", `${ids.target}-hint`)}
          onChange={(event) => change({ target: event.target.value })}
        />
        {fieldError("target")}
      </div>
      <div className="field">
        <label htmlFor={ids.hours}>Hours of study a week</label>
        <p id={`${ids.hours}-hint`} className="hint">A Mock takes 2 hours 25 minutes; under that, Mock weeks get Sectionals.</p>
        <input
          id={ids.hours}
          className="number-input"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={form.hours}
          aria-invalid={problemOf("hours") !== undefined}
          aria-describedby={describedBy("hours", `${ids.hours}-hint`)}
          onChange={(event) => change({ hours: event.target.value })}
        />
        {fieldError("hours")}
      </div>
      <fieldset className="inline-field" aria-describedby={problemOf("daysOff") === undefined ? undefined : "daysOff-error"}>
        <legend>Days off</legend>
        <div className="inline-choices">
          {Weekdays.map(({ day, name }) => (
            <label key={day} className="inline-choice">
              <input
                type="checkbox"
                checked={form.daysOff.includes(day)}
                onChange={(event) =>
                  change({ daysOff: event.target.checked ? [...form.daysOff, day] : form.daysOff.filter((each) => each !== day) })}
              />
              {name}
            </label>
          ))}
        </div>
        {fieldError("daysOff")}
      </fieldset>
      <div className="field">
        <label htmlFor={ids.zone}>Time zone</label>
        <p id={`${ids.zone}-hint`} className="hint">A change takes effect at your next rollover, so no Study Day is cut in two.</p>
        <select
          id={ids.zone}
          value={form.timeZone}
          aria-describedby={`${ids.zone}-hint`}
          onChange={(event) => change({ timeZone: event.target.value })}
        >
          {zoneChoices.map((zone) => <option key={zone} value={zone}>{zone.replaceAll("_", " ")}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor={ids.rollover}>A Study Day starts at</label>
        <select
          id={ids.rollover}
          value={form.rolloverHour}
          onChange={(event) => change({ rolloverHour: Number(event.target.value) })}
        >
          {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{hourName(hour)}</option>)}
        </select>
      </div>
      {plan.days.pending !== null && (
        <p className="hint">
          From your next rollover, {dayAndTime(plan.days.pending.from, plan.days.timeZone)}, your Study Days run in{" "}
          {plan.days.pending.timeZone.replaceAll("_", " ")} and start at {hourName(plan.days.pending.rolloverHour).toLowerCase()}.
        </p>
      )}
      {problems.some((each) => each.field === "form") && (
        <p className="problem" role="alert">{problems.filter((each) => each.field === "form").map((each) => each.text).join(" ")}</p>
      )}
      <div className="actions">
        <button type="submit" className="button">{plan.settings === null ? "Make my plan" : "Save the settings"}</button>
      </div>
      {saved !== undefined && <p className="saved" role="status">{saved}</p>}
      {plan.settings !== null && (
        <p className="hint">
          {hoursAndMinutes(plan.settings.weeklyMinutes)} a week now
          {plan.settings.testDate === null ? ", with no test date." : `, for a test on ${longDay(plan.settings.testDate)}.`}
        </p>
      )}
    </form>
  )
}
