import { type Ref, useId } from "react"
import { bandNames } from "../../../src/api/difficulty.ts"
import type { Debrief, PracticePart, ResponseView, TrapNoteView } from "../../../src/api/Practice.ts"
import { spokenDuration } from "../format.ts"
import { RichText } from "../RichText.tsx"

// What a Learner reads after a Question: whether the answer was right, why
// a wrong option tempted, and the stored ways to solve it, fastest first.

const keyText = (debrief: Debrief) => debrief.keys.map((key) => key.key ?? "unknown").join(", ")

// How a Question of several Parts went: the Parts themselves show each key.
const partsHeading = (debrief: Debrief, response: ResponseView | null) => {
  if (response === null) return "Not answered."
  if (response.timedOut) return "Time ran out."
  if (debrief.correct) return "Right, every part."
  const right = debrief.keys.filter((key) =>
    key.key !== null && response.selection.some((each) => each.part === key.part && each.choice === key.key)
  ).length
  return `Not this time: ${right} of ${debrief.keys.length} parts right.`
}

// Which option a Trap Note is about, in words a Learner can find on screen.
const trapTitle = (note: TrapNoteView, parts: ReadonlyArray<PracticePart> | undefined) => {
  const part = parts?.find((each) => each.position === note.part)
  if (part === undefined || (parts!.length === 1 && part.kind === "single-choice")) return `Why ${note.label} tempts`
  const text = part.options.find((option) => option.label === note.label)?.text ?? note.label
  switch (part.kind) {
    case "two-choice":
      return `Why "${text}" tempts for statement ${part.position + 1}`
    case "dropdown":
      return `Why "${text}" tempts in blank ${part.position + 1}`
    case "column-choice":
      return `Why "${text}" tempts for ${part.prompt ?? `column ${part.position + 1}`}`
    case "single-choice":
      return `Why ${note.label} tempts in part ${part.position + 1}`
  }
}

// Why an answer leaves the scores alone, when it does.
const unratedText = (response: ResponseView, timed: boolean) =>
  !timed
    ? " Untimed, so this answer does not change your scores."
    : response.timedOut
    ? " Time ran out, so this Question does not change your scores."
    : " You had seen this Question before, so this answer does not change your scores."

export const DebriefPanel = (
  { debrief, response, timed, headingRef, parts }: {
    readonly debrief: Debrief
    readonly response: ResponseView | null
    // Whether the set was timed.
    readonly timed: boolean
    readonly headingRef?: Ref<HTMLHeadingElement>
    // The Question's Parts, to name the options of several.
    readonly parts?: ReadonlyArray<PracticePart>
  }
) => {
  const titleId = useId()
  const several = debrief.keys.length > 1
  return (
    <section className="debrief" aria-labelledby={titleId}>
      <h2 id={titleId} ref={headingRef} tabIndex={-1}>
        {several
          ? partsHeading(debrief, response)
          : response === null
          ? `Not answered. The answer is ${keyText(debrief)}.`
          : response.timedOut
          ? `Time ran out. The answer is ${keyText(debrief)}.`
          : debrief.correct
          ? `Right, the answer is ${keyText(debrief)}.`
          : `Not this time. The answer is ${keyText(debrief)}.`}
      </h2>
      <p className="debrief-facts">
        {response !== null && !response.timedOut && (
          <>
            You took {spokenDuration(response.timeSpentMs)}
            {response.guessed ? " and marked it as a guess" : ""}.{" "}
          </>
        )}
        {debrief.skill === null ? "" : `${debrief.skill.name}, `}
        {bandNames[debrief.band].toLowerCase()} difficulty.
        {response !== null && !response.rated && unratedText(response, timed)}
      </p>

      {debrief.trapNotes.map((note) => (
        <aside key={`${note.part}-${note.label}`} className="trap-note" aria-label={trapTitle(note, parts)}>
          <h3>{trapTitle(note, parts)}</h3>
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
