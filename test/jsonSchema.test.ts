import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  approachesOutput,
  approachesPartsOutput,
  type QuestionText,
  SolveOutput,
  solvePartsOutput,
  tagOutput
} from "../src/server/books/enrichment.ts"
import { readingOutputs } from "../src/server/books/readings.ts"
import { ColumnsTranslation, GeneratorOutputs, StatementTranslation } from "../src/server/generation/prompts.ts"
import { surveyReply } from "../src/server/books/survey.ts"
import { ConnectionTestReply } from "../src/server/jobs/kinds/connectionTest.ts"
import { strictJsonSchema } from "../src/server/llm/jsonSchema.ts"
import { parseTaxonomy } from "../src/server/taxonomy/Taxonomy.ts"

// Strict structured outputs refuse a schema with an optional property, a
// non-object root or keywords they do not know, so every output schema is
// sent in the form they accept.

// A Table Analysis Question with two statements, for the schemas of
// Questions with several Parts.
const statements: QuestionText = {
  questionType: "di.ta",
  stimulus: { label: "The table", text: "Region | Sales\nNorth | 1,200" },
  stem: "For each statement, choose Yes if it is true.",
  parts: ["North sold the most.", "Every region grew."].map((prompt) => ({
    kind: "two-choice" as const,
    prompt,
    options: [{ label: "A", text: "Yes" }, { label: "B", text: "No" }]
  })),
  key: "A,B",
  explanation: null
}

describe("Strict JSON Schema", () => {
  test("every property is required, and one that may be missing accepts null instead", () => {
    const { jsonSchema, wrapped } = strictJsonSchema(
      Schema.Struct({ word: Schema.String, note: Schema.optional(Schema.String), count: Schema.NullOr(Schema.Int) })
    )
    expect(wrapped).toBe(false)
    expect(jsonSchema).toEqual({
      type: "object",
      properties: {
        word: { type: "string" },
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
        count: { anyOf: [{ type: "integer" }, { type: "null" }] }
      },
      required: ["word", "note", "count"],
      additionalProperties: false
    })
  })

  test("nested objects, arrays and shared classes keep the same form", () => {
    class Point extends Schema.Class<Point>("Point")({ x: Schema.Finite, y: Schema.Finite }) {}
    const { jsonSchema } = strictJsonSchema(
      Schema.Struct({ points: Schema.Array(Point), kind: Schema.Literals(["a", "b"]) })
    )
    expect(jsonSchema).toMatchObject({
      properties: {
        points: { type: "array", items: { $ref: "#/$defs/PointEncoded" } },
        kind: { type: "string", enum: ["a", "b"] }
      },
      $defs: {
        PointEncoded: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } },
          required: ["x", "y"],
          additionalProperties: false
        }
      }
    })
  })

  test("validation keywords are left to the decoder", () => {
    const { jsonSchema } = strictJsonSchema(
      Schema.Struct({ name: Schema.String.check(Schema.isMinLength(3)), page: Schema.Int })
    )
    expect(jsonSchema).toEqual({
      type: "object",
      properties: { name: { type: "string" }, page: { type: "integer" } },
      required: ["name", "page"],
      additionalProperties: false
    })
  })

  test("a root that is not an object is wrapped as value", () => {
    const { jsonSchema, wrapped } = strictJsonSchema(Schema.Array(Schema.String))
    expect(wrapped).toBe(true)
    expect(jsonSchema).toEqual({
      type: "object",
      properties: { value: { type: "array", items: { type: "string" } } },
      required: ["value"],
      additionalProperties: false
    })
  })

  test("schemas strict mode cannot express are refused with the reason", () => {
    expect(() => strictJsonSchema(Schema.Struct({ n: Schema.Number }))).toThrow("Schema.Finite")
    expect(() => strictJsonSchema(Schema.Struct({ k: Schema.optionalKey(Schema.String) }))).toThrow("Schema.optional")
    expect(() => strictJsonSchema(Schema.Struct({ r: Schema.Record(Schema.String, Schema.Int) }))).toThrow("record")
    expect(() => strictJsonSchema(Schema.Struct({ t: Schema.Tuple([Schema.String, Schema.Int]) }))).toThrow(
      "prefixItems"
    )
  })

  test("every task's output schema has a strict form", async () => {
    const taxonomy = await Effect.runPromise(parseTaxonomy(await Bun.file("taxonomy/v1.yaml").text()))
    const outputs = [
      ConnectionTestReply,
      surveyReply([3, 4, 5]),
      ...readingOutputs(taxonomy),
      ...["quant.ps", "di.ds", "verbal.cr-assumption", "di.ta", "di.gi", "di.tpa", "di.msr"].flatMap((questionType) => [
        tagOutput(taxonomy, questionType),
        approachesOutput(taxonomy, questionType)
      ]),
      SolveOutput,
      solvePartsOutput(statements),
      approachesPartsOutput(taxonomy, statements),
      ...Object.values(GeneratorOutputs),
      StatementTranslation,
      ColumnsTranslation
    ]
    for (const output of outputs) {
      expect(() => strictJsonSchema(output as Schema.Codec<unknown, unknown>)).not.toThrow()
    }
  })
})
