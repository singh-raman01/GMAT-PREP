import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { chartWidth } from "../web/src/charts/charts.tsx"
import {
  applyDisplay,
  changedDisplay,
  DefaultDisplay,
  type Display,
  displayFromStorageEvent,
  DisplayStorageKey,
  parseDisplay,
  readDisplay,
  saveDisplay,
  savedDisplay,
  TextSizes,
  Themes
} from "../web/src/display.ts"

// This browser's colours and text size (decision 126): read safely, kept
// only as far as storage allows, applied as attributes the styles follow,
// before the first paint by the boot script, and in step across tabs.

const web = join(import.meta.dir, "..", "web")

const storageHolding = (saved: string | null) => ({ getItem: (key: string) => (key === DisplayStorageKey ? saved : null) })

const refusing = {
  getItem: (): string | null => {
    throw new Error("SecurityError")
  },
  setItem: () => {
    throw new Error("QuotaExceededError")
  }
}

describe("Display choices", () => {
  test("a saved choice is read back, and anything not understood falls back to the defaults", () => {
    expect(parseDisplay(JSON.stringify({ theme: "dark", textSize: "largest" }))).toEqual({ theme: "dark", textSize: "largest" })
    expect(parseDisplay(null)).toEqual(DefaultDisplay)
    expect(parseDisplay("not json")).toEqual(DefaultDisplay)
    expect(parseDisplay("[]")).toEqual(DefaultDisplay)
    expect(parseDisplay(JSON.stringify({ theme: "sepia", textSize: "larger" }))).toEqual({ theme: "system", textSize: "larger" })
    expect(parseDisplay(JSON.stringify({ theme: "light", textSize: 3 }))).toEqual({ theme: "light", textSize: "standard" })
  })

  test("storage that is off or refuses keeps the defaults, and saving to it does not fail", () => {
    expect(readDisplay(refusing)).toEqual(DefaultDisplay)
    expect(readDisplay(undefined)).toEqual(DefaultDisplay)
    expect(savedDisplay(refusing)).toBeUndefined()
    expect(savedDisplay(storageHolding(null))).toBeUndefined()
    expect(() => saveDisplay(refusing, { theme: "dark", textSize: "larger" })).not.toThrow()
    const kept = new Map<string, string>()
    const storage = { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) }
    saveDisplay(storage, { theme: "light", textSize: "largest" })
    expect(readDisplay(storage)).toEqual({ theme: "light", textSize: "largest" })
  })

  test("the choice is set on the html element, and the defaults leave no attribute", () => {
    const root = { dataset: {} as DOMStringMap }
    applyDisplay(root, { theme: "dark", textSize: "larger" })
    expect({ ...root.dataset }).toEqual({ theme: "dark", textSize: "larger" })
    applyDisplay(root, DefaultDisplay)
    expect({ ...root.dataset }).toEqual({})
  })
})

describe("Display choices across tabs", () => {
  test("a change is made over the choice saved last, so a tab that missed another tab's change keeps it", () => {
    // Tab A chose Dark; tab B, still showing the defaults, chooses Largest.
    const saved: Display = { theme: "dark", textSize: "standard" }
    expect(changedDisplay(saved, DefaultDisplay, { textSize: "largest" })).toEqual({ theme: "dark", textSize: "largest" })
    // The part changed is the newest choice, whatever was saved.
    expect(changedDisplay(saved, DefaultDisplay, { theme: "light" })).toEqual({ theme: "light", textSize: "standard" })
    // With nothing saved, or storage refused, the change is made over this page's choice.
    const shown: Display = { theme: "light", textSize: "larger" }
    expect(changedDisplay(undefined, shown, { theme: "dark" })).toEqual({ theme: "dark", textSize: "larger" })
  })

  test("another tab's saved choice is taken up, and other keys are not", () => {
    const event = (key: string | null, newValue: string | null) => ({ key, newValue })
    expect(displayFromStorageEvent(event(DisplayStorageKey, JSON.stringify({ theme: "dark", textSize: "largest" }))))
      .toEqual({ theme: "dark", textSize: "largest" })
    expect(displayFromStorageEvent(event("gmat-prep-timer", "{}"))).toBeUndefined()
    // Removed in the other tab, or all storage cleared: the defaults.
    expect(displayFromStorageEvent(event(DisplayStorageKey, null))).toEqual(DefaultDisplay)
    expect(displayFromStorageEvent(event(null, null))).toEqual(DefaultDisplay)
    expect(displayFromStorageEvent(event(DisplayStorageKey, "garbage"))).toEqual(DefaultDisplay)
  })
})

describe("The boot script", () => {
  const source = readFileSync(join(web, "public", "display-boot.js"), "utf8")
  const boot = new Function("localStorage", "document", source) as (
    storage: Pick<Storage, "getItem">,
    document: { readonly documentElement: { readonly dataset: DOMStringMap } }
  ) => void
  const booted = (storage: Pick<Storage, "getItem">) => {
    const root = { dataset: {} as DOMStringMap }
    boot(storage, { documentElement: root })
    return { ...root.dataset }
  }
  const applied = (storage: Pick<Storage, "getItem">) => {
    const root = { dataset: {} as DOMStringMap }
    applyDisplay(root, readDisplay(storage))
    return { ...root.dataset }
  }

  test("sets what display.ts would, for every choice and anything else saved", () => {
    const themes: ReadonlyArray<unknown> = [...Themes, "sepia", "", 3, null, undefined]
    const sizes: ReadonlyArray<unknown> = [...TextSizes, "huge", 2, true, undefined]
    const saved: Array<string | null> = [null, "", "not json", "[]", "null", "7", "\"dark\"", "{\"theme\":\"dark\""]
    for (const theme of themes) for (const textSize of sizes) saved.push(JSON.stringify({ theme, textSize }))
    for (const each of saved) expect({ saved: each, set: booted(storageHolding(each)) }).toEqual({ saved: each, set: applied(storageHolding(each)) })
    expect(booted(storageHolding(JSON.stringify({ theme: "dark", textSize: "largest" })))).toEqual({ theme: "dark", textSize: "largest" })
    expect(booted(refusing)).toEqual({})
  })

  test("runs from the page head as a classic script, before the app's module", () => {
    const page = readFileSync(join(web, "index.html"), "utf8")
    const head = page.slice(page.indexOf("<head>"), page.indexOf("</head>"))
    expect(head).toContain(`<script src="/display-boot.js"></script>`)
    expect(page.indexOf("/display-boot.js")).toBeLessThan(page.indexOf(`type="module"`))
  })
})

describe("Chart sizes", () => {
  test("a chart's units grow with the text size, so its labels do too", () => {
    // Standard text: a unit is a pixel, up to 640.
    expect(chartWidth(343, 16)).toBe(343)
    expect(chartWidth(880, 16)).toBe(640)
    // Largest text, 20px: 335px shown is 268 units, each 1.25px.
    expect(chartWidth(335, 20)).toBe(268)
    expect(chartWidth(880, 20)).toBe(640)
    // Never narrower than 200 units, and a root size not read is the standard.
    expect(chartWidth(0, 20)).toBe(200)
    expect(chartWidth(500, Number.NaN)).toBe(500)
  })
})
