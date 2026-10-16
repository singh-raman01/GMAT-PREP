import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { parseTaxonomy } from "../src/server/taxonomy/Taxonomy.ts"
import { openBrowser, runWithApp } from "./harness.ts"

describe("Taxonomy", () => {
  test("an unlocked Learner browses Taxonomy v1 with all its lists", () =>
    runWithApp(Effect.gen(function*() {
      const browser = yield* openBrowser
      yield* browser.profiles.create({ payload: { name: "Asha" } })
      const taxonomy = yield* browser.taxonomy.current()
      expect(taxonomy.version).toBe(1)
      expect(taxonomy.counts).toEqual({
        sections: 3,
        topics: 13,
        skills: 52,
        questionTypes: 21,
        mistakeTypes: 6,
        trapPatterns: 38,
        strategies: 21
      })
      expect(taxonomy.sections.map((section) => section.name)).toEqual([
        "Quantitative Reasoning",
        "Verbal Reasoning",
        "Data Insights"
      ])
    })))

  test("the Taxonomy needs an unlocked Profile", () =>
    runWithApp(Effect.gen(function*() {
      const browser = yield* openBrowser
      const error = yield* browser.taxonomy.current().pipe(Effect.flip)
      expect(error._tag).toBe("NotUnlocked")
    })))

  test("a Taxonomy whose entry points at an unknown Question Type is rejected", async () => {
    const file = `
version: 2
mistake_types: []
sections:
  - id: quant
    name: Quantitative Reasoning
    question_types:
      - { id: quant.ps, name: Problem Solving, description: Solve it }
    topics: []
    trap_patterns:
      - { id: quant.trap.wrong-quantity, name: Wrong quantity, description: Answers another thing, applies_to: [quant.ds] }
    strategies: []
`
    const error = await Effect.runPromise(parseTaxonomy(file).pipe(Effect.flip))
    expect(error.problems).toEqual(["quant.trap.wrong-quantity applies to unknown Question Type quant.ds"])
  })

  test("a Taxonomy with a repeated id is rejected", async () => {
    const file = `
version: 2
mistake_types:
  - { id: misread, name: Misread, description: Read it wrong }
  - { id: misread, name: Misread again, description: Read it wrong twice }
sections: []
`
    const error = await Effect.runPromise(parseTaxonomy(file).pipe(Effect.flip))
    expect(error.problems).toEqual(["duplicate id misread"])
  })
})

describe("Health", () => {
  test("health reports ok and the worker state", () =>
    runWithApp(Effect.gen(function*() {
      const browser = yield* openBrowser
      const health = yield* browser.health()
      expect(health.status).toBe("ok")
      expect(health.worker.running).toBe(false)
    })))
})
