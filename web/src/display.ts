// How this browser shows the app (decision 126): its colours, the device's
// or always light or dark, and its text size. Kept in this browser only, as
// one person's eyes and screen decide them, and applied before the first
// paint so a page never flashes in the other colours.

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

const StorageKey = "gmat-prep-display"

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

// Storage can be off, full or refused, as in a private window: the choice
// then lasts until the page closes.
export const readDisplay = (storage: Pick<Storage, "getItem"> | undefined): Display => {
  try {
    return parseDisplay(storage?.getItem(StorageKey) ?? null)
  } catch {
    return DefaultDisplay
  }
}

export const saveDisplay = (storage: Pick<Storage, "setItem"> | undefined, display: Display) => {
  try {
    storage?.setItem(StorageKey, JSON.stringify(display))
  } catch {
    // Kept for this page only.
  }
}

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

export const currentDisplay = () => current

// Reads the saved choice and applies it; main.tsx calls this before rendering.
export const startDisplay = () => {
  current = readDisplay(storage())
  applyDisplay(document.documentElement, current)
}

export const changeDisplay = (next: Display) => {
  current = next
  applyDisplay(document.documentElement, next)
  saveDisplay(storage(), next)
  for (const listener of listeners) listener(next)
}

export const onDisplayChanged = (listener: (display: Display) => void): (() => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
