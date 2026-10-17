import { describe, expect, test } from "bun:test"
import { applyDisplay, DefaultDisplay, parseDisplay, readDisplay, saveDisplay } from "../web/src/display.ts"

// This browser's colours and text size (decision 126): read safely, kept
// only as far as storage allows, and applied as attributes the styles follow.

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
    const refusing = {
      getItem: () => {
        throw new Error("SecurityError")
      },
      setItem: () => {
        throw new Error("QuotaExceededError")
      }
    }
    expect(readDisplay(refusing)).toEqual(DefaultDisplay)
    expect(readDisplay(undefined)).toEqual(DefaultDisplay)
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
