import { useCallback } from "react"
import { call } from "../api.ts"
import { dayAndTime } from "../format.ts"
import { useReading } from "../progress/reading.ts"

// The Questions this Learner reported, with what the Curator decided.
const decisionText = (decision: string | null) =>
  decision === null
    ? "The Curator has not decided yet."
    : decision === "dismissed"
    ? "The Curator checked it and kept it as it is."
    : decision === "withdrawn"
    ? "The Curator took the Question out."
    : "The Curator changed the Question."

export const MyReports = ({ onFailure }: { readonly onFailure: (failure: { readonly _tag: string }) => void }) => {
  const read = useCallback(() => call((client) => client.tutor.reports()), [])
  const reports = useReading(read, onFailure)
  if (reports === undefined || reports.length === 0) return null
  return (
    <section className="group my-reports" aria-labelledby="my-reports-title">
      <h2 id="my-reports-title">Your reports</h2>
      <ul className="set-list">
        {reports.map((report) => (
          <li key={report.id}>
            <span className="set-name">{dayAndTime(report.at)}</span>
            <span className="set-facts">
              “{report.text}” {decisionText(report.decision)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
