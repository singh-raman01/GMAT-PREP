import { Config, Context, Effect, Layer, Schema } from "effect"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"

export interface AppConfigShape {
  // Database, Books and snapshots.
  readonly dataDir: string
  // Secrets, such as the LLM API key. Always outside the data folder, so no
  // snapshot or export can contain them.
  readonly configDir: string
  readonly preferredPort: number
}

export class ConfigInsideData extends Schema.TaggedError<ConfigInsideData>()("ConfigInsideData", {
  configDir: Schema.String,
  dataDir: Schema.String
}) {}

const isInside = (child: string, parent: string) => {
  const path = relative(resolve(parent), resolve(child))
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()("gmat-prep/server/AppConfig") {
  // For tests. The config folder defaults to a sibling of the data folder.
  static readonly layer = (config: { readonly dataDir: string; readonly configDir?: string; readonly preferredPort: number }) =>
    Layer.succeed(
      AppConfig,
      AppConfig.of({ ...config, configDir: config.configDir ?? `${config.dataDir}-config` })
    )

  // GMAT_PREP_DATA_DIR, GMAT_PREP_CONFIG_DIR and GMAT_PREP_PORT override the defaults.
  static readonly layerFromEnv = Layer.effect(
    AppConfig,
    Effect.gen(function*() {
      const defaults = yield* defaultDirs
      const dataDir = yield* Config.String("GMAT_PREP_DATA_DIR").pipe(Config.withDefault(defaults.dataDir))
      const configDir = yield* Config.String("GMAT_PREP_CONFIG_DIR").pipe(Config.withDefault(defaults.configDir))
      const preferredPort = yield* Config.Port("GMAT_PREP_PORT").pipe(Config.withDefault(4747))
      if (isInside(configDir, dataDir)) {
        return yield* new ConfigInsideData({ configDir, dataDir })
      }
      return AppConfig.of({ dataDir, configDir, preferredPort })
    })
  )
}

// The OS's usual places for application data and for per-user configuration.
const defaultDirs = Effect.gen(function*() {
  const home = yield* Config.String("HOME").pipe(Config.withDefault(homedir()))
  switch (process.platform) {
    case "darwin":
      return {
        dataDir: join(home, "Library", "Application Support", "gmat-prep"),
        configDir: join(home, "Library", "Preferences", "gmat-prep")
      }
    case "win32": {
      const roaming = yield* Config.String("APPDATA").pipe(Config.withDefault(join(home, "AppData", "Roaming")))
      const local = yield* Config.String("LOCALAPPDATA").pipe(Config.withDefault(join(home, "AppData", "Local")))
      return { dataDir: join(roaming, "gmat-prep"), configDir: join(local, "gmat-prep") }
    }
    default: {
      const data = yield* Config.String("XDG_DATA_HOME").pipe(Config.withDefault(join(home, ".local", "share")))
      const config = yield* Config.String("XDG_CONFIG_HOME").pipe(Config.withDefault(join(home, ".config")))
      return { dataDir: join(data, "gmat-prep"), configDir: join(config, "gmat-prep") }
    }
  }
})
