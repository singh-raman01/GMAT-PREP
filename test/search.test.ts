import { describe, expect, test } from "bun:test"
import type { TaxonomyView } from "../src/api/Taxonomy.ts"
import { findInTaxonomy, highlight, searchTerms } from "../web/src/search.ts"

const marked = (text: string, query: string) =>
  highlight(text, searchTerms(query))
    .map((segment) => (segment.marked ? `[${segment.text}]` : segment.text))
    .join("")

const view = {
  version: 1,
  counts: { sections: 2, topics: 1, skills: 2, questionTypes: 2, mistakeTypes: 1, trapPatterns: 1, strategies: 1 },
  mistakeTypes: [{ id: "misread", name: "Misread", description: "Read a number or a negation incorrectly." }],
  sections: [
    {
      id: "quant",
      name: "Quantitative Reasoning",
      questionTypes: [{ id: "quant.ps", name: "Problem Solving", description: "Choose one of five answers." }],
      topics: [
        {
          id: "quant.number-properties",
          name: "Number properties",
          skills: [
            {
              id: "quant.number-properties.remainders",
              name: "Remainders and units digits",
              description: "Remainders from integer division.",
              appliesTo: ["quant.ps"]
            },
            {
              id: "quant.number-properties.even-odd",
              name: "Even and odd integers",
              description: "Whether sums come out even or odd.",
              appliesTo: ["quant.ps"]
            }
          ]
        }
      ],
      trapPatterns: [
        {
          id: "quant.trap.partial",
          name: "Partial answer",
          description: "An intermediate value offered as the answer.",
          appliesTo: ["quant.ps"]
        }
      ],
      strategies: [
        {
          id: "quant.strategy.plug-in",
          name: "Plug in numbers",
          description: "Replace the variables with easy numbers.",
          validWhen: "The answer choices are expressions.",
          appliesTo: ["quant.ps"]
        }
      ]
    },
    {
      id: "verbal",
      name: "Verbal Reasoning",
      questionTypes: [{ id: "verbal.cr", name: "Critical Reasoning", description: "Évaluer an argument." }],
      topics: [],
      trapPatterns: [],
      strategies: []
    }
  ]
} as unknown as TaxonomyView

describe("searchTerms", () => {
  test("splits on spaces, folds case and accents, and drops repeats", () => {
    expect(searchTerms("  Remainder   RÉSUMÉ remainder ")).toEqual(["remainder", "resume"])
  })

  test("an empty or blank query has no terms", () => {
    expect(searchTerms("")).toEqual([])
    expect(searchTerms("   ")).toEqual([])
  })
})

describe("highlight", () => {
  test("marks every occurrence of every term, ignoring case", () => {
    expect(marked("Even and odd: EVEN sums", "even odd")).toBe("[Even] and [odd]: [EVEN] sums")
  })

  test("merges overlapping and touching matches into one mark", () => {
    expect(marked("integer division", "integ teger")).toBe("[integer] division")
  })

  test("matches accented text with an unaccented query and keeps the original letters", () => {
    expect(marked("Évaluer an argument", "evaluer")).toBe("[Évaluer] an argument")
  })

  test("leaves text unmarked when nothing matches or there are no terms", () => {
    expect(marked("Partial answer", "ratio")).toBe("Partial answer")
    expect(marked("Partial answer", "")).toBe("Partial answer")
  })
})

describe("findInTaxonomy", () => {
  test("finds entries of every kind, grouped by Section in Taxonomy order", () => {
    const groups = findInTaxonomy(view, "answer")
    expect(groups.map((group) => group.id)).toEqual(["quant"])
    expect(groups[0]?.hits.map((hit) => [hit.kind, hit.name])).toEqual([
      ["question-type", "Problem Solving"],
      ["trap-pattern", "Partial answer"],
      ["strategy", "Plug in numbers"]
    ])
  })

  test("every term must match, in the name, the description or the Topic", () => {
    expect(findInTaxonomy(view, "number remainders").flatMap((group) => group.hits.map((hit) => hit.name))).toEqual([
      "Remainders and units digits"
    ])
    expect(findInTaxonomy(view, "remainders ratio")).toEqual([])
  })

  test("a Skill names its Topic, and Mistake Types form their own group", () => {
    const skill = findInTaxonomy(view, "integer")[0]?.hits[0]
    expect(skill?.context).toBe("Skill in Number properties")
    const groups = findInTaxonomy(view, "negation")
    expect(groups.map((group) => [group.id, group.name])).toEqual([["mistakes", "Mistake types"]])
  })

  test("a Strategy is found by when it is valid", () => {
    expect(findInTaxonomy(view, "expressions")[0]?.hits.map((hit) => hit.name)).toEqual(["Plug in numbers"])
  })

  test("a blank query finds nothing", () => {
    expect(findInTaxonomy(view, "  ")).toEqual([])
  })
})
