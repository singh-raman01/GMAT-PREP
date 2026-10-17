import { describe, expect, it } from "bun:test"
import { type Schema, SchemaAST } from "effect"
import { MocksApi } from "../src/api/Mocks.ts"
import { PracticeApi } from "../src/api/Practice.ts"
import { SectionalsApi } from "../src/api/Sectionals.ts"
import { examKey, type KeyPress } from "../web/src/practice/examKeys.ts"
import { warningFor, warningText } from "../web/src/practice/Timer.tsx"
import { KeptIds, parseTimerChoices, withChoice } from "../web/src/practice/timerChoices.ts"

// The exam screen's rules (decision 126): pause and the guessed flag belong
// to Practice Sets only, the time warning comes at 5 minutes left, and the
// letter keys and Enter work except where focus has keys of its own or
// while the Display panel is open.

interface Endpoint {
  readonly path: string
  readonly payload: ReadonlyMap<string, { readonly schemas: ReadonlyArray<Schema.Top> }>
}

// The names of the fields an endpoint's payload takes.
const payloadFields = (endpoint: Endpoint) =>
  [...endpoint.payload.values()].flatMap((entry) =>
    entry.schemas.flatMap((schema) =>
      SchemaAST.isObjects(schema.ast) ? schema.ast.propertySignatures.map((field) => String(field.name)) : []
    )
  )

const endpointsOf = (group: { readonly endpoints: object }) => Object.entries(group.endpoints) as Array<[string, Endpoint]>

describe("The exam screen's rules", () => {
  it("gives Sectionals and Mocks no pause and no guessed flag", () => {
    for (const group of [SectionalsApi, MocksApi]) {
      for (const [name, endpoint] of endpointsOf(group)) {
        expect(`${name} ${endpoint.path}`).not.toMatch(/pause|resume|guess/i)
        for (const field of payloadFields(endpoint)) expect(field).not.toMatch(/pause|guess/i)
      }
    }
  })

  it("would see them, as Practice Sets have both", () => {
    const practice = endpointsOf(PracticeApi)
    expect(practice.some(([name]) => name === "pause")).toBe(true)
    const answer = practice.find(([name]) => name === "answer")
    expect(answer).toBeDefined()
    expect(payloadFields(answer![1])).toContain("guessed")
  })

  it("warns at 5 minutes left, or at a fifth of a shorter limit", () => {
    expect(warningFor(45 * 60_000)).toBe(5 * 60_000)
    expect(warningFor(25 * 60_000)).toBe(5 * 60_000)
    expect(warningFor(10 * 60_000)).toBe(2 * 60_000)
    expect(warningFor(2 * 60_000)).toBe(24_000)
  })

  it("words the warning so it stays true while it shows", () => {
    expect(warningText(299_750)).toBe("Under 5 minutes left.")
    expect(warningText(130_000)).toBe("Under 3 minutes left.")
    expect(warningText(119_800)).toBe("Under 2 minutes left.")
    expect(warningText(55_000)).toBe("Under 1 minute left.")
    // A one-Question set warns at a fifth of its 129 seconds.
    expect(warningText(25_800)).toBe("Under 30 seconds left.")
    expect(warningText(4_000)).toBe("Under 10 seconds left.")
  })
})

describe("The exam's keys", () => {
  const letters = ["A", "B", "C", "D", "E"]
  const press = (key: string, rest: Partial<KeyPress> = {}): KeyPress => ({
    key,
    modified: false,
    focus: "page",
    displayOpen: false,
    ...rest
  })

  it("pick an option with A to E, and submit with Enter", () => {
    expect(examKey(press("c"), letters)).toEqual({ _tag: "Pick", label: "C" })
    expect(examKey(press("E"), letters)).toEqual({ _tag: "Pick", label: "E" })
    expect(examKey(press("Enter"), letters)).toEqual({ _tag: "Enter" })
    expect(examKey(press("F"), letters)).toBeUndefined()
    // A Question of several Parts, or one answered, takes no letters.
    expect(examKey(press("c"), [])).toBeUndefined()
  })

  it("leave Enter to a focused button, link or fold's summary, but still take the letters there", () => {
    // As on the Display button once its panel has closed.
    expect(examKey(press("c", { focus: "control" }), letters)).toEqual({ _tag: "Pick", label: "C" })
    expect(examKey(press("Enter", { focus: "control" }), letters)).toBeUndefined()
  })

  it("do nothing while the Display panel is open, wherever focus is", () => {
    for (const focus of ["page", "control", "own", "text"] as const) {
      expect(examKey(press("c", { focus, displayOpen: true }), letters)).toBeUndefined()
      expect(examKey(press("Enter", { focus, displayOpen: true }), letters)).toBeUndefined()
    }
  })

  it("leave keys to a text field, the calculator, the Mistake Type control and the Display panel", () => {
    for (const focus of ["own", "text"] as const) {
      expect(examKey(press("c", { focus }), letters)).toBeUndefined()
      expect(examKey(press("Enter", { focus }), letters)).toBeUndefined()
    }
    expect(examKey(press("c", { modified: true }), letters)).toBeUndefined()
  })
})

describe("The timer's kept choices", () => {
  it("keep each Session's or clock's id once, the latest last, up to a limit", () => {
    expect(withChoice(["a", "b"], "a", true)).toEqual(["b", "a"])
    expect(withChoice(["a", "b"], "a", false)).toEqual(["b"])
    expect(withChoice([], "a", false)).toEqual([])
    const many = Array.from({ length: KeptIds }, (_, index) => `s${index}`)
    const kept = withChoice(many, "new", true)
    expect(kept).toHaveLength(KeptIds)
    expect(kept[0]).toBe("s1")
    expect(kept.at(-1)).toBe("new")
  })

  it("read what was saved, leaving out anything not understood", () => {
    expect(parseTimerChoices(JSON.stringify({ hidden: ["m1"], dismissed: ["s1", 4] }))).toEqual({ hidden: ["m1"], dismissed: ["s1"] })
    expect(parseTimerChoices(null)).toEqual({ hidden: [], dismissed: [] })
    expect(parseTimerChoices("not json")).toEqual({ hidden: [], dismissed: [] })
    expect(parseTimerChoices(JSON.stringify({ hidden: "m1" }))).toEqual({ hidden: [], dismissed: [] })
  })
})
