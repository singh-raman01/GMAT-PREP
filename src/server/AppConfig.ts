import { Config, Context, Effect, Layer } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"

export interface AppConfigShape {
  readonly dataDir: string
  readonly preferredPort: number
}

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()("gmat-prep/server/AppConfig") {
  static readonly layer = (config: AppConfigShape) => Layer.succeed(AppConfig, AppConfig.of(config))

  // GMAT_PREP_DATA_DIR and GMAT_PREP_PORT override the defaults.
  static readonly layerFromEnv = Layer.effect(
    AppConfig,
    Effect.gen(function*() {
      const fallbackDir = yield* defaultDataDir
      const dataDir = yield* Config.String("GMAT_PREP_DATA_DIR").pipe(Config.withDefault(fallbackDir))
      const preferredPort = yield* Config.Port("GMAT_PREP_PORT").pipe(Config.withDefault(4747))
      return AppConfig.of({ dataDir, preferredPort })
    })
  )
}

// The OS's usual place for application data.
const defaultDataDir = Effect.gen(function*() {
  const home = yield* Config.String("HOME").pipe(Config.withDefault(homedir()))
  switch (process.platform) {
    case "darwin":
      return join(home, "Library", "Application Support", "gmat-prep")
    case "win32": {
      const appData = yield* Config.String("APPDATA").pipe(Config.withDefault(join(home, "AppData", "Roaming")))
      return join(appData, "gmat-prep")
    }
    default: {
      const xdg = yield* Config.String("XDG_DATA_HOME").pipe(Config.withDefault(join(home, ".local", "share")))
      return join(xdg, "gmat-prep")
    }
  }
})
