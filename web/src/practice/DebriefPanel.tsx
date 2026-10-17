import { type Ref, useEffect, useId, useRef, useState } from "react"
import { bandNames } from "../../../src/api/difficulty.ts"
import type { ErrorLogEntry } from "../../../src/api/ErrorLog.ts"
import type { Debrief, MissedPartView, MistakesView, PracticePart, ResponseView, TrapNoteView } from "../../../src/api/Practice.ts"
import { call } from "../api.ts"
import { spokenDuration } from "../format.ts"
import { useLessonOn } from "../lessons/available.ts"
import { lessonPath } from "../lessons/paths.ts"
import { RichText } from "../RichText.tsx"
import { linkProps } from "../router.ts"
import { reportUnsaved } from "../unsaved.ts"

// What a Learner reads after a Question: whether the answer was right, why
// a wrong option tempted, and the stored ways to solve it, fastest first.

// The answer as the screen shows it: a letter for a choice of five, else the
// option's words, as a single menu or statement row shows only words.
const keyText = (debrief: Debrief, parts: ReadonlyArray<PracticePart> | undefined) =>
  debrief.keys.map((key) => {
    const part = parts?.find((each) => each.position === key.part)
    if (key.key === null) return "unknown"
    if (part === undefined || part.kind === "single-choice") return key.key
    return part.options.find((option) => option.label === key.key)?.text ?? key.key
  }).join(", ")

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
  { debrief, response, timed, headingRef, parts, mistakes, onMistakeChanged, onFailure }: {
    readonly debrief: Debrief
    readonly response: ResponseView | null
    // Whether the set was timed.
    readonly timed: boolean
    readonly headingRef?: Ref<HTMLHeadingElement>
    // The Question's Parts, to name the options of several.
    readonly parts?: ReadonlyArray<PracticePart>
    // A wrong answer's Mistake Types, which the Learner can change.
    readonly mistakes?: MistakesView | null
    // Told the entry as saved after a change, and a failure the page handles.
    readonly onMistakeChanged?: (entry: ErrorLogEntry) => void
    readonly onFailure?: (failure: { readonly _tag: string }) => void
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
          ? `Not answered. The answer is ${keyText(debrief, parts)}.`
          : response.timedOut
          ? `Time ran out. The answer is ${keyText(debrief, parts)}.`
          : debrief.correct
          ? `Right, the answer is ${keyText(debrief, parts)}.`
          : `Not this time. The answer is ${keyText(debrief, parts)}.`}
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
          {
            // Where the Learner sets the Mistake Type below, the note names
            // only its Trap Pattern, so one Part never shows two.
            mistakes != null && mistakes.parts.length > 0
              ? note.trapPattern !== null && <p className="trap-kind">{note.trapPattern.name}</p>
              : (
                <p className="trap-kind">
                  {note.mistakeType.name}
                  {note.trapPattern === null ? "" : `: ${note.trapPattern.name}`}
                </p>
              )
          }
        </aside>
      ))}

      {mistakes != null && mistakes.parts.length > 0 && (
        <MistakeControls mistakes={mistakes} parts={parts} onChanged={onMistakeChanged} onFailure={onFailure} />
      )}

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
      <LessonLink skill={debrief.skill} />
    </section>
  )
}

// The Lesson on the Question's primary Skill, once approved (decision 102).
const LessonLink = ({ skill }: { readonly skill: Debrief["skill"] }) => {
  const lesson = useLessonOn(skill?.id)
  if (lesson === undefined) return null
  return (
    <p className="debrief-lesson">
      <a className="button button-quiet" {...linkProps(lessonPath(lesson.subject.id))}>
        Read the Lesson on {lesson.subject.name}
      </a>
    </p>
  )
}

type Basis = MissedPartView["basis"]

const basisHint: Record<Basis, string> = {
  learner: "You chose this. Your Error Log keeps it.",
  timing: "The app chose this from your timing. Pick another if it fits better.",
  option: "The app chose this from the option you picked. Pick another if it fits better.",
  none: "Pick what went wrong, for your Error Log."
}

