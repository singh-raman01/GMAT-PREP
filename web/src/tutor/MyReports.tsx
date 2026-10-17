import { useCallback, useEffect, useState } from "react"
import { call } from "../api.ts"
import { dayAndTime } from "../format.ts"
import { useReading } from "../progress/reading.ts"
import { RichText } from "../RichText.tsx"
import { onReportSent } from "./reportEvents.ts"

// The Questions this Learner reported, with what the Curator decided.
const decisionText = (decision: string | null) =>
  decision === null
    ? "The Curator has not decided yet."
    : decision === "dismissed"
    ? "The Curator checked it and kept it as it is."
    : decision === "key-changed"
    ? "The Curator changed its key."
    : decision === "withdrawn"
    ? "The Curator took the Question out."
    : "The Curator changed the Question."

export const MyReports = ({ onFailure }: { readonly onFailure: (failure: { readonly _tag: string }) => void }) => {
  // Read again whenever a report is sent from a Debrief on this page.
  const [sent, setSent] = useState(0)
  useEffect(() => onReportSent(() => setSent((count) => count + 1)), [])
  const read = useCallback(() => call((client) => client.tutor.reports()), [sent])
  const reports = useReading(read, onFailure)
  if (reports === undefined || reports.length === 0) return null
  return (
    <section className="group my-reports" aria-labelledby="my-reports-title">
      <h2 id="my-reports-title">Your reports</h2>
      <ul className="set-list">
        {reports.map((report) => (
          <li key={report.id}>
            <div className="error-stem">
              <RichText source={report.stem} />
            </div>
            <span className="set-name">{dayAndTime(report.at)}</span>
            <span className="set-facts">
              You wrote: “{report.text}” {decisionText(report.decision)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
