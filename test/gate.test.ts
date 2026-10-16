import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fitsSlot } from "../src/api/blueprint.ts"
import { approachesProblems, type ApproachesReply, type QuestionText } from "../src/server/books/enrichment.ts"
import { type GateInput, gateReasons } from "../src/server/review/gate.ts"
import { reserveDecisions, type ReserveUnit } from "../src/server/review/reserve.ts"
import { parseTaxonomy } from "../src/server/taxonomy/Taxonomy.ts"

const taxonomy = await Effect.runPromise(parseTaxonomy(await Bun.file("taxonomy/v1.yaml").text()))

const route = (settings: Partial<GateInput["approaches"][number]> = {}): GateInput["approaches"][number] => ({
  strategy: "quant.strategy.solve-directly",
  answer: "C",
  author: "llm",
  steps: "1. Subtract 1, so \\(3x = 12\\).",
  validWhen: "Always.",
  expectedSeconds: 60,
  ...settings
})

const note = (label: string, settings: Partial<GateInput["notes"][number]> = {}): GateInput["notes"][number] => ({
  part: 0,
  label,
  mistakeType: "calculation-slip",
  trapPattern: null,
  trapNote: `${label} comes from a slip.`,
  ...settings
})

// A Problem Solving Question that passes every check.
const passing: GateInput = {
  questionType: "quant.ps",
  hasStimulus: false,
  linkReasons: [],
  enriched: true,
  key: "C",
  parts: [{ labels: ["A", "B", "C", "D", "E"] }],
  primarySkill: "quant.number-properties.remainders",
  secondarySkills: [],
  difficultyEstimate: 0.2,
  bookLabel: "medium",
  solverAnswers: ["C", "C", "C"],
  approaches: [route({ answer: "C" })],
  notes: ["A", "B", "D", "E"].map((label) => note(label))
}

const codes = (input: GateInput) => gateReasons(taxonomy, input).map((reason) => reason.code)

