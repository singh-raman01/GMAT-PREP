import { Fragment, useId } from "react"
import type { PracticePart } from "../../../src/api/Practice.ts"
import { RichInline } from "../RichText.tsx"

// The Parts of a Data Insights Question, each answered its own way: a row of
// two choices for each statement (Table Analysis, and Multi-Source Reasoning
// statements), a menu in each sentence (Graphics Interpretation), a grid of
// two columns over one list (Two-Part Analysis), or one of several options.
// A Question is right only when every Part is.

export type Picks = Readonly<Record<number, string>>

interface PartsProps {
  readonly parts: ReadonlyArray<PracticePart>
  readonly picks: Picks
  readonly onPick: (part: number, label: string) => void
  readonly disabled: boolean
  // Once answered, each Part's key, to show beside the picks.
  readonly keys: ReadonlyMap<number, string | null> | undefined
}

const Flag = ({ isKey, isPick }: { readonly isKey: boolean; readonly isPick: boolean }) => (
  <>
    {isKey && <span className="answer-flag">The answer</span>}
    {isPick && !isKey && <span className="answer-flag">Your answer</span>}
  </>
)

// Statement rows: two choices each, with the pair as column headings when
// every row shares it.
const TwoChoiceRows = ({ parts, picks, onPick, disabled, keys }: PartsProps) => {
  const name = useId()
  const pair = parts[0]!.options.map((option) => option.text)
  const shared = parts.every((part) => part.options.map((option) => option.text).join("|") === pair.join("|"))
  return (
    <table className="statement-rows">
      <thead>
        <tr>
          {shared && pair.map((text, index) => <th key={index} scope="col" className="choice-head">{text}</th>)}
          <th scope="col" className="statement-head">Statement</th>
        </tr>
      </thead>
      <tbody>
        {parts.map((part) => {
          const key = keys?.get(part.position)
          return (
            <tr
              key={part.position}
              data-right={key !== undefined && picks[part.position] === key ? true : undefined}
              data-wrong={key !== undefined && picks[part.position] !== key ? true : undefined}
            >
              {part.options.map((option) => (
                <td key={option.label} className="choice-cell">
                  <label className={shared ? "choice-label" : "choice-label with-text"}>
                    <input
                      type="radio"
                      name={`${name}-${part.position}`}
                      value={option.label}
                      checked={picks[part.position] === option.label}
                      disabled={disabled}
                      onChange={() => onPick(part.position, option.label)}
                    />
                    <span className={shared ? "visually-hidden" : undefined}>
                      {option.text}
                      {shared ? ` for statement ${part.position + 1}` : ""}
                    </span>
                  </label>
                  {key !== undefined && (
                    <Flag isKey={key === option.label} isPick={picks[part.position] === option.label} />
                  )}
                </td>
              ))}
              <th scope="row" className="statement">
                <RichInline source={part.prompt ?? ""} />
              </th>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// Sentences with a menu where each blank is.
const Blanks = ({ parts, picks, onPick, disabled, keys }: PartsProps) => (
  <div className="blanks">
    {parts.map((part) => {
      const [before, after] = (part.prompt ?? "{{blank}}").split("{{blank}}")
      const key = keys?.get(part.position)
      const keyText = part.options.find((option) => option.label === key)?.text
      return (
        <p key={part.position} className="blank-sentence">
          <RichInline source={before ?? ""} />{" "}
          <select
            aria-label={`Blank ${part.position + 1}`}
            value={picks[part.position] ?? ""}
            disabled={disabled}
            onChange={(event) => onPick(part.position, event.target.value)}
          >
            <option value="" disabled>Select an option</option>
            {part.options.map((option) => <option key={option.label} value={option.label}>{option.text}</option>)}
          </select>{" "}
          <RichInline source={after ?? ""} />
          {key !== undefined && (
            <span className="answer-flag">
              {picks[part.position] === key ? "Right" : `The answer: ${keyText ?? "unknown"}`}
            </span>
          )}
        </p>
      )
    })}
  </div>
)

// Two columns over one list: one choice in each column, which may be the
// same option.
const ColumnGrid = ({ parts, picks, onPick, disabled, keys }: PartsProps) => {
  const name = useId()
  const options = parts[0]!.options
  return (
    <table className="column-grid">
      <thead>
        <tr>
          {parts.map((part) => <th key={part.position} scope="col" className="choice-head">{part.prompt}</th>)}
          <th scope="col" className="statement-head">Option</th>
        </tr>
      </thead>
      <tbody>
        {options.map((option) => (
          <tr key={option.label}>
            {parts.map((part) => {
              const key = keys?.get(part.position)
              return (
                <td key={part.position} className="choice-cell">
                  <label className="choice-label">
                    <input
                      type="radio"
                      name={`${name}-${part.position}`}
                      value={option.label}
                      checked={picks[part.position] === option.label}
                      disabled={disabled}
                      onChange={() => onPick(part.position, option.label)}
                    />
                    <span className="visually-hidden">{`${part.prompt ?? `Column ${part.position + 1}`}: ${option.text}`}</span>
                  </label>
                  {key !== undefined && (
                    <Flag isKey={key === option.label} isPick={picks[part.position] === option.label} />
                  )}
                </td>
              )
            })}
            <th scope="row" className="statement">
              <RichInline source={option.text} />
            </th>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// One of several options, for a Part asked on its own.
const OneOfSeveral = ({ parts, picks, onPick, disabled, keys }: PartsProps) => {
  const name = useId()
  return (
    <>
      {parts.map((part) => {
        const key = keys?.get(part.position)
        return (
          <fieldset key={part.position} className="answer-options">
            <legend className={part.prompt === null ? "visually-hidden" : "part-prompt"}>
              {part.prompt === null ? "Answer choices" : <RichInline source={part.prompt} />}
            </legend>
            {part.options.map((option) => {
              const isPick = picks[part.position] === option.label
              return (
                <label
                  key={option.label}
                  className="answer-option"
                  data-picked={isPick || undefined}
                  data-key={(key !== undefined && key === option.label) || undefined}
                  data-missed={(key !== undefined && isPick && key !== option.label) || undefined}
                >
                  <input
                    type="radio"
                    name={`${name}-${part.position}`}
                    value={option.label}
                    checked={isPick}
                    disabled={disabled}
                    onChange={() => onPick(part.position, option.label)}
                  />
                  <span className={isPick ? "answer-letter mark" : "answer-letter"}>{option.label}</span>
                  <span className="answer-text">
                    <RichInline source={option.text} />
                    {key !== undefined && <Flag isKey={key === option.label} isPick={isPick} />}
                  </span>
                </label>
              )
            })}
          </fieldset>
        )
      })}
    </>
  )
}

// The Parts in order, neighbours of one kind shown together.
export const AnswerParts = (props: PartsProps) => {
  const runs: Array<Array<PracticePart>> = []
  for (const part of props.parts) {
    const last = runs.at(-1)
    if (last !== undefined && last[0]!.kind === part.kind) last.push(part)
    else runs.push([part])
  }
  return (
    <>
      {runs.map((run) => {
        const shown = { ...props, parts: run }
        return (
          <Fragment key={run[0]!.position}>
            {run[0]!.kind === "two-choice"
              ? <TwoChoiceRows {...shown} />
              : run[0]!.kind === "dropdown"
              ? <Blanks {...shown} />
              : run[0]!.kind === "column-choice"
              ? <ColumnGrid {...shown} />
              : <OneOfSeveral {...shown} />}
          </Fragment>
        )
      })}
    </>
  )
}
