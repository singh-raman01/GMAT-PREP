import { useCallback } from "react"
import type { MistakeTrendView } from "../../../src/api/Analytics.ts"
import { call } from "../api.ts"
import { shortDay, useReading } from "./reading.ts"

// Mistakes: each Mistake Type and Trap Pattern per 100 Questions answered,
// week by week, so careless errors can be seen falling, or not.

type Week = MistakeTrendView["weeks"][number]

// A small line of one kind's weekly rates, the latest week at the right.
const Spark = ({ values, max }: { readonly values: ReadonlyArray<number>; readonly max: number }) => {
  const width = 120
  const height = 28
  const x = (index: number) => (values.length === 1 ? width / 2 : (index / (values.length - 1)) * (width - 6) + 3)
  const y = (value: number) => height - 3 - (value / Math.max(max, 1e-9)) * (height - 6)
  return (
    <svg className="spark chart-line tone-ink" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {values.length > 1 && <polyline points={values.map((value, index) => `${x(index)},${y(value)}`).join(" ")} />}
      <circle cx={x(values.length - 1)} cy={y(values.at(-1) ?? 0)} r={3} />
    </svg>
  )
}

// A rate to a tenth under 10, else whole: 0, 4.3, 5, 20.
const rate = (value: number) => (value >= 10 ? Math.round(value) : Math.round(value * 10) / 10).toString()

const Kinds = (
  { weeks, pick, title, about }: {
    readonly weeks: ReadonlyArray<Week>
    readonly pick: (week: Week) => Week["mistakeTypes"]
    readonly title: string
    readonly about: string
  }
) => {
  const kinds = new Map<string, { readonly id: string; readonly name: string; total: number }>()
  for (const week of weeks) {
    for (const each of pick(week)) {
      const found = kinds.get(each.kind.id) ?? { id: each.kind.id, name: each.kind.name, total: 0 }
      found.total += each.per100
      kinds.set(each.kind.id, found)
    }
  }
  const ordered = [...kinds.values()].toSorted((a, b) => b.total - a.total)
  const valuesOf = (id: string) => weeks.map((week) => pick(week).find((each) => each.kind.id === id)?.per100 ?? 0)
  const max = Math.max(...ordered.flatMap((kind) => valuesOf(kind.id)), 1)
  const first = weeks[0]!
  const last = weeks.at(-1)!
  const titleId = `mistakes-${title.toLowerCase().replace(/\W+/g, "-")}`
  return (
    <section className="group" aria-labelledby={titleId}>
      <h2 id={titleId}>{title}</h2>
      <p className="group-about">{about}</p>
      {ordered.length === 0
        ? <p className="quiet">None yet.</p>
        : (
          <>
            <ul className="set-list spark-list">
              {ordered.map((kind) => {
                const values = valuesOf(kind.id)
                return (
                  <li key={kind.id}>
                    <span className="set-name">{kind.name}</span>
                    <Spark values={values} max={max} />
                    <span className="set-facts">
                      {rate(values.at(-1) ?? 0)} per 100 Questions this week
                      {values.length > 1 ? `, ${rate(values[0] ?? 0)} in the week of ${shortDay(first.from)}` : ""}.
                    </span>
                  </li>
                )
              })}
            </ul>
            <details className="figure-numbers">
              <summary>The numbers, per 100 Questions</summary>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Week</th>
                      <th scope="col" className="number">Questions</th>
                      {ordered.map((kind) => <th key={kind.id} scope="col" className="number">{kind.name}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {weeks.map((week) => (
                      <tr key={week.from}>
                        <th scope="row">{shortDay(week.from)} to {shortDay(week.to)}</th>
                        <td className="number">{week.questions}</td>
                        {ordered.map((kind) => (
                          <td key={kind.id} className="number">{rate(pick(week).find((each) => each.kind.id === kind.id)?.per100 ?? 0)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            {last.questions === 0 && <p className="hint">No Questions answered this week yet.</p>}
          </>
        )}
    </section>
  )
}

export const Mistakes = ({ onFailure }: { readonly onFailure: (failure: { readonly _tag: string }) => void }) => {
  const read = useCallback(() => call((client) => client.analytics.mistakes()), [])
  const view = useReading(read, onFailure)
  if (view === undefined) return <p className="quiet" aria-busy="true">Counting your mistakes</p>
  if (view.weeks.length === 0) return <p className="empty">Mistakes show here once you have answered Questions in a set that shows how they went.</p>
  return (
    <>
      <Kinds
        weeks={view.weeks}
        pick={(week) => week.mistakeTypes}
        title="Mistake Types"
        about="What went wrong in each wrong part, yours where you set it, per 100 Questions you answered, a week of 7 Study Days at a time."
      />
      <Kinds
        weeks={view.weeks}
        pick={(week) => week.trapPatterns}
        title="Trap Patterns"
        about="The traps the wrong options you picked were set with, per 100 Questions you answered."
      />
    </>
  )
}
