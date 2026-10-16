import { Schema } from "effect"

// The JSON Schema sent with each LLM request. Strict structured outputs accept
// a narrow form: an object at the root, every property listed as required, no
// extra properties, and few keywords. That form is also the clearest for
// models told the schema in the prompt, so every JSON mode gets it.
//
// The reply is still decoded with the full Effect schema, which enforces the
// constraints dropped here, such as lengths and ranges. An output schema that
// strict mode cannot express is a programming error, so this throws; a test
// runs it on every task's output schema.

export interface StrictJsonSchema {
  readonly jsonSchema: object
  // The root is not an object, so the output is sent as { value } and taken
  // back out of the reply.
  readonly wrapped: boolean
}

// Keywords kept as they are. Validation keywords not listed are dropped.
const Kept = new Set(["type", "enum", "const", "description", "$ref"])

// Keywords that change what a schema means and that strict mode lacks.
const Unsupported = new Set([
  "prefixItems",
  "allOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "propertyNames",
  "dependentSchemas"
])

type Node = Readonly<Record<string, unknown>>

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value)

const allowsNull = (node: Node): boolean =>
  node["type"] === "null" || (Array.isArray(node["anyOf"]) && node["anyOf"].some((branch) => isNode(branch) && allowsNull(branch)))

// How Effect writes a number that may be NaN or infinite.
const isNonFiniteBranch = (node: unknown): boolean =>
  isNode(node) && node["type"] === "string" && Array.isArray(node["enum"]) &&
  ["Infinity", "-Infinity", "NaN"].every((value) => (node["enum"] as ReadonlyArray<unknown>).includes(value))

const strict = (node: unknown, path: string): Node => {
  if (!isNode(node)) throw new Error(`${path} has a schema strict mode cannot express`)
  for (const key of Object.keys(node)) {
    if (Unsupported.has(key)) throw new Error(`${path} uses ${key}, which strict mode does not support`)
  }
  const anyOf = node["anyOf"]
  if (Array.isArray(anyOf) && anyOf.some(isNonFiniteBranch)) {
    throw new Error(`${path} is a number that may be NaN or infinite; use Schema.Finite or Schema.Int`)
  }

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (Kept.has(key)) result[key] = value
  }
  if (Array.isArray(anyOf)) result["anyOf"] = anyOf.map((branch) => strict(branch, path))
  if (node["items"] !== undefined) result["items"] = strict(node["items"], `${path}[]`)

  const properties = node["properties"]
  if (node["type"] === "object" || properties !== undefined) {
    if (node["additionalProperties"] !== undefined && node["additionalProperties"] !== false) {
      throw new Error(`${path} is a record; strict mode needs fixed keys, so use an array of entries`)
    }
    const required = new Set(Array.isArray(node["required"]) ? node["required"] : [])
    const strictProperties: Record<string, Node> = {}
    for (const [name, child] of Object.entries(isNode(properties) ? properties : {})) {
      const property = strict(child, `${path}.${name}`)
      // Strict mode lists every property as required. Schema.optional
      // already accepts null for a missing value; a key that may be absent
      // but not null has no strict form.
      if (!required.has(name) && !allowsNull(property)) {
        throw new Error(`${path}.${name} may be left out; use Schema.optional or Schema.NullOr instead`)
      }
      strictProperties[name] = property
    }
    result["type"] = "object"
    result["properties"] = strictProperties
    result["required"] = Object.keys(strictProperties)
    result["additionalProperties"] = false
  }
  return result
}

export const strictJsonSchema = (output: Schema.Top): StrictJsonSchema => {
  const document = Schema.toJsonSchemaDocument(output, { onExcessProperty: "error" })
  const definitions = Object.fromEntries(
    Object.entries(document.definitions).map(([name, definition]) => [name, strict(definition, name)])
  )
  const root = strict(document.schema, "the output")
  const wrapped = root["type"] !== "object"
  const schema = wrapped
    ? { type: "object", properties: { value: root }, required: ["value"], additionalProperties: false }
    : root
  return {
    jsonSchema: Object.keys(definitions).length === 0 ? schema : { ...schema, $defs: definitions },
    wrapped
  }
}
