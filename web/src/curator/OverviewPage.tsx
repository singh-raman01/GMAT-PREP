import { useCallback, useEffect, useState } from "react"
import type { CuratorOverview } from "../../../src/api/Overview.ts"
import { call } from "../api.ts"
import { Bar } from "../charts/charts.tsx"
import { useFocusOnMount } from "../focus.ts"
import { linkProps } from "../router.ts"

// The Curator's Overview (docs/design.md, "Analytics"): what the Question
// Bank covers by Skill and Difficulty Band, what the Mock Reserve still
// holds, where Questions run short, and what waits or costs money this month.

interface Props {
  readonly onLocked: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const money = (dollars: number) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(dollars)

const month = (millis: number) => new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(millis)

export const OverviewPage = ({ onLocked, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const [overview, setOverview] = useState<CuratorOverview>()

  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "CuratorNotUnlocked" ? onLocked() : onStopped(failure)),
    [onLocked, onStopped]
  )

  useEffect(() => {
    let live = true
    void call((client) => client.overview.get()).then((result) => {
      if (!live) return
      if (result._tag === "Failure") return handle(result.failure)
      setOverview(result.success)
    })
    return () => {
      live = false
    }
  }, [handle])

  return (
    <>
      <h1 ref={heading} tabIndex={-1}>Overview</h1>
      {overview === undefined ? <p className="quiet" aria-busy="true">Reading the Question Bank</p> : <Overview overview={overview} />}
    </>
  )
}

const Overview = ({ overview }: { readonly overview: CuratorOverview }) => {
  const sections = [...new Map(overview.coverage.map((row) => [row.section.id, row.section] as const)).values()]
  const most = Math.max(1, ...overview.coverage.map((row) => row.easy + row.medium + row.hard))
  return (
    <>
      <ul className="overview-facts">
        <li>
          <a {...linkProps("/curator/review")}>{plural(overview.reviewQueue, "item waits", "items wait")} in the Review Queue</a>
        </li>
        <li>
          {overview.problemReports === 0 ? "No Problem Report from a Learner waits for a decision" : (
            <>
              <a {...linkProps("/curator/review")}>
                {plural(overview.problemReports, "Problem Report from a Learner", "Problem Reports from Learners")}
              </a>, on {plural(overview.reportedQuestions, "Question", "Questions")},{" "}
              {overview.problemReports === 1 ? "waits" : "wait"} for a decision
            </>
          )}
        </li>
        <li>
          <a {...linkProps("/curator/siblings")}>{plural(overview.siblings, "Skill is", "Skills are")} running out of Siblings</a>,
          by Question Type
        </li>
        <li>{plural(overview.thinSkills, "Skill has", "Skills have")} fewer than 15 published Questions</li>
        <li>
          {money(overview.spend)} spent on the LLM in {month(overview.monthFrom)}
        </li>
      </ul>

      <section className="group" aria-labelledby="reserve-title">
        <h2 id="reserve-title">Mock Reserve</h2>
        <p className="group-about">
          Questions held back for Mocks, by the Blueprint's groups, against what one Mock's Section takes from each. They
          cover {plural(overview.mocks, "whole Mock", "whole Mocks")}, the scarcest group deciding.
        </p>
        <ul className="set-list pace-list">
          {overview.reserve.map((row) => (
            <li key={row.group.id} data-section={row.section.id}>
              <span className="swatch" aria-hidden="true" />
              <span className="set-name">{row.group.name}</span>
              <span className="set-facts">
                {plural(row.held, "Question", "Questions")} held, {row.perMock} a Mock: enough for{" "}
                {plural(Math.floor(row.held / Math.max(1, row.perMock)), "Mock", "Mocks")}.
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="group" aria-labelledby="coverage-title">
        <h2 id="coverage-title">Coverage</h2>
        <p className="group-about">
          Published Questions carrying each Skill, as its primary or a secondary Skill, by Difficulty Band.
        </p>
        {sections.map((section) => (
          <div key={section.id} data-section={section.id}>
            <h3 className="map-topic">{section.name}</h3>
            <div className="data-table-wrap">
              <table className="data-table coverage-table">
                <thead>
                  <tr>
                    <th scope="col">Skill</th>
                    <th scope="col" className="number">Easy</th>
                    <th scope="col" className="number">Medium</th>
                    <th scope="col" className="number">Hard</th>
                    <th scope="col" className="coverage-bar">
                      <span className="visually-hidden">All bands, as a bar</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {overview.coverage.filter((row) => row.section.id === section.id).map((row) => {
                    const all = row.easy + row.medium + row.hard
                    return (
                      <tr key={row.skill.id} className={all === 0 ? "coverage-none" : undefined}>
                        <th scope="row">{row.skill.name}</th>
                        <td className="number">{row.easy}</td>
                        <td className="number">{row.medium}</td>
                        <td className="number">{row.hard}</td>
                        <td className="coverage-bar">
                          <Bar value={all} max={most} tone={section.id === "quant" || section.id === "verbal" || section.id === "di" ? section.id : "ink"} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </section>

      <section className="group" aria-labelledby="jobs-title">
        <h2 id="jobs-title">Jobs this month</h2>
        {overview.jobs.length === 0
          ? <p className="quiet">No job has run since {month(overview.monthFrom)} began.</p>
          : (
            <ul className="set-list">
              {overview.jobs.map((job) => (
                <li key={job.id}>
                  <span className="set-name">{job.label}</span>
                  <span className="set-facts">
                    {job.status}, {money(job.spend)} of a {money(job.spendCap)} cap
                  </span>
                </li>
              ))}
            </ul>
          )}
        <p className="hint">
          <a {...linkProps("/curator/jobs")}>All jobs</a>
        </p>
      </section>
    </>
  )
}
