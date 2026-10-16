import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AppConfig } from "../src/server/AppConfig.ts"
import { BookFiles } from "../src/server/books/BookFiles.ts"
import { tempDataDir } from "./harness.ts"

const withFiles = <A, E>(test: (folder: string) => Effect.Effect<A, E, BookFiles>) => {
  const dataDir = tempDataDir()
  return Effect.runPromise(
    test(join(dataDir, "books")).pipe(
      Effect.provide(BookFiles.layer.pipe(Layer.provide(AppConfig.layer({ dataDir, preferredPort: 0 }))))
    )
  )
}

const pdfStart = new TextEncoder().encode("%PDF-1.7\n")
const leftovers = (folder: string) => readdirSync(folder).filter((name) => name.endsWith(".part"))

describe("Receiving a Book file", () => {
  test("a file over the limit, or one cut off part way, leaves nothing behind", () =>
    withFiles((folder) =>
      Effect.gen(function*() {
        const files = yield* BookFiles
        const tooLarge = yield* files.receive(Stream.make(pdfStart, new Uint8Array(200)), 100).pipe(Effect.flip)
        expect(tooLarge._tag).toBe("FileTooLarge")
        const cut = yield* files.receive(
          Stream.make(pdfStart).pipe(Stream.concat(Stream.fail("the browser stopped sending"))),
          10_000
        ).pipe(Effect.flip)
        expect(cut).toBe("the browser stopped sending")
        expect(leftovers(folder)).toEqual([])
      })
    ))

  test("a complete file is kept under its hash, once", () =>
    withFiles((folder) =>
      Effect.gen(function*() {
        const files = yield* BookFiles
        const bytes = new Uint8Array([...pdfStart, ...new Uint8Array(5000).fill(65)])
        const received = yield* files.receive(Stream.make(bytes.subarray(0, 3000), bytes.subarray(3000)), 10_000)
        expect(received.size).toBe(bytes.length)
        expect(received.hash).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"))
        yield* files.keep(received)
        expect(existsSync(files.pathOf(received.hash))).toBe(true)
        expect(leftovers(folder)).toEqual([])
      })
    ))

  test("temporary files a crash left are removed at start, and stored Books are not", () =>
    withFiles((folder) =>
      Effect.gen(function*() {
        const files = yield* BookFiles
        mkdirSync(folder, { recursive: true })
        writeFileSync(join(folder, "incoming-1234.part"), "half a file")
        writeFileSync(join(folder, "abc.pdf"), "%PDF-")
        yield* files.removeLeftovers
        expect(readdirSync(folder)).toEqual(["abc.pdf"])
      })
    ))
})
