import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AppConfig } from "../AppConfig.ts"

// The LLM API key lives only in a file in the config folder, which is outside
// the data folder, readable by this OS user alone. It never enters the
// database, so no snapshot or export can contain it.

const CredentialsFile = Schema.Struct({ apiKey: Schema.String })
const decodeCredentials = Schema.decodeUnknownOption(Schema.fromJsonString(CredentialsFile))

const isPosix = process.platform !== "win32"

export class ApiKeyStore extends Context.Service<ApiKeyStore, {
  readonly file: string
  readonly read: Effect.Effect<Option.Option<Redacted.Redacted<string>>>
  save(apiKey: string): Effect.Effect<void>
  readonly remove: Effect.Effect<void>
}>()("gmat-prep/server/ApiKeyStore") {
  static readonly layer = Layer.effect(
    ApiKeyStore,
    Effect.gen(function*() {
      const { configDir } = yield* AppConfig
      const file = join(configDir, "credentials.json")

      const read = Effect.gen(function*() {
        if (!existsSync(file)) return Option.none()
        if (isPosix && (statSync(file).mode & 0o077) !== 0) {
          chmodSync(file, 0o600)
          yield* Effect.logWarning(`${file} could be read by other users; it is now readable by you alone`)
        }
        const credentials = decodeCredentials(readFileSync(file, "utf8"))
        if (Option.isNone(credentials) || credentials.value.apiKey.trim() === "") {
          yield* Effect.logWarning(`${file} holds no readable API key`)
          return Option.none()
        }
        return Option.some(Redacted.make(credentials.value.apiKey.trim()))
      }).pipe(Effect.orDie)

      // Written to a temporary file first, so a crash never leaves half a key.
      const save = (apiKey: string) =>
        Effect.sync(() => {
          mkdirSync(configDir, { recursive: true, mode: 0o700 })
          const temporary = `${file}.${process.pid}.tmp`
          writeFileSync(temporary, JSON.stringify({ apiKey: apiKey.trim() }), { mode: 0o600 })
          if (isPosix) chmodSync(temporary, 0o600)
          renameSync(temporary, file)
        })

      const remove = Effect.sync(() => rmSync(file, { force: true }))

      return ApiKeyStore.of({ file, read, save, remove })
    })
  )
}
