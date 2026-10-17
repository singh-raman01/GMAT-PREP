import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../api/Api.ts"
import {
  AddedBook,
  BookEdition,
  BookId,
  BookTitle,
  BookUploadPath,
  MaxBookBytes,
  type UploadProblem,
  UploadRefused
} from "../../api/Books.ts"
import { CuratorCookie } from "../../api/Curator.ts"
import { BookFiles } from "../books/BookFiles.ts"
import { Books } from "../books/Books.ts"
import { Curator } from "../curator/Curator.ts"
import { Generation } from "../generation/Generation.ts"
import { Bank } from "../review/Bank.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { Golden } from "../review/Golden.ts"
import { ReviewQueue } from "../review/ReviewQueue.ts"
import { SiblingsReport } from "../learning/SiblingsReport.ts"

export const BooksHandlers = HttpApiBuilder.group(
  Api,
  "books",
  Effect.fn(function*(handlers) {
    const books = yield* Books
    return handlers.handleAll({
      list: () => books.list,
      get: ({ params }) => books.get(params.id),
      readAgain: ({ params }) => books.readAgain(params.id),
      start: ({ params, payload }) => books.start(params.id, payload.spendCap),
      confirmMap: ({ params, payload }) => books.confirmMap(params.id, payload.ranges, payload.spendCap)
    })
  })
)

export const GenerationHandlers = HttpApiBuilder.group(
  Api,
  "generation",
  Effect.fn(function*(handlers) {
    const generation = yield* Generation
    return handlers.handleAll({
      batches: () => generation.batches,
      start: ({ payload }) => generation.start(payload)
    })
  })
)

export const BankHandlers = HttpApiBuilder.group(
  Api,
  "bank",
  Effect.fn(function*(handlers) {
    const bank = yield* Bank
    const taxonomy = yield* Taxonomy
    return handlers.handleAll({
      thinSkills: () => bank.thinSkills,
      reserve: () => bank.reserve,
      releaseReserve: ({ payload }) => bank.release(payload.section, payload.count),
      taxonomy: () => Effect.succeed(taxonomy.view)
    })
  })
)

export const GoldenHandlers = HttpApiBuilder.group(
  Api,
  "golden",
  Effect.fn(function*(handlers) {
    const golden = yield* Golden
    return handlers.handleAll({
      get: () => golden.get,
      approve: ({ params, payload }) => golden.approve(params.questionId, payload),
      remove: ({ params }) => golden.remove(params.questionId),
      check: ({ payload }) => golden.check(payload.spendCap)
    })
  })
)

export const ReviewHandlers = HttpApiBuilder.group(
  Api,
  "review",
  Effect.fn(function*(handlers) {
    const queue = yield* ReviewQueue
    return handlers.handleAll({
      list: () => queue.list,
      publish: ({ params }) => queue.publish(params.id),
      withdraw: ({ params }) => queue.withdraw(params.id),
      keepAsVariant: ({ params }) => queue.keepAsVariant(params.id),
      usePassage: ({ params }) => queue.usePassage(params.id),
      merge: ({ params }) => queue.merge(params.id),
      dismiss: ({ params }) => queue.dismiss(params.id),
      overrideKey: ({ params, payload }) => queue.overrideKey(params.id, payload.part ?? 0, payload.key, payload.reason),
      checkAgain: ({ params }) => queue.checkAgain(params.id),
      drafts: () => queue.drafts,
      checkDrafts: () => queue.checkDrafts
    })
  })
)

// The upload and the file are plain routes, outside the typed API, so a Book
// streams to and from disk instead of passing through memory as JSON.

const encodeAdded = Schema.encodeSync(Schema.toCodecJson(AddedBook))
const encodeRefused = Schema.encodeSync(Schema.toCodecJson(UploadRefused))

const refuse = (status: number, problem: UploadProblem, message: string) =>
  HttpServerResponse.jsonUnsafe(encodeRefused(new UploadRefused({ problem, message })), { status })

