import { Effect, Layer } from "effect"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { AppConfig } from "../AppConfig.ts"
import { ReadyDatabaseLive } from "../db/Database.ts"
import { Curator } from "./Curator.ts"

// `gmat-prep reset-passphrase`, run on the host computer: clears the Curator
// passphrase and every Curator unlock. The next visit to the Curator page sets
// a new passphrase. Works whether or not the app is running.
export const ResetPassphrase = Effect.gen(function*() {
  const { dataDir } = yield* AppConfig
  if (!existsSync(join(dataDir, "gmat-prep.sqlite"))) {
    return yield* Effect.logInfo(`There is no database in ${dataDir}, so there is no passphrase to reset.`)
  }
  yield* Effect.gen(function*() {
    const curator = yield* Curator
    yield* curator.reset
  }).pipe(Effect.provide(Curator.layer.pipe(Layer.provide(ReadyDatabaseLive))))
  yield* Effect.logInfo("The Curator passphrase is cleared. Open the Curator page in the app to set a new one.")
}).pipe(Effect.provide(AppConfig.layerFromEnv))
