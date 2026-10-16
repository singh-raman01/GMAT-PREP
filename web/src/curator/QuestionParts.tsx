import type { ReactNode } from "react"
import { RichInline } from "../RichText.tsx"

// A Question's Parts as the Curator checks them: each Part's words, then its
// options, with each Part's key marked and anything more said about an
// option after it. A Question with one choice of five shows its options
// alone.

interface Part {
  readonly prompt: string | null
  readonly options: ReadonlyArray<{ readonly label: string; readonly text: string }>
}

type Extra = (part: number, label: string) => ReactNode

const Choices = (
  { options, keyLabel, part, extra }: {
    readonly options: Part["options"]
    readonly keyLabel: string | null
    readonly part: number
    readonly extra: Extra | undefined
  }
) => (
  <ol className="choices">
    {options.map((option) => (
      <li key={option.label} className={option.label === keyLabel ? "choice is-key" : "choice"}>
        <span className="choice-letter">
          {option.label === keyLabel ? <span className="mark">{option.label}</span> : option.label}
        </span>
        <span className="choice-text">
          <RichInline source={option.text} />
          {option.label === keyLabel && <span className="visually-hidden">(the key)</span>}
          {extra?.(part, option.label)}
        </span>
      </li>
    ))}
  </ol>
)

// A Part's words, with its menu's place shown as a gap.
const PartWords = ({ prompt }: { readonly prompt: string }) => {
  const [before, after] = prompt.split("{{blank}}")
  return (
    <p className="part-words">
      <RichInline source={before ?? ""} />
      {after !== undefined && (
        <>
          <span aria-hidden="true">____</span>
          <span className="visually-hidden">blank</span>
          <RichInline source={after} />
        </>
      )}
    </p>
  )
}

export const PartsWithKeys = (
  { parts, keys, extra }: {
    readonly parts: ReadonlyArray<Part>
    // Each Part's key, in order.
    readonly keys: ReadonlyArray<string | null>
    readonly extra?: Extra
  }
) => {
  const only = parts[0]
  if (parts.length === 1 && only !== undefined && only.prompt === null) {
    return <Choices options={only.options} keyLabel={keys[0] ?? null} part={0} extra={extra} />
  }
  return (
    <ol className="part-list">
      {parts.map((part, index) => (
        <li key={index} className="part-item">
          <p className="part-number">Part {index + 1}</p>
          {part.prompt !== null && <PartWords prompt={part.prompt} />}
          <Choices options={part.options} keyLabel={keys[index] ?? null} part={index} extra={extra} />
        </li>
      ))}
    </ol>
  )
}

// A Part named for a choice of it: its number, and its words when short.
export const partName = (part: Part, index: number) => {
  const words = (part.prompt ?? "").replace("{{blank}}", "…").trim()
  return words === "" ? `Part ${index + 1}` : `Part ${index + 1}: ${words.length > 60 ? `${words.slice(0, 59)}…` : words}`
}