const UploadDetails = Schema.Struct({
  title: BookTitle,
  edition: BookEdition,
  official: Schema.Literals(["true", "false"])
})
const decodeDetails = Schema.decodeUnknownOption(UploadDetails)

const isUnlocked = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const curator = yield* Curator
  return yield* curator.check(request.cookies[CuratorCookie.key] ?? "").pipe(
    Effect.as(true),
    Effect.catchTag("CuratorNotUnlocked", () => Effect.succeed(false))
  )
})

const MaxMegabytes = Math.round(MaxBookBytes / 1024 / 1024)

const serveUpload = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  if (!(yield* isUnlocked)) return refuse(401, "not-unlocked", "Unlock the Curator tools to add a Book.")
  const query = new URL(request.url, "http://localhost").searchParams
  const details = decodeDetails({
    title: query.get("title") ?? "",
    edition: query.get("edition") ?? "",
    official: query.get("official") ?? "false"
  })
  if (details._tag === "None") {
    return refuse(400, "details", "Give the Book a title of up to 200 characters, and an edition of up to 100.")
  }
  // An empty body has no stream to read.
  if (request.headers["content-length"] === "0") return refuse(400, "empty", "The file is empty.")
  const files = yield* BookFiles
  const books = yield* Books
  const received = yield* Effect.result(files.receive(request.stream, MaxBookBytes))
  if (received._tag === "Failure") {
    const failure = received.failure
    switch (failure._tag) {
      case "FileTooLarge":
        return refuse(413, "too-large", `The file is larger than ${MaxMegabytes} MB.`)
      case "NotAPdf":
        return refuse(415, "not-a-pdf", "The file is not a PDF.")
      case "EmptyFile":
        return refuse(400, "empty", "The file is empty.")
      case "DiskFull":
        return refuse(507, "disk-full", "The disk is full, so the Book could not be stored. Free some space and try again.")
      default:
        // The browser stopped sending the file part way.
        return refuse(400, "incomplete", "The file did not arrive in full. Try adding it again.")
    }
  }
  // A request that stops here leaves no temporary file behind.
  const added = yield* books.add(
    { title: details.value.title, edition: details.value.edition, official: details.value.official === "true" },
    received.success
  ).pipe(Effect.onInterrupt(() => files.discard(received.success)))
  return HttpServerResponse.jsonUnsafe(encodeAdded(added), { status: added.alreadyAdded ? 200 : 201 })
})

// For the browser's own PDF viewer. Its policy forbids framing but not the
// viewer, which an object-src limit would block.
const serveFile = Effect.gen(function*() {
  if (!(yield* isUnlocked)) {
    return HttpServerResponse.text("Unlock the Curator tools to open a Book.", { status: 401 })
  }
  const params = yield* HttpRouter.params
  const books = yield* Books
  const found = yield* Effect.result(books.fileOf(BookId.make(params["id"] ?? "")))
  if (found._tag === "Failure") return HttpServerResponse.text("There is no such Book.", { status: 404 })
  const name = found.success.title.replace(/[^\w .()-]+/g, "").trim() || "book"
  return yield* HttpServerResponse.file(found.success.path, {
    contentType: "application/pdf",
    headers: {
      "content-disposition": `inline; filename="${name}.pdf"`,
      "content-security-policy": "frame-ancestors 'none'",
      // Not kept in the browser's cache, where it would open after locking.
      "cache-control": "no-store"
    }
  }).pipe(Effect.orDie)
})

export const BookFileRoutes = HttpRouter.use(Effect.fn(function*(router) {
  yield* router.add("POST", BookUploadPath, serveUpload)
  yield* router.add("GET", "/api/curator/books/:id/file", serveFile)
}))

export const SiblingsHandlers = HttpApiBuilder.group(
  Api,
  "siblings",
  Effect.fn(function*(handlers) {
    const siblings = yield* SiblingsReport
    return handlers.handleAll({ report: () => siblings.report })
  })
)