// What went wrong in each wrong Part, as the Error Log keeps it: the app's
// choice until the Learner picks another, with one tap. A Part sends one
// save at a time: picks made while one is on its way wait, and only the
// latest is sent next, so arrowing through the choices stores where the
// Learner stops, in order. Every save that lands is recorded and passed on,
// so a failed one puts back what was saved last, unless a newer pick is on
// its way. A save that fails after the control has closed is reported by
// the app.
const MistakeControls = (
  { mistakes, parts, onChanged, onFailure }: {
    readonly mistakes: MistakesView
    readonly parts: ReadonlyArray<PracticePart> | undefined
    readonly onChanged: ((entry: ErrorLogEntry) => void) | undefined
    readonly onFailure: ((failure: { readonly _tag: string }) => void) | undefined
  }
) => {
  type Choice = { readonly id: string | null; readonly basis: Basis }
  const [chosen, setChosen] = useState<ReadonlyMap<number, Choice>>(
    () => new Map(mistakes.parts.map((part) => [part.part, { id: part.mistakeType?.id ?? null, basis: part.basis }]))
  )
  const [problems, setProblems] = useState<ReadonlyMap<number, string>>(new Map())
  const saved = useRef(new Map(chosen))
  const queue = useRef(new Map<number, { sending: boolean; next: string | undefined }>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const name = useId()
  const several = (parts?.length ?? 1) > 1

  const send = async (part: number) => {
    const slot = queue.current.get(part)
    if (slot === undefined || slot.sending || slot.next === undefined) return
    const mistakeType = slot.next
    slot.next = undefined
    slot.sending = true
    const result = await call((client) =>
      client.errorLog.setMistakeType({
        params: { questionId: mistakes.questionId },
        payload: { responseId: mistakes.responseId, part, mistakeType }
      })
    )
    slot.sending = false
    if (result._tag === "Success") {
      saved.current.set(part, { id: mistakeType, basis: "learner" })
      onChanged?.(result.success)
    }
    // A newer pick waits: its reply decides what shows.
    if (slot.next !== undefined) return void send(part)
    if (result._tag === "Success") return
    if (result.failure._tag === "NotUnlocked") return onFailure?.(result.failure)
    if (!mounted.current) {
      return reportUnsaved("A Mistake Type you picked was not saved. Open the Question in your Error Log to set it again.")
    }
    const before = saved.current.get(part)
    if (before !== undefined) setChosen((current) => new Map(current).set(part, before))
    setProblems((current) =>
      new Map(current).set(
        part,
        several ? `The change for ${partName(part, parts)} was not saved. Try again.` : "That change was not saved. Try again."
      )
    )
  }

  const choose = (part: number, mistakeType: string) => {
    setChosen((current) => new Map(current).set(part, { id: mistakeType, basis: "learner" }))
    setProblems((current) => {
      const next = new Map(current)
      next.delete(part)
      return next
    })
    const slot = queue.current.get(part) ?? { sending: false, next: undefined }
    slot.next = mistakeType
    queue.current.set(part, slot)
    void send(part)
  }

  return (
    <div className="mistakes">
      {mistakes.parts.map((part) => {
        const current = chosen.get(part.part)
        const label = several ? partName(part.part, parts) : undefined
        const problem = problems.get(part.part)
        return (
          <fieldset key={part.part} className="mistake-choice">
            <legend>Mistake Type{label === undefined ? "" : ` in ${label}`}</legend>
            <div className="mistake-options">
              {mistakes.choices.map((choice) => (
                <label key={choice.id} className="mistake-option">
                  <input
                    type="radio"
                    name={`${name}-${part.part}`}
                    checked={current?.id === choice.id}
                    onChange={() => choose(part.part, choice.id)}
                  />
                  {choice.name}
                </label>
              ))}
            </div>
            <p className="hint">{basisHint[current?.id == null ? "none" : current.basis]}</p>
            {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
          </fieldset>
        )
      })}
    </div>
  )
}

const partName = (position: number, parts: ReadonlyArray<PracticePart> | undefined) => {
  const part = parts?.find((each) => each.position === position)
  switch (part?.kind) {
    case "two-choice":
      return `statement ${position + 1}`
    case "dropdown":
      return `blank ${position + 1}`
    case "column-choice":
      return part.prompt ?? `column ${position + 1}`
    default:
      return `part ${position + 1}`
  }
}