describe("The Publish Gate", () => {
  test("a Question that passes every check has no reasons", () => {
    expect(gateReasons(taxonomy, passing)).toEqual([])
  })

  test("a Data Sufficiency Question takes its maths as its primary Skill and one sufficiency Skill", () => {
    const ds: GateInput = {
      ...passing,
      questionType: "di.ds",
      primarySkill: "quant.number-properties.even-odd",
      secondarySkills: ["di.sufficiency.yes-no"]
    }
    expect(gateReasons(taxonomy, ds)).toEqual([])
    expect(gateReasons(taxonomy, { ...ds, secondarySkills: [] })).toEqual([
      { code: "tags", detail: "It needs exactly one sufficiency Skill among its secondary Skills." }
    ])
    expect(codes({ ...ds, secondarySkills: ["di.sufficiency.yes-no", "di.sufficiency.value"] })).toEqual(["tags"])
    expect(gateReasons(taxonomy, { ...ds, primarySkill: "di.sufficiency.value", secondarySkills: [] })).toEqual([
      { code: "tags", detail: "Its primary Skill is a sufficiency Skill, not its maths." }
    ])
    // A table Skill may join as a secondary, but the primary is the maths.
    expect(codes({ ...ds, secondarySkills: ["di.sufficiency.yes-no", "di.displays.tables"] })).toEqual([])
    expect(gateReasons(taxonomy, { ...ds, primarySkill: "di.displays.tables" })).toEqual([
      { code: "tags", detail: "Its primary Skill should be the maths it tests, a Quant Skill." }
    ])
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
      notes: [...passing.notes.slice(1), note("A", { mistakeType: "time-pressure" })]
    })).toEqual([{ code: "tags", detail: "An option is tagged Time pressure, which only timing gives." }])
  })

  test("a Book Label two bands from the estimate holds it; one band apart does not", () => {
    expect(codes({ ...passing, bookLabel: "easy", difficultyEstimate: 0.9 })).toEqual(["difficulty"])
    expect(codes({ ...passing, bookLabel: "easy", difficultyEstimate: 0.3 })).toEqual([])
    expect(codes({ ...passing, bookLabel: null, difficultyEstimate: 1.9 })).toEqual([])
  })

  test("Approaches must reach the key, and every wrong choice needs a note, the key none", () => {
    expect(codes({ ...passing, approaches: [] })).toEqual(["approach-misses-key"])
    expect(codes({ ...passing, approaches: [route({ answer: "B" })] })).toEqual(["approach-misses-key"])
    // The Book's own explanation must reach the key too, but cannot stand in
    // for an Approach the model wrote.
    expect(gateReasons(taxonomy, { ...passing, approaches: [...passing.approaches, route({ author: "book", answer: "D" })] }))
      .toEqual([{ code: "approach-misses-key", detail: "The book's explanation reaches D, not the key, C." }])
    expect(codes({ ...passing, approaches: [route({ author: "book" })] })).toEqual(["approach-misses-key"])
    expect(gateReasons(taxonomy, { ...passing, notes: passing.notes.slice(0, 2) })).toEqual([
      { code: "option-notes", detail: "No note for the wrong choices D and E." }
    ])
    expect(codes({ ...passing, notes: [...passing.notes, note("C", { mistakeType: "trap" })] })).toEqual(["option-notes"])
  })

  test("teaching text a Learner cannot read holds the Question", () => {
    const broken = "Divide: \\(\\frac{25}{\\) then compare."
    expect(gateReasons(taxonomy, { ...passing, approaches: [route({ steps: broken })] })).toEqual([
      expect.objectContaining({ code: "teaching-text", detail: expect.stringContaining("An Approach's steps cannot be shown") })
    ])
    expect(codes({ ...passing, approaches: [route({ validWhen: "  " })] })).toEqual(["teaching-text"])
    expect(codes({ ...passing, approaches: [...passing.approaches, route({ author: "book", steps: broken })] })).toEqual([
      "teaching-text"
    ])
    expect(codes({ ...passing, approaches: [route({ expectedSeconds: 0 })] })).toEqual(["teaching-text"])
    expect(gateReasons(taxonomy, { ...passing, notes: [...passing.notes.slice(1), note("A", { trapNote: broken })] }))
      .toEqual([expect.objectContaining({ code: "teaching-text", detail: expect.stringContaining("The note for A") })])
  })

  test("text in doubt is held for its link reasons alone, and a Question with no key skips the key's checks", () => {
    const render = { code: "render" as const, detail: "It does not render." }
    expect(gateReasons(taxonomy, { ...passing, linkReasons: [render], enriched: false, primarySkill: null })).toEqual([render])
    // Not enriched for any other reason, it is held for that.
    expect(codes({ ...passing, enriched: false })).toEqual(["not-enriched"])
    const noKey = { code: "no-key" as const, detail: "No key." }
    expect(gateReasons(taxonomy, { ...passing, linkReasons: [noKey], key: null, approaches: [], notes: [] })).toEqual([noKey])
  })

  test("a Question with several Parts needs every Part's key from the solves and Approaches, and a note for each wrong option", () => {
    const statements: GateInput = {
      ...passing,
      questionType: "di.ta",
      hasStimulus: true,
      primarySkill: "di.displays.tables",
      key: "A,B,A",
      parts: [{ labels: ["A", "B"] }, { labels: ["A", "B"] }, { labels: ["A", "B"] }],
      solverAnswers: ["A,B,A", "A,B,A", "A,B,A"],
      approaches: [route({ strategy: "di.strategy.read-and-compute", answer: "A,B,A" })],
      notes: [note("B", { part: 0 }), note("A", { part: 1 }), note("B", { part: 2 })]
    }
    expect(gateReasons(taxonomy, statements)).toEqual([])
    expect(gateReasons(taxonomy, { ...statements, solverAnswers: ["A,B,A", "A,B,B", "A,B,A"] })).toEqual([{
      code: "solver-disagreement",
      detail: "Independent solves answered A,B,A; A,B,B and A,B,A; the key is A,B,A."
    }])
    expect(gateReasons(taxonomy, { ...statements, notes: statements.notes.slice(0, 2) })).toEqual([{
      code: "option-notes",
      detail: "No note for the wrong choice B in Part 3."
    }])
    expect(gateReasons(taxonomy, { ...statements, notes: [...statements.notes, note("B", { part: 1 })] })).toEqual([{
      code: "option-notes",
      detail: "A note treats the key of Part 2, B, as a wrong choice."
    }])
  })

  test("a Reading Comprehension Question with no passage is held, whatever linking found", () => {
    const reading = { ...passing, questionType: "verbal.rc-detail", primarySkill: "verbal.reading.stated-info" }
    expect(gateReasons(taxonomy, { ...reading, hasStimulus: false }).filter((reason) => reason.code === "structure"))
      .toEqual([{ code: "structure", detail: "The readings do not say which passage it asks about." }])
    expect(gateReasons(taxonomy, { ...reading, hasStimulus: true }).filter((reason) => reason.code === "structure")).toEqual([])
  })
})

