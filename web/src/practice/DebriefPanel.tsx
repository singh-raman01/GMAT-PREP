import { type Ref, useId } from "react"
import { bandNames } from "../../../src/api/difficulty.ts"
import type { Debrief, ResponseView } from "../../../src/api/Practice.ts"
import { spokenDuration } from "../format.ts"
import { RichText } from "../RichText.tsx"

// What a Learner reads after a Question: whether the answer was right, why
// a wrong option tempted, and the stored ways to solve it, fastest first.

const keyText = (debrief: Debrief) => debrief.keys.map((key) => key.key ?? "unknown").join(", ")

export const DebriefPanel = (
  { debrief, response, headingRef }: {
    readonly debrief: Debrief
    readonly response: ResponseView | null
    readonly headingRef?: Ref<HTMLHeadingElement>
  }
) => {
  const titleId = useId()
  return (
    <section className="debrief" aria-labelledby={titleId}>
      <h2 id={titleId} ref={headingRef} tabIndex={-1}>
        {response === null
          ? `Not answered. The answer is ${keyText(debrief)}.`
          : debrief.correct
          ? `Right, the answer is ${keyText(debrief)}.`
          : `Not this time. The answer is ${keyText(debrief)}.`}
      </h2>
      <p className="debrief-facts">
        {response !== null && (
          <>
            You took {spokenDuration(response.timeSpentMs)}
            {response.guessed ? " and marked it as a guess" : ""}.{" "}
          </>
        )}
        {debrief.skill === null ? "" : `${debrief.skill.name}, `}
        {bandNames[debrief.band].toLowerCase()} difficulty.
        {response !== null && !response.rated && " Untimed, so this answer does not change your scores."}
      </p>

      {debrief.trapNotes.map((note) => (
        <aside key={`${note.part}-${note.label}`} className="trap-note" aria-label={`Why ${note.label} tempts`}>
          <h3>Why {note.label} tempts</h3>
          <p>{note.note}</p>
          <p className="trap-kind">
            {note.mistakeType.name}
            {note.trapPattern === null ? "" : `: ${note.trapPattern.name}`}
          </p>
        </aside>
      ))}

      {debrief.approaches.length === 0
        ? <p className="quiet">No worked solution reaches this answer yet.</p>
        : (
          <>
            <h3 className="ways-title">Ways to solve it, fastest first</h3>
            <ol className="ways">
              {debrief.approaches.map((route, index) => (
                <li key={index} className="way">
                  <p className="way-head">
                    <span className="way-name">{route.strategy.name}</span>
                    <span className="way-time">about {spokenDuration(route.expectedSeconds * 1000)}</span>
                    {route.fromBook && <span className="tag">The book's explanation</span>}
                  </p>
                  <p className="way-when">Works when: {route.validWhen}</p>
                  <RichText source={route.steps} />
                </li>
              ))}
            </ol>
          </>
        )}
    </section>
  )
}
