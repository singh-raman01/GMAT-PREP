import { useCallback } from "react"
import { call } from "../api.ts"
import { ColumnChart, Figure } from "../charts/charts.tsx"
import { ticksUpTo } from "../charts/ticks.ts"
import { calendarDay } from "../format.ts"
import { dayNumber, dayOfNumber, percent, plural, shortDay, useReading } from "./reading.ts"

// Study: the time put in each Study Day, the Questions answered and how they
// went by Section, and the Mocks finished.

// The chart shows the last 4 weeks, its minutes on steps of a quarter hour
// or more.
const ChartDays = 28
const MinuteSteps = [15, 30, 60, 120, 240]

const hoursAndMinutes = (minutes: number) => {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return plural(rest, "minute", "minutes")
  return rest === 0 ? plural(hours, "hour", "hours") : `${plural(hours, "hour", "hours")} ${plural(rest, "minute", "minutes")}`
}

export const Study = ({ onFailure }: { readonly onFailure: (failure: { readonly _tag: string }) => void }) => {
  const read = useCallback(() => call((client) => client.analytics.study()), [])
  const view = useReading(read, onFailure)
  if (view === undefined) return <p className="quiet" aria-busy="true">Adding up your study</p>
  if (view.days.length === 0) return <p className="empty">Each Study Day you practise shows here, with its time and how it went.</p>
  const today = dayNumber(view.today)
  const byDay = new Map(view.days.map((day) => [day.day, day] as const))
  const recent = Array.from({ length: ChartDays }, (_, index) => dayOfNumber(today - ChartDays + 1 + index))
  const week = recent.slice(-7).flatMap((day) => (byDay.has(day) ? [byDay.get(day)!] : []))
  const weekMinutes = week.reduce((sum, day) => sum + day.minutes, 0)
  const weekQuestions = week.reduce((sum, day) => sum + day.questions, 0)
  const top = Math.max(30, ...recent.map((day) => byDay.get(day)?.minutes ?? 0))
  return (
    <>
      <p className="group-about">
        {week.length === 0
          ? "Nothing in the last 7 Study Days."
          : `The last 7 Study Days: ${hoursAndMinutes(weekMinutes)} over ${plural(week.length, "day", "days")}, ${plural(weekQuestions, "Question", "Questions")}.`}{" "}
        A Study Day starts at your rollover hour, so late work counts for the day it belongs to.
      </p>
      <Figure
        title="Minutes each Study Day, the last 4 weeks"
        chart={
          <ColumnChart
            description={`Minutes studied each day for the last 4 weeks; ${hoursAndMinutes(
              recent.reduce((sum, day) => sum + (byDay.get(day)?.minutes ?? 0), 0)
            )} in all.`}
            columns={recent.map((day) => ({ key: day, label: shortDay(day), value: byDay.get(day)?.minutes ?? 0 }))}
            yTicks={ticksUpTo(top, MinuteSteps, 5)}
            highlight={view.today}
          />
        }
        numbers={
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Study Day</th>
                <th scope="col" className="number">Minutes</th>
                <th scope="col" className="number">Questions</th>
                <th scope="col">Right, by Section</th>
                <th scope="col" className="number">Mocks</th>
              </tr>
            </thead>
            <tbody>
              {view.days.toReversed().map((day) => (
                <tr key={day.day}>
                  <th scope="row">{calendarDay(day.day)}</th>
                  <td className="number">{day.minutes}</td>
                  <td className="number">{day.questions}</td>
                  <td>
                    {day.sections.length === 0
                      ? "Not shown yet"
                      : day.sections.map((each) => `${each.section.name} ${percent(each.right, each.answered)} of ${each.answered}`).join(", ")}
                  </td>
                  <td className="number">{day.mocks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        }
      />
    </>
  )
}
