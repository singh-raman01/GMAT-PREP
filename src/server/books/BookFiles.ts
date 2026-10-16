import { Context, Effect, Layer, Schema, Stream } from "effect"
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs"
import { open } from "node:fs/promises"
import { join } from "node:path"
import { AppConfig } from "../AppConfig.ts"

// Book files in the data folder's books folder, each stored once under its
// SHA-256. An upload streams to a temporary file while it is hashed, so a
// large Book never sits in memory, and only a complete PDF is kept.

export class FileTooLarge extends Schema.TaggedError<FileTooLarge>()("FileTooLarge", { maxBytes: Schema.Int }) {}

export class NotAPdf extends Schema.TaggedError<NotAPdf>()("NotAPdf", {}) {}

export class EmptyFile extends Schema.TaggedError<EmptyFile>()("EmptyFile", {}) {}

export class DiskFull extends Schema.TaggedError<DiskFull>()("DiskFull", {}) {}

export interface Received {
  readonly temporary: string
  readonly hash: string
  readonly size: number
}

// A PDF starts with this marker, within its first kilobyte.
const PdfMarker = new TextEncoder().encode("%PDF-")
const MarkerWithin = 1024

const hasPdfMarker = (head: Uint8Array) => {
  outer: for (let start = 0; start + PdfMarker.length <= head.length; start++) {
    for (let i = 0; i < PdfMarker.length; i++) {
      if (head[start + i] !== PdfMarker[i]) continue outer
    }
    return true
  }
  return false
}

const isDiskFull = (error: unknown) => (error as { readonly code?: string }).code === "ENOSPC"

export class BookFiles extends Context.Service<BookFiles, {
  readonly folder: string
  pathOf(hash: string): string
  // Writes the body to a temporary file, hashing it on the way.
  receive<E>(
    body: Stream.Stream<Uint8Array, E>,
    maxBytes: number
  ): Effect.Effect<Received, FileTooLarge | NotAPdf | EmptyFile | DiskFull | E>
  // Moves a received file to its place, unless that file is already stored.
  keep(received: Received): Effect.Effect<void>
  discard(received: Received): Effect.Effect<void>
  // The whole file, in a buffer of its own.
  read(hash: string): Effect.Effect<Uint8Array>
  // Temporary files left by uploads a crash cut short.
  readonly removeLeftovers: Effect.Effect<void>
}>()("gmat-prep/server/BookFiles") {
  static readonly layer = Layer.effect(
    BookFiles,
    Effect.gen(function*() {
      const { dataDir } = yield* AppConfig
      const folder = join(dataDir, "books")
      const pathOf = (hash: string) => join(folder, `${hash}.pdf`)

      // File work, with a full disk as an error the Curator can be told about.
      const io = <A>(action: () => Promise<A>): Effect.Effect<A, DiskFull> =>
        Effect.tryPromise({ try: action, catch: (error) => error }).pipe(
          Effect.catch((error) => (isDiskFull(error) ? Effect.fail(new DiskFull()) : Effect.die(error)))
        )

      const receive = <E>(body: Stream.Stream<Uint8Array, E>, maxBytes: number) =>
        Effect.gen(function*() {
          yield* Effect.sync(() => mkdirSync(folder, { recursive: true }))
          const temporary = join(folder, `incoming-${crypto.randomUUID()}.part`)
          const work = Effect.gen(function*() {
            const file = yield* io(() => open(temporary, "wx", 0o600))
            const hasher = new Bun.CryptoHasher("sha256")
            let size = 0
            let head = new Uint8Array(0)
            yield* Stream.runForEach(body, (chunk) =>
              Effect.gen(function*() {
                size += chunk.length
                if (size > maxBytes) return yield* new FileTooLarge({ maxBytes })
                if (head.length < MarkerWithin) {
                  const joined = new Uint8Array(Math.min(MarkerWithin, head.length + chunk.length))
                  joined.set(head)
                  joined.set(chunk.subarray(0, joined.length - head.length), head.length)
                  head = joined
                  if (head.length === MarkerWithin && !hasPdfMarker(head)) return yield* new NotAPdf()
                }
                hasher.update(chunk)
                yield* io(() => file.write(chunk))
              })).pipe(Effect.ensuring(Effect.promise(() => file.close())))
            if (size === 0) return yield* new EmptyFile()
            if (!hasPdfMarker(head)) return yield* new NotAPdf()
            return { temporary, hash: hasher.digest("hex"), size }
          })
          // Nothing half-written is left behind, whatever stopped the upload.
          return yield* work.pipe(Effect.onError(() => Effect.sync(() => rmSync(temporary, { force: true }))))
        })

      const keep = (received: Received) =>
        Effect.sync(() => {
          const target = pathOf(received.hash)
          if (existsSync(target)) rmSync(received.temporary, { force: true })
          else renameSync(received.temporary, target)
        })

      const discard = (received: Received) => Effect.sync(() => rmSync(received.temporary, { force: true }))

      const read = (hash: string) => Effect.promise(() => Bun.file(pathOf(hash)).bytes())

      const removeLeftovers = Effect.sync(() => {
        if (!existsSync(folder)) return
        for (const name of readdirSync(folder)) {
          if (name.startsWith("incoming-") && name.endsWith(".part")) rmSync(join(folder, name), { force: true })
        }
      })

      return BookFiles.of({ folder, pathOf, receive, keep, discard, read, removeLeftovers })
    })
  )
}
