import { displayPanelOpen } from "../display.ts"

// The exam screen's keys (decision 126): A to E pick an option and Enter
// submits, in Practice Sets, Sectionals and Mocks.

// Where a key press lands, as far as those keys go.
export type KeyFocus =
  // A text field, a list box or editable text, whose keys are its own.
  | "text"
  // The calculator, the Mistake Type control or the Display panel, whose
  // keys are their own too.
  | "own"
  // A button, a link or a fold's summary, which Enter presses.
  | "control"
  // Anywhere else, a radio button or a checkbox included.
  | "page"

export interface KeyPress {
  readonly key: string
  // Alt, Control or Command held.
  readonly modified: boolean
  readonly focus: KeyFocus
  readonly displayOpen: boolean
}

export type ExamKey = { readonly _tag: "Pick"; readonly label: string } | { readonly _tag: "Enter" }

// What a key press does: a letter picks that option when the Question
// offers it (letters is empty when it takes no letters), and Enter submits
// or goes on. Nothing happens with a modifier held, in a control with keys
// of its own, or while the Display panel is open, wherever focus is.
export const examKey = (press: KeyPress, letters: ReadonlyArray<string>): ExamKey | undefined => {
  if (press.modified || press.displayOpen || press.focus === "text" || press.focus === "own") return undefined
  const label = press.key.toUpperCase()
  if (label.length === 1 && letters.includes(label)) return { _tag: "Pick", label }
  return press.key === "Enter" && press.focus !== "control" ? { _tag: "Enter" } : undefined
}

// Keys typed into a text field are the field's; a radio button or a
// checkbox leaves the shortcuts working.
const isTyping = (target: Element) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement ||
    (target instanceof HTMLInputElement && !["radio", "checkbox", "button", "submit"].includes(target.type)))

const keyFocusOf = (target: EventTarget | null): KeyFocus => {
  if (!(target instanceof Element)) return "page"
  if (isTyping(target)) return "text"
  if (target.closest(".calculator, .mistakes, .display-panel") !== null) return "own"
  return target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement || target.matches("summary")
    ? "control"
    : "page"
}

export const keyPressOf = (event: KeyboardEvent): KeyPress => ({
  key: event.key,
  modified: event.altKey || event.ctrlKey || event.metaKey,
  focus: keyFocusOf(event.target),
  displayOpen: displayPanelOpen()
})
