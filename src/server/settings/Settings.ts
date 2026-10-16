import { eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { JsonMode, type LlmSettingsInput, LlmTask, LlmTaskLabels } from "../../api/Settings.ts"
import { Db } from "../db/Database.ts"
import { settings } from "../db/schema.ts"

// The Curator's LLM settings. Prices are US dollars per million tokens.
export interface LlmSettings {
  readonly baseUrl: string | null
  readonly jsonMode: JsonMode
  readonly models: Partial<Record<LlmTask, string>>
  readonly prices: Readonly<Record<string, { readonly input: number; readonly output: number }>>
}

const StoredLlmSettings = Schema.Struct({
  baseUrl: Schema.NullOr(Schema.String),
  jsonMode: JsonMode,
  models: Schema.Record(LlmTask, Schema.optional(Schema.String)),
  prices: Schema.Record(Schema.String, Schema.Struct({ input: Schema.Number, output: Schema.Number }))
})
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(StoredLlmSettings))

export const emptyLlmSettings: LlmSettings = { baseUrl: null, jsonMode: "json-schema", models: {}, prices: {} }

const LlmKey = "llm"

// What still has to be set before a task can call the LLM, in words.
export const missingSettings = (llm: LlmSettings, hasApiKey: boolean, task: LlmTask): ReadonlyArray<string> => {
  const model = llm.models[task]
  return [
    ...(llm.baseUrl === null ? ["the API base URL"] : []),
    ...(hasApiKey ? [] : ["the API key"]),
    ...(model === undefined ? [`a model for ${LlmTaskLabels[task]}`] : []),
    ...(model !== undefined && llm.prices[model] === undefined ? [`prices for ${model}`] : [])
  ]
}

// The URL the chat completions request goes to.
export const completionsUrl = (baseUrl: string) => {
  const trimmed = baseUrl.trim().replace(/\/+$/, "")
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`
}

export class Settings extends Context.Service<Settings, {
  readonly llm: Effect.Effect<LlmSettings>
  saveLlm(input: LlmSettingsInput): Effect.Effect<LlmSettings>
}>()("gmat-prep/server/Settings") {
  static readonly layer = Layer.effect(
    Settings,
    Effect.gen(function*() {
      const db = yield* Db

      const llm = Effect.gen(function*() {
        const rows = yield* db.select().from(settings).where(eq(settings.key, LlmKey)).pipe(Effect.orDie)
        const row = rows[0]
        if (row === undefined) return emptyLlmSettings
        const stored = decodeStored(row.value)
        if (Option.isNone(stored)) {
          yield* Effect.logWarning("The saved LLM settings could not be read; showing them as empty")
          return emptyLlmSettings
        }
        return stored.value as LlmSettings
      })

      const saveLlm = Effect.fn("Settings.saveLlm")(function*(input: LlmSettingsInput) {
        const models: Record<string, string> = {}
        for (const { task, model } of input.models) {
          if (model !== null && model.trim() !== "") models[task] = model.trim()
        }
        const prices: Record<string, { input: number; output: number }> = {}
        for (const price of input.prices) {
          prices[price.model.trim()] = { input: price.inputPerMillion, output: price.outputPerMillion }
        }
        const value: LlmSettings = {
          baseUrl: input.baseUrl.trim(),
          jsonMode: input.jsonMode,
          models,
          prices
        }
        const updatedAt = yield* Clock.currentTimeMillis
        yield* db.insert(settings)
          .values({ key: LlmKey, value: JSON.stringify(value), updatedAt })
          .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(value), updatedAt } })
          .pipe(Effect.orDie)
        return value
      })

      return Settings.of({ llm, saveLlm })
    })
  )
}
