import { useId, useState } from "react"
import { type CalculatorState, initialState, type Key, keyOf, press } from "./calculator.ts"

// The on-screen calculator, offered with Data Insights Questions only, as on
// the exam. Typing works while focus is inside it: digits, + - * / (or x),
// Enter or = for the result, % for percent, Backspace, Delete to clear the
// entry and Escape or C to clear all. No key typed in it reaches the set
// screen, whose letters pick answers.

interface Button {
  readonly text: string
  readonly name: string
  readonly key: Key
  readonly wide?: boolean
  readonly kind?: "operator" | "memory" | "equals"
}

const digit = (value: string): Button => ({ text: value, name: value, key: { _tag: "Digit", digit: value } })
const operator = (text: string, name: string, value: "+" | "-" | "*" | "/"): Button => ({
  text,
  name,
  key: { _tag: "Operator", operator: value },
  kind: "operator"
})

const rows: ReadonlyArray<ReadonlyArray<Button>> = [
  [
    { text: "MC", name: "Clear memory", key: { _tag: "MemoryClear" }, kind: "memory" },
    { text: "MR", name: "Recall memory", key: { _tag: "MemoryRecall" }, kind: "memory" },
    { text: "M+", name: "Add to memory", key: { _tag: "MemoryAdd" }, kind: "memory" },
    { text: "M−", name: "Subtract from memory", key: { _tag: "MemorySubtract" }, kind: "memory" }
  ],
  [
    { text: "C", name: "Clear all", key: { _tag: "Clear" } },
    { text: "CE", name: "Clear entry", key: { _tag: "ClearEntry" } },
    { text: "√", name: "Square root", key: { _tag: "SquareRoot" } },
    operator("÷", "Divide", "/")
  ],
  [digit("7"), digit("8"), digit("9"), operator("×", "Times", "*")],
  [digit("4"), digit("5"), digit("6"), operator("−", "Minus", "-")],
  [digit("1"), digit("2"), digit("3"), operator("+", "Plus", "+")],
  [
    { text: "±", name: "Change sign", key: { _tag: "Negate" } },
    digit("0"),
    { text: ".", name: "Point", key: { _tag: "Point" } },
    { text: "%", name: "Percent", key: { _tag: "Percent" } }
  ],
  [{ text: "=", name: "Equals", key: { _tag: "Equals" }, wide: true, kind: "equals" }]
]

export const Calculator = ({ onClose }: { readonly onClose: () => void }) => {
  const [state, setState] = useState<CalculatorState>(initialState)
  const title = useId()
  const hit = (key: Key) => setState((before) => press(before, key))
  return (
    <section
      className="calculator"
      aria-labelledby={title}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return
        // Enter gives the result, whichever key has focus; Space presses it.
        const key = keyOf(event.key)
        if (key === undefined) {
          if (event.key.length === 1) event.stopPropagation()
          return
        }
        event.preventDefault()
        event.stopPropagation()
        hit(key)
      }}
    >
      <div className="calculator-head">
        <h2 id={title} className="calculator-title">Calculator</h2>
        <button type="button" className="link-button" onClick={onClose}>Close</button>
      </div>
      <output className="calculator-display" aria-live="polite" aria-label="Display">
        {state.memory !== 0 && <span className="calculator-memory" aria-label="Memory holds a number">M</span>}
        {state.display}
      </output>
      <div className="calculator-keys">
        {rows.flat().map((button) => (
          <button
            key={button.name}
            type="button"
            className={`calculator-key${button.kind === undefined ? "" : ` ${button.kind}`}${button.wide ? " wide" : ""}`}
            aria-label={button.name === button.text ? undefined : button.name}
            onClick={() => hit(button.key)}
          >
            {button.text}
          </button>
        ))}
      </div>
    </section>
  )
}
