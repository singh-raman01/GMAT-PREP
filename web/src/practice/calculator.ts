// The on-screen calculator of Data Insights: addition, subtraction,
// multiplication, division, square root, percent and memory, as a simple
// desk calculator works. Pure, so each key press can be tested.

export type Operator = "+" | "-" | "*" | "/"

export type Key =
  | { readonly _tag: "Digit"; readonly digit: string }
  | { readonly _tag: "Point" }
  | { readonly _tag: "Operator"; readonly operator: Operator }
  | { readonly _tag: "Equals" }
  | { readonly _tag: "SquareRoot" }
  | { readonly _tag: "Percent" }
  | { readonly _tag: "Negate" }
  | { readonly _tag: "ClearEntry" }
  | { readonly _tag: "Clear" }
  | { readonly _tag: "Backspace" }
  | { readonly _tag: "MemoryClear" }
  | { readonly _tag: "MemoryRecall" }
  | { readonly _tag: "MemoryAdd" }
  | { readonly _tag: "MemorySubtract" }

export interface CalculatorState {
  // What the display shows: the entry being typed, a result, or an error.
  readonly display: string
  readonly stored: number | null
  readonly pending: Operator | null
  // The next digit starts a new entry.
  readonly fresh: boolean
  readonly memory: number
  readonly error: boolean
}

export const initialState: CalculatorState = {
  display: "0",
  stored: null,
  pending: null,
  fresh: true,
  memory: 0,
  error: false
}

const MaxDigits = 15

// A result as the display shows it: up to 12 significant digits, without
// trailing zeros.
export const formatNumber = (value: number): string => {
  if (Object.is(value, -0) || value === 0) return "0"
  const rounded = Number(value.toPrecision(12))
  const text = String(rounded)
  return Math.abs(rounded) >= 1e15 || (Math.abs(rounded) < 1e-9 && rounded !== 0) ? rounded.toExponential(6) : text
}

const failed = (state: CalculatorState, message: string): CalculatorState => ({
  ...state,
  display: message,
  stored: null,
  pending: null,
  fresh: true,
  error: true
})

const apply = (left: number, operator: Operator, right: number): number | undefined => {
  switch (operator) {
    case "+":
      return left + right
    case "-":
      return left - right
    case "*":
      return left * right
    case "/":
      return right === 0 ? undefined : left / right
  }
}

const showing = (state: CalculatorState) => Number(state.display)

// The pending operation done with what the display shows.
const settle = (state: CalculatorState): CalculatorState => {
  if (state.pending === null || state.stored === null) return state
  const result = apply(state.stored, state.pending, showing(state))
  if (result === undefined) return failed(state, "Cannot divide by zero")
  if (!Number.isFinite(result)) return failed(state, "Too large")
  return { ...state, display: formatNumber(result), stored: null, pending: null, fresh: true }
}

export const press = (before: CalculatorState, key: Key): CalculatorState => {
  // After an error, any key starts again, keeping memory.
  const state = before.error && key._tag !== "MemoryRecall" && key._tag !== "MemoryClear"
    ? { ...initialState, memory: before.memory }
    : before
  switch (key._tag) {
    case "Digit": {
      if (state.fresh) return { ...state, display: key.digit, fresh: false }
      if (state.display.replace(/[-.]/g, "").length >= MaxDigits) return state
      return { ...state, display: state.display === "0" ? key.digit : state.display + key.digit }
    }
    case "Point": {
      if (state.fresh) return { ...state, display: "0.", fresh: false }
      return state.display.includes(".") ? state : { ...state, display: `${state.display}.` }
    }
    case "Operator": {
      // Two operators in a row: the later one stands.
      if (state.pending !== null && state.fresh) return { ...state, pending: key.operator }
      const settled = settle(state)
      if (settled.error) return settled
      return { ...settled, stored: showing(settled), pending: key.operator, fresh: true }
    }
    case "Equals":
      return settle(state)
    case "SquareRoot": {
      const value = showing(state)
      if (value < 0) return failed(state, "Not a number")
      return { ...state, display: formatNumber(Math.sqrt(value)), fresh: true }
    }
    case "Percent": {
      // With + or - pending, a percent of the stored number; otherwise a
      // hundredth of the entry.
      const value = showing(state)
      const percent = state.stored !== null && (state.pending === "+" || state.pending === "-")
        ? state.stored * value / 100
        : value / 100
      return { ...state, display: formatNumber(percent), fresh: true }
    }
    case "Negate": {
      if (state.display === "0") return state
      return { ...state, display: state.display.startsWith("-") ? state.display.slice(1) : `-${state.display}` }
    }
    case "ClearEntry":
      return { ...state, display: "0", fresh: true }
    case "Clear":
      return { ...initialState, memory: state.memory }
    case "Backspace": {
      if (state.fresh) return state
      const shorter = state.display.slice(0, -1)
      return { ...state, display: shorter === "" || shorter === "-" ? "0" : shorter }
    }
    case "MemoryClear":
      return { ...before, memory: 0 }
    case "MemoryRecall":
      return { ...state, display: formatNumber(before.memory), fresh: true, error: false }
    case "MemoryAdd":
      return { ...state, memory: state.memory + showing(state), fresh: true }
    case "MemorySubtract":
      return { ...state, memory: state.memory - showing(state), fresh: true }
  }
}

// The key a keyboard key stands for, if any.
export const keyOf = (key: string): Key | undefined => {
  if (/^[0-9]$/.test(key)) return { _tag: "Digit", digit: key }
  switch (key) {
    // A comma is a thousands separator, not a point, so it does nothing.
    case ".":
      return { _tag: "Point" }
    case "+":
    case "-":
    case "*":
    case "/":
      return { _tag: "Operator", operator: key }
    case "Enter":
    case "=":
      return { _tag: "Equals" }
    case "%":
      return { _tag: "Percent" }
    case "Backspace":
      return { _tag: "Backspace" }
    case "Escape":
    case "c":
    case "C":
      return { _tag: "Clear" }
    case "x":
    case "X":
      return { _tag: "Operator", operator: "*" }
    case "Delete":
      return { _tag: "ClearEntry" }
    default:
      return undefined
  }
}
