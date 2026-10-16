import { Context, Effect, Layer } from "effect"
import { existsSync, mkdirSync } from "node:fs"
import { readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AppConfig } from "../AppConfig.ts"

// Figures kept as page images (ADR 0006): PNG files in the data folder's
// figures folder, each stored once under the SHA-256 of its bytes.

const HashPattern = /^[0-9a-f]{64}$/

export class FigureFiles extends Context.Service<FigureFiles, {
  // Stores an image unless it is stored already; gives its hash.
  keep(png: Uint8Array): Effect.Effect<string>
  // The image, or undefined when none is stored under the hash.
  read(hash: string): Effect.Effect<Uint8Array | undefined>
}>()("gmat-prep/server/FigureFiles") {
  static readonly layer = Layer.effect(
    FigureFiles,
    Effect.gen(function*() {
      const { dataDir } = yield* AppConfig
      const folder = join(dataDir, "figures")
      const pathOf = (hash: string) => join(folder, `${hash}.png`)
      return FigureFiles.of({
        keep: (png) =>
          Effect.promise(async () => {
            const hash = new Bun.CryptoHasher("sha256").update(png).digest("hex")
            if (existsSync(pathOf(hash))) return hash
            mkdirSync(folder, { recursive: true, mode: 0o700 })
            const temporary = join(folder, `${hash}.${crypto.randomUUID()}.part`)
            await writeFile(temporary, png, { mode: 0o600 })
            await rename(temporary, pathOf(hash))
            return hash
          }),
        read: (hash) =>
          HashPattern.test(hash) && existsSync(pathOf(hash))
            ? Effect.promise(() => readFile(pathOf(hash))).pipe(Effect.map((bytes) => new Uint8Array(bytes)))
            : Effect.succeed(undefined)
      })
    })
  )
}
