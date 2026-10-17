import { partKeys } from "../../../src/api/keys.ts"
import { RichInline } from "../RichText.tsx"

// A Question's Parts as the Curator checks them: each Part's words, then its
// options, with each Part's key marked. A Question with one choice of five
// shows its options alone.

interface Part {
  readonly prompt: string | null
  readonly options: ReadonlyArray<{ readonly label: string; readonly text: string }>
}

const Choices = ({ options, keyLabel }: { readonly options: Part["options"]; readonly keyLabel: string | null }) => (
  <ol className="choices">
    {options.map((option) => (
      <li key={option.label} className={option.label === keyLabel ? "choice is-key" : "choice"}>
        <span className="choice-letter">
          {option.label === keyLabel ? <span className="mark">{option.label}</span> : option.label}
        </span>
        <span className="choice-text">
          <RichInline source={option.text} />
          {option.label === keyLabel && <span className="visually-hidden">(the key)</span>}
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
  { parts, joinedKey }: { readonly parts: ReadonlyArray<Part>; readonly joinedKey: string | null }
) => {
  const keys = partKeys(joinedKey, parts.length)
  const only = parts[0]
  if (parts.length === 1 && only !== undefined && only.prompt === null) {
    return <Choices options={only.options} keyLabel={keys[0] ?? null} />
  }
  return (
    <ol className="part-list">
      {parts.map((part, index) => (
        <li key={index} className="part-item">
          <p className="part-number">Part {index + 1}</p>
          {part.prompt !== null && <PartWords prompt={part.prompt} />}
          <Choices options={part.options} keyLabel={keys[index] ?? null} />
        </li>
      ))}
    </ol>
  )
}
