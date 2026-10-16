import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fitsSlot } from "../src/api/blueprint.ts"
import { type GateInput, gateReasons } from "../src/server/review/gate.ts"
import { reserveDecisions, type ReserveUnit } from "../src/server/review/reserve.ts"
import { parseTaxonomy } from "../src/server/taxonomy/Taxonomy.ts"

const taxonomy = await Effect.runPromise(parseTaxonomy(await Bun.file("taxonomy/v1.yaml").text()))

// A Problem Solving Question that passes every check.
const passing: GateInput = {
  questionType: "quant.ps",
  linkReasons: [],
  enriched: true,
  key: "C",
  optionLabels: ["A", "B", "C", "D", "E"],
  primarySkill: "quant.number-properties.remainders",
  secondarySkills: [],
  difficultyEstimate: 0.2,
  bookLabel: "medium",
  solverAnswers: ["C", "C", "C"],
  approaches: [{ strategy: "quant.strategy.solve-directly", answer: "C", author: "llm" }],
  notes: ["A", "B", "D", "E"].map((label) => ({ label, mistakeType: "calculation-slip", trapPattern: null }))
}

const codes = (input: GateInput) => gateReasons(taxonomy, input).map((reason) => reason.code)

describe("The Publish Gate", () => {
  test("a Question that passes every check has no reasons", () => {
    expect(gateReasons(taxonomy, passing)).toEqual([])
  })

  test("any solve that disagrees with the key holds the Question, as does a missing solve", () => {
    expect(gateReasons(taxonomy, { ...passing, solverAnswers: ["C", "D", "C"] })).toEqual([
      { code: "solver-disagreement", detail: "Independent solves answered C, D and C; the key is C." }
    ])
    expect(codes({ ...passing, solverAnswers: ["C", "C"] })).toEqual(["solver-disagreement"])
  })

  test("Skills outside the Taxonomy or not for the Question Type, and Time pressure on an option, hold it", () => {
    expect(gateReasons(taxonomy, { ...passing, primarySkill: "verbal.reading.inference" })).toEqual([
      { code: "tags", detail: "The primary Skill verbal.reading.inference does not fit quant.ps." }
    ])
    expect(codes({ ...passing, secondarySkills: ["quant.made-up"] })).toEqual(["tags"])
    expect(gateReasons(taxonomy, {
      ...passing,
      notes: [...passing.notes.slice(1), { label: "A", mistakeType: "time-pressure", trapPattern: null }]
    })).toEqual([{ code: "tags", detail: "An option is tagged Time pressure, which only timing gives." }])
  })

  test("a Book Label two bands from the estimate holds it; one band apart does not", () => {
    expect(codes({ ...passing, bookLabel: "easy", difficultyEstimate: 0.9 })).toEqual(["difficulty"])
    expect(codes({ ...passing, bookLabel: "easy", difficultyEstimate: 0.3 })).toEqual([])
    expect(codes({ ...passing, bookLabel: null, difficultyEstimate: 1.9 })).toEqual([])
  })

  test("Approaches must reach the key, and every wrong choice needs a note, the key none", () => {
    expect(codes({ ...passing, approaches: [] })).toEqual(["approach-misses-key"])
    expect(codes({ ...passing, approaches: [{ ...passing.approaches[0]!, answer: "B" }] })).toEqual([
      "approach-misses-key"
    ])
    // The Book's own explanation is not checked against the key here.
    expect(codes({ ...passing, approaches: [...passing.approaches, { strategy: "quant.strategy.solve-directly", answer: "D", author: "book" }] }))
      .toEqual([])
    expect(gateReasons(taxonomy, { ...passing, notes: passing.notes.slice(0, 2) })).toEqual([
      { code: "option-notes", detail: "No note for the wrong choices D and E." }
    ])
    expect(codes({ ...passing, notes: [...passing.notes, { label: "C", mistakeType: "trap", trapPattern: null }] }))
      .toEqual(["option-notes"])
  })

  test("text in doubt is held for its link reasons alone, and a Question with no key skips the key's checks", () => {
    const render = { code: "render" as const, detail: "It does not render." }
    expect(gateReasons(taxonomy, { ...passing, linkReasons: [render], enriched: false, primarySkill: null })).toEqual([render])
    const noKey = { code: "no-key" as const, detail: "No key." }
    expect(gateReasons(taxonomy, { ...passing, linkReasons: [noKey], key: null, approaches: [], notes: [] })).toEqual([noKey])
  })
})

const unit = (id: string, questionType: string, band: ReserveUnit["band"], reserve: boolean | null = null, size = 1) =>
  ({ id, size, questionType, band, hash: `hash-${id}`, reserve }) satisfies ReserveUnit

describe("The Mock Reserve", () => {
  test("a quarter of a Book's Section joins, spread over Question Types and Difficulty Bands, the same way every time", () => {
    const units = [
      ...Array.from({ length: 8 }, (_, i) => unit(`e${i}`, "quant.ps", "easy")),
      ...Array.from({ length: 8 }, (_, i) => unit(`m${i}`, "quant.ps", "medium")),
      ...Array.from({ length: 4 }, (_, i) => unit(`h${i}`, "quant.ps", "hard"))
    ]
    const decisions = reserveDecisions(units)
    const joined = [...decisions].filter(([, reserve]) => reserve).map(([id]) => id)
    expect(joined).toEqual(["e0", "e1", "m0", "m1", "h0"])
    expect(decisions.size).toBe(20)
    expect([...reserveDecisions(units)]).toEqual([...decisions])
  })

  test("a unit is decided once, and later units make up a shortfall", () => {
    const decided = Array.from({ length: 4 }, (_, i) => unit(`a${i}`, "quant.ps", "medium", false))
    const later = Array.from({ length: 4 }, (_, i) => unit(`b${i}`, "quant.ps", "medium"))
    const decisions = reserveDecisions([...decided, ...later])
    expect([...decisions].filter(([, reserve]) => reserve).map(([id]) => id)).toEqual(["b0", "b1"])
    expect(decisions.has("a0")).toBe(false)
  })

  test("only units that fit a Section Blueprint slot can join", () => {
    expect(fitsSlot("verbal.rc-detail", 3)).toBe(true)
    expect(fitsSlot("verbal.rc-detail", 5)).toBe(false)
    expect(fitsSlot("di.msr", 3)).toBe(true)
    const passages = [
      unit("p1", "verbal.rc-detail", "medium", null, 5),
      ...Array.from({ length: 4 }, (_, i) => unit(`p${i + 2}`, "verbal.rc-detail", "medium", null, 3))
    ]
    const decisions = reserveDecisions(passages)
    expect(decisions.get("p1")).toBe(false)
    expect([...decisions].filter(([, reserve]) => reserve).map(([id]) => id)).toEqual(["p2"])
  })
})
