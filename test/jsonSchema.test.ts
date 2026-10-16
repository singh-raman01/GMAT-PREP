import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConnectionTestReply } from "../src/server/jobs/kinds/connectionTest.ts"
import { strictJsonSchema } from "../src/server/llm/jsonSchema.ts"

// Strict structured outputs refuse a schema with an optional property, a
// non-object root or keywords they do not know, so every output schema is
// sent in the form they accept.

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

  test("every task's output schema has a strict form", () => {
    for (const output of [ConnectionTestReply]) {
      expect(() => strictJsonSchema(output)).not.toThrow()
    }
  })
})
