import { useCallback } from "react"
import type { TimingView } from "../../../src/api/Analytics.ts"
import { call } from "../api.ts"
import { Bar, Figure, Legend, LineChart, type Tone } from "../charts/charts.tsx"
import { dayAndTime } from "../format.ts"
import { paceText, percent, plural, useReading } from "./reading.ts"

// Timing: how long first answers take against their Target Times, by
// Question Type and by the Strategy that solves a Question fastest; how
// Sections end; and each Mock's pacing against an even pace.

type Pace = TimingView["questionTypes"][number]["pace"]

const PaceList = ({ rows }: { readonly rows: ReadonlyArray<{ readonly id: string; readonly name: string; readonly pace: Pace }> }) => {
  const max = Math.max(1.6, ...rows.map((row) => row.pace.median))
  return (
    <ul className="set-list pace-list">
      {rows.map((row) => (
        <li key={row.id}>
          <span className="set-name">{row.name}</span>
          <Bar value={row.pace.median} max={max} reference={1} tone={row.pace.median > 1.3 ? "ink" : "guide"} />
          <span className="set-facts">
            {paceText(row.pace.median)}, over {plural(row.pace.answers, "answer", "answers")}
            {row.pace.median > 1.3 ? ". Slow" : ""}.
          </span>
        </li>
      ))}
    </ul>
  )
}

const minutes = (millis: number) => Math.round(millis / 60_000)

const MockPacing = ({ mock, timeZone }: { readonly mock: TimingView["mocks"][number]; readonly timeZone: string }) => (
  <div className="mock-pacing">
    <h3 className="map-topic">Mock of {dayAndTime(mock.finishedAt, timeZone)}</h3>
    {mock.sections.map((section) => {
      const tone = (["quant", "verbal", "di"].includes(section.section.id) ? section.section.id : "ink") as Tone
      const last = section.points.at(-1)
      const ticks = Array.from({ length: Math.floor(minutes(section.limitMs) / 15) + 1 }, (_, index) => index * 15)
      return (
        <Figure
          key={section.section.id}
          title={section.section.name}
          chart={
            <LineChart
              description={`${section.section.name}: ${
                last === undefined
                  ? "no answers"
                  : `${minutes(last.usedMs)} minutes used by Question ${last.question}, against ${minutes(last.evenMs)} at an even pace`
              }.`}
              series={[
                { id: "even", label: "An even pace", tone: "guide", dashed: true, points: section.points.map((point) => ({ x: point.question, y: point.evenMs / 60_000 })) },
                { id: "used", label: "Your time", tone, points: section.points.map((point) => ({ x: point.question, y: point.usedMs / 60_000 })) }
              ]}
              xDomain={[1, Math.max(2, section.questions)]}
              yDomain={[0, minutes(section.limitMs)]}
              xLabel={(question) => `Q${question}`}
              yTicks={ticks}
              yLabel={(value) => `${value}m`}
            />
          }
          legend={<Legend series={[{ id: "used", label: "Your time", tone }, { id: "even", label: "An even pace", tone: "guide", dashed: true }]} />}
          numbers={
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Question</th>
                  <th scope="col" className="number">Your time</th>
                  <th scope="col" className="number">An even pace</th>
                </tr>
              </thead>
              <tbody>
                {section.points.map((point) => (
                  <tr key={point.question}>
                    <th scope="row">{point.question}</th>
                    <td className="number">{(point.usedMs / 60_000).toFixed(1)} min</td>
                    <td className="number">{(point.evenMs / 60_000).toFixed(1)} min</td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        />
      )
    })}
  </div>
)

export const Timing = ({ onFailure }: { readonly onFailure: (failure: { readonly _tag: string }) => void }) => {
  const read = useCallback(() => call((client) => client.analytics.timing()), [])
  const view = useReading(read, onFailure)
  if (view === undefined) return <p className="quiet" aria-busy="true">Working out your timing</p>
  if (view.questionTypes.length === 0) {
    return <p className="empty">Timing comes from timed sets. Take a timed Practice Set, a Sectional or a Mock, and it shows here.</p>
  }
  const ending = view.ending
  return (
    <>
      <section className="group" aria-labelledby="pace-types">
        <h2 id="pace-types">Pace by Question Type</h2>
        <p className="group-about">
          The middle of your first answers' times in timed sets, against each Question's Target Time. The tick is the
          Target Time; over 1.3 times it is slow.
        </p>
        <PaceList rows={view.questionTypes.map((each) => ({ id: each.questionType.id, name: each.questionType.name, pace: each.pace }))} />
      </section>
      {view.strategies.length > 0 && (
        <section className="group" aria-labelledby="pace-strategies">
          <h2 id="pace-strategies">Pace by Strategy</h2>
          <p className="group-about">
            The same, for Questions whose fastest way to solve uses the Strategy: a slow one may be worth practising.
          </p>
          <PaceList rows={view.strategies.map((each) => ({ id: each.strategy.id, name: each.strategy.name, pace: each.pace }))} />
        </section>
      )}
      <section className="group" aria-labelledby="pace-ending">
        <h2 id="pace-ending">How Sections end</h2>
        <p className="group-about">
          Your first answers on the last 5 Questions of each Sectional and Mock Section, against the rest. Questions the
          clock ran out on are left out.
        </p>
        {ending.last.answered + ending.rest.answered === 0
          ? <p className="quiet">Sectionals and Mocks show this once you have taken one.</p>
          : (
            <ul className="set-list pace-list">
              <li>
                <span className="set-name">The last 5 Questions</span>
                <Bar value={ending.last.right} max={Math.max(1, ending.last.answered)} />
                <span className="set-facts">{percent(ending.last.right, ending.last.answered)} right, {ending.last.right} of {ending.last.answered}.</span>
              </li>
              <li>
                <span className="set-name">The rest</span>
                <Bar value={ending.rest.right} max={Math.max(1, ending.rest.answered)} />
                <span className="set-facts">{percent(ending.rest.right, ending.rest.answered)} right, {ending.rest.right} of {ending.rest.answered}.</span>
              </li>
            </ul>
          )}
      </section>
      <section className="group" aria-labelledby="pace-mocks">
        <h2 id="pace-mocks">Mock pacing</h2>
        {view.mocks.length === 0
          ? <p className="quiet">Each finished Mock's pacing shows here, Section by Section.</p>
          : view.mocks.slice(0, 3).map((mock) => <MockPacing key={mock.mockId} mock={mock} timeZone={view.timeZone} />)}
      </section>
    </>
  )
}
