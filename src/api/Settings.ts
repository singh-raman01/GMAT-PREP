import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { CuratorSession } from "./Curator.ts"

// The LLM tasks, each routed to the model the Curator picks for it.
export const LlmTasks = [
  "book-map",
  "extraction",
  "solving",
  "tagging",
  "approaches",
  "generation",
  "statement-translation",
  "lessons",
  "tutor-chat"
] as const

export const LlmTask = Schema.Literals(LlmTasks)
export type LlmTask = typeof LlmTask.Type

export const LlmTaskLabels: Record<LlmTask, string> = {
  "book-map": "Book Map",
  "extraction": "Extraction",
  "solving": "Solving",
  "tagging": "Tagging",
  "approaches": "Approaches",
  "generation": "Generation",
  "statement-translation": "Statement translation",
  "lessons": "Lessons",
  "tutor-chat": "Tutor Chat"
}

// How a request asks for JSON. Every reply is checked against its schema
// whichever way is used; providers differ in what they accept.
export const JsonMode = Schema.Literals(["json-schema", "json-object", "instructions"])
export type JsonMode = typeof JsonMode.Type

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value)
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === ""
  } catch {
    return false
  }
}

export const BaseUrl = Schema.String.check(
  Schema.makeFilter(isHttpUrl, { description: "an http or https URL without a user name or password" })
)

export const ModelName = Schema.String.check(
  Schema.makeFilter((name: string) => name.trim().length >= 1 && name.trim().length <= 200, {
    description: "a model name of 1 to 200 characters"
  })
)

// US dollars per million tokens.
export const Price = Schema.Number.check(
  Schema.makeFilter((price: number) => Number.isFinite(price) && price >= 0 && price <= 100_000, {
    description: "a price from 0 to 100000 dollars per million tokens"
  })
)

const TaskModelFields = {
  task: LlmTask,
  model: Schema.NullOr(ModelName)
}

const ModelPriceFields = {
  model: ModelName,
  inputPerMillion: Price,
  outputPerMillion: Price
}

export class TaskModel extends Schema.Class<TaskModel>("gmat-prep/api/TaskModel")(TaskModelFields) {}

export class ModelPrice extends Schema.Class<ModelPrice>("gmat-prep/api/ModelPrice")(ModelPriceFields) {}

export class ApiKeyStatus extends Schema.Class<ApiKeyStatus>("gmat-prep/api/ApiKeyStatus")({
  saved: Schema.Boolean,
  // The last four characters, so the Curator can tell which key is saved.
  endsWith: Schema.NullOr(Schema.String),
  // Where the key is kept, outside the data folder.
  file: Schema.String
}) {}

export class LlmSettingsView extends Schema.Class<LlmSettingsView>("gmat-prep/api/LlmSettingsView")({
  baseUrl: Schema.NullOr(Schema.String),
  jsonMode: JsonMode,
  models: Schema.Array(TaskModel),
  prices: Schema.Array(ModelPrice),
  apiKey: ApiKeyStatus
}) {}

export const LlmSettingsInput = Schema.Struct({
  baseUrl: BaseUrl,
  jsonMode: JsonMode,
  models: Schema.Array(Schema.Struct(TaskModelFields)),
  prices: Schema.Array(Schema.Struct(ModelPriceFields))
})
export type LlmSettingsInput = typeof LlmSettingsInput.Type

export const ApiKey = Schema.String.check(
  Schema.makeFilter((key: string) => key.trim().length >= 8 && key.trim().length <= 1000 && !/\s/.test(key.trim()), {
    description: "an API key of 8 to 1000 characters with no spaces"
  })
)

export class SettingsApi extends HttpApiGroup.make("settings")
  .add(
    HttpApiEndpoint.get("llm", "/settings/llm", {
      success: LlmSettingsView
    }),
    HttpApiEndpoint.put("saveLlm", "/settings/llm", {
      payload: LlmSettingsInput,
      success: LlmSettingsView
    }),
    HttpApiEndpoint.put("saveApiKey", "/settings/api-key", {
      payload: Schema.Struct({ apiKey: ApiKey }),
      success: ApiKeyStatus
    }),
    HttpApiEndpoint.delete("removeApiKey", "/settings/api-key", {
      success: ApiKeyStatus
    })
  )
  .middleware(CuratorSession)
  .prefix("/api/curator")
{}
