import { describe, expect, it } from "bun:test"
import { type Schema, SchemaAST } from "effect"
import { MocksApi } from "../src/api/Mocks.ts"
import { PracticeApi } from "../src/api/Practice.ts"
import { SectionalsApi } from "../src/api/Sectionals.ts"
import { warningFor } from "../web/src/practice/Timer.tsx"

// The exam screen's rules (decision 126): pause and the guessed flag belong
// to Practice Sets only, and the time warning comes at 5 minutes left.

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
})
