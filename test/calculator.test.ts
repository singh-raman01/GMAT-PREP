import { describe, expect, test } from "bun:test"
import { type CalculatorState, initialState, type Key, keyOf, press } from "../web/src/practice/calculator.ts"

// Presses keys as typed: digits, a point, + - * /, =, and named keys.
const named: Readonly<Record<string, Key>> = {
  sqrt: { _tag: "SquareRoot" },
  neg: { _tag: "Negate" },
  CE: { _tag: "ClearEntry" },
  C: { _tag: "Clear" },
  MC: { _tag: "MemoryClear" },
  MR: { _tag: "MemoryRecall" },
  "M+": { _tag: "MemoryAdd" },
  "M-": { _tag: "MemorySubtract" },
  back: { _tag: "Backspace" }
}

const run = (keys: string, from: CalculatorState = initialState) =>
  keys.split(" ").filter((key) => key !== "").reduce((state, typed) => {
    const key = named[typed] ?? keyOf(typed)
    if (key === undefined) {
      return [...typed].reduce((inner, char) => press(inner, keyOf(char)!), state)
    }
    return press(state, key)
  }, from)

describe("The calculator", () => {
  test("adds, subtracts, multiplies and divides, one step after another", () => {
    expect(run("12 + 30 =").display).toBe("42")
    expect(run("7 - 10 =").display).toBe("-3")
    expect(run("2.5 * 4 =").display).toBe("10")
    expect(run("1 / 3 =").display).toBe("0.333333333333")
    // Each operator finishes the step before it.
    expect(run("2 + 3 * 4 =").display).toBe("20")
    // A second operator in a row replaces the first.
    expect(run("9 + - 4 =").display).toBe("5")
    expect(run("0.1 + 0.2 =").display).toBe("0.3")
  })

  test("takes square roots and percents", () => {
    expect(run("144 sqrt").display).toBe("12")
    expect(run("2 sqrt").display).toBe("1.41421356237")
    // A percent of the number before a plus or minus, else a hundredth.
    expect(run("200 + 15 % =").display).toBe("230")
    expect(run("80 * 25 % =").display).toBe("20")
    expect(run("45 %").display).toBe("0.45")
  })

  test("keeps a memory through clears and errors", () => {
    const stored = run("12 M+ 30 M+ C")
    expect(stored).toMatchObject({ display: "0", memory: 42 })
    expect(run("MR / 2 =", stored).display).toBe("21")
    expect(run("5 M- MR", stored).display).toBe("37")
    expect(run("MC MR", stored).display).toBe("0")
  })

  test("says when a step cannot be done, and starts again on the next key", () => {
    const divided = run("5 / 0 =")
    expect(divided).toMatchObject({ display: "Cannot divide by zero", error: true })
    expect(run("7", divided)).toMatchObject({ display: "7", error: false })
    expect(run("9 neg sqrt").display).toBe("Not a number")
  })

  test("edits the entry: back, clear entry, sign and one point", () => {
    expect(run("123 back").display).toBe("12")
    expect(run("12 + 34 CE 5 =").display).toBe("17")
    expect(run("3 neg").display).toBe("-3")
    expect(run("1.2.3").display).toBe("1.23")
  })
})