const unit = (id: string, questionType: string, band: ReserveUnit["band"], reserve: boolean | null = null, size = 1) =>
  ({ id, size, questionType, band, hash: `hash-${id}`, reserve }) satisfies ReserveUnit

describe("An Approaches reply", () => {
  const explained: QuestionText = {
    questionType: "quant.ps",
    stimulus: null,
    stem: "If \\(3x + 1 = 13\\), what is the value of x?",
    parts: [{ kind: "single-choice", prompt: null, options: ["A", "B", "C", "D", "E"].map((label) => ({ label, text: label })) }],
    key: "C",
    explanation: "Subtract 1 and divide by 3."
  }
  const reply = (bookApproach: ApproachesReply["bookApproach"]) =>
    ({
      approaches: [{ strategy: "quant.strategy.solve-directly", steps: "1. Solve.", expectedSeconds: 60, validWhen: "Always.", answer: "C" }],
      bookApproach,
      wrongOptions: ["A", "B", "D", "E"].map((label) => ({
        part: 0,
        label,
        trapNote: `${label} comes from a slip.`,
        mistakeType: "calculation-slip",
        trapPattern: null
      }))
    }) as unknown as ApproachesReply

  test("is asked for again when the Book's Approach cannot be shown, or is missing for a shown explanation", () => {
    const strategy = "quant.strategy.solve-directly"
    expect(approachesProblems(reply({ strategy, expectedSeconds: 60, validWhen: "Always." }), explained)).toEqual([])
    expect(approachesProblems(reply({ strategy, expectedSeconds: 60, validWhen: " " }), explained)).toEqual([
      "The book's Approach's validWhen cannot be shown: it is empty."
    ])
    expect(approachesProblems(reply(null), explained)).toEqual(["The book gives an explanation: give its bookApproach."])
    // With no explanation shown, the Book's Approach is not asked for.
    expect(approachesProblems(reply(null), { ...explained, explanation: null })).toEqual([])
  })
})

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

  test("units published later never push the Reserve past a quarter", () => {
    let units = [unit("e0", "quant.ps", "easy"), unit("e1", "quant.ps", "easy"), unit("m0", "quant.ps", "medium"), unit("m1", "quant.ps", "medium")]
    const apply = (decisions: ReadonlyMap<string, boolean>) =>
      (units = units.map((each) => (decisions.has(each.id) ? { ...each, reserve: decisions.get(each.id)! } : each)))
    apply(reserveDecisions(units))
    expect(units.filter((each) => each.reserve).map((each) => each.id)).toEqual(["e0"])
    units = [...units, unit("m2", "quant.ps", "medium")]
    apply(reserveDecisions(units))
    expect(units.filter((each) => each.reserve).map((each) => each.id)).toEqual(["e0"])
    // Three more bring the quarter to two; the medium band is short, and m2
    // stays out, decided once.
    units = [...units, ...["m3", "h0", "h1"].map((id) => unit(id, "quant.ps", id.startsWith("h") ? "hard" : "medium"))]
    apply(reserveDecisions(units))
    expect(units.filter((each) => each.reserve).map((each) => each.id)).toEqual(["e0", "m3"])
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

  test("a passage counts toward its Blueprint group's share, whatever its Questions' types", () => {
    // Shares by Question Type would give each passage a quarter of three
    // Questions, too few for any to join.
    const passages = ["verbal.rc-detail", "verbal.rc-main-idea", "verbal.rc-inference", "verbal.rc-tone"].map((type, i) =>
      unit(`p${i + 1}`, type, "medium", null, 3)
    )
    expect([...reserveDecisions(passages)].filter(([, reserve]) => reserve).map(([id]) => id)).toEqual(["p1"])
  })
})
