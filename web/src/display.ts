// How this browser shows the app (decision 126): its colours, the device's
// or always light or dark, and its text size. Kept in this browser only, as
// one person's eyes and screen decide them. web/public/display-boot.js sets
// the saved choice on the page before the first paint, so a page never
// flashes in the other colours; it cannot import this module, so
// test/display.test.ts checks that it reads a choice as this module does.

export const Themes = ["system", "light", "dark"] as const
export type Theme = (typeof Themes)[number]

export const TextSizes = ["standard", "larger", "largest"] as const
export type TextSize = (typeof TextSizes)[number]

export interface Display {
  readonly theme: Theme
  readonly textSize: TextSize
}

export const DefaultDisplay: Display = { theme: "system", textSize: "standard" }

export const ThemeNames: Readonly<Record<Theme, string>> = {
  system: "Match this device",
  light: "Light",
  dark: "Dark"
}

export const TextSizeNames: Readonly<Record<TextSize, string>> = {
  standard: "Standard",
  larger: "Larger",
  largest: "Largest"
}

export const DisplayStorageKey = "gmat-prep-display"

const isTheme = (value: unknown): value is Theme => Themes.some((theme) => theme === value)
const isTextSize = (value: unknown): value is TextSize => TextSizes.some((size) => size === value)

// What was saved, or the defaults for anything missing or not understood.
export const parseDisplay = (saved: string | null): Display => {
  if (saved === null) return DefaultDisplay
  try {
    const value: unknown = JSON.parse(saved)
    if (typeof value !== "object" || value === null) return DefaultDisplay
    const { theme, textSize } = value as { readonly theme?: unknown; readonly textSize?: unknown }
    return { theme: isTheme(theme) ? theme : DefaultDisplay.theme, textSize: isTextSize(textSize) ? textSize : DefaultDisplay.textSize }
  } catch {
    return DefaultDisplay
  }
}

// The saved choice, or undefined when none is saved or storage cannot be
// read. Storage can be off, full or refused, as in a private window: a
// choice then lasts until the page closes.
export const savedDisplay = (storage: Pick<Storage, "getItem"> | undefined): Display | undefined => {
  try {
    const saved = storage?.getItem(DisplayStorageKey) ?? null
    return saved === null ? undefined : parseDisplay(saved)
  } catch {
    return undefined
  }
}

export const readDisplay = (storage: Pick<Storage, "getItem"> | undefined): Display =>
  savedDisplay(storage) ?? DefaultDisplay

export const saveDisplay = (storage: Pick<Storage, "setItem"> | undefined, display: Display) => {
  try {
    storage?.setItem(DisplayStorageKey, JSON.stringify(display))
  } catch {
    // Kept for this page only.
  }
}

// A change to one part of the choice, made over the choice saved last
// rather than this page's copy, so another tab's newer change to the other
// part stays.
export const changedDisplay = (saved: Display | undefined, shown: Display, change: Partial<Display>): Display => ({
  ...(saved ?? shown),
  ...change
})

// The choice another tab saved, from a storage event; undefined when the
// event is about another key. A removed choice, or cleared storage, is the
// defaults.
export const displayFromStorageEvent = (
  event: { readonly key: string | null; readonly newValue: string | null }
): Display | undefined =>
  event.key === null || event.key === DisplayStorageKey ? parseDisplay(event.newValue) : undefined

// The styles follow these attributes on the html element.
export const applyDisplay = (root: { readonly dataset: DOMStringMap }, display: Display) => {
  if (display.theme === "system") delete root.dataset.theme
  else root.dataset.theme = display.theme
  if (display.textSize === "standard") delete root.dataset.textSize
  else root.dataset.textSize = display.textSize
}

const storage = () => {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

let current: Display = DefaultDisplay
const listeners = new Set<(display: Display) => void>()

const show = (display: Display) => {
  current = display
  applyDisplay(document.documentElement, display)
  for (const listener of listeners) listener(display)
}

export const currentDisplay = () => current

// Reads the saved choice and applies it; main.tsx calls this before
// rendering. From then on a choice saved in another tab shows here too.
export const startDisplay = () => {
  current = readDisplay(storage())
  applyDisplay(document.documentElement, current)
  window.addEventListener("storage", (event) => {
    const next = displayFromStorageEvent(event)
    if (next !== undefined) show(next)
  })
}

export const changeDisplay = (change: Partial<Display>) => {
  const next = changedDisplay(savedDisplay(storage()), current, change)
  saveDisplay(storage(), next)
  show(next)
}

export const onDisplayChanged = (listener: (display: Display) => void): (() => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

// While a Display panel is open, the exam's keys leave every key alone,
// wherever focus is (decision 126). A panel holds this from opening until
// it closes.
let panelsOpen = 0

export const displayPanelOpen = () => panelsOpen > 0

export const holdDisplayPanelOpen = (): (() => void) => {
  panelsOpen += 1
  return () => {
    panelsOpen -= 1
  }
}
