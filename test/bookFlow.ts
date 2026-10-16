import { and, eq } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { AddedBook, type BookDetail, type BookId, BookUploadPath, type MapRangeInput } from "../src/api/Books.ts"
import type { ReviewItemView } from "../src/api/Review.ts"
import { Db } from "../src/server/db/Database.ts"
import { parts, questions, sources } from "../src/server/db/schema.ts"
import { FakeLlm } from "../src/server/llm/LlmTransport.ts"
import { ApiKeyStore } from "../src/server/settings/ApiKeyStore.ts"
import { Settings } from "../src/server/settings/Settings.ts"
import { type FakeEnrichment, fakeBookModel, makeFakeBookModel } from "./fakeBookModel.ts"
import { makeBook } from "./fixtures/book.ts"
import { advanceUntil, openInspectableBrowser } from "./harness.ts"

// Driving a Book through the Curator's API, for tests: upload, cost preview,
// Book Map, extraction, and what the fake model was asked.

export const passphrase = "correct horse battery"

export const configure = Effect.gen(function*() {
  const settings = yield* Settings
  yield* settings.saveLlm({
    baseUrl: "https://api.example.com/v1",
    jsonMode: "json-schema",
    models: [
      { task: "book-map", model: "map-model" },
      { task: "extraction", model: "text-model" },
      { task: "tagging", model: "text-model" },
      { task: "solving", model: "text-model" },
      { task: "approaches", model: "text-model" }
    ],
    prices: [
      { model: "map-model", inputPerMillion: 1, outputPerMillion: 4 },
      { model: "text-model", inputPerMillion: 2, outputPerMillion: 8 }
    ],
    readsImages: []
  })
  yield* (yield* ApiKeyStore).save("sk-test-12345678")
  yield* (yield* FakeLlm).respondWith(fakeBookModel)
})

export const curatorBrowser = Effect.gen(function*() {
  const browser = yield* openInspectableBrowser
  yield* browser.api.curatorAccess.setPassphrase({ payload: { passphrase } })
  const token = Option.getOrThrow(yield* browser.cookie("gp_curator"))
  return { api: browser.api, cookie: `gp_curator=${token}` }
})
export type Curator = Effect.Success<typeof curatorBrowser>

const decodeAdded = Schema.decodeUnknownSync(Schema.fromJsonString(AddedBook))

export const upload = (curator: Curator, bytes: Uint8Array, title: string) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(
      HttpClientRequest.post(`${BookUploadPath}?${new URLSearchParams({ title, edition: "", official: "true" })}`).pipe(
        HttpClientRequest.setHeader("cookie", curator.cookie),
        HttpClientRequest.bodyUint8Array(bytes, "application/pdf")
      )
    )
    return decodeAdded(yield* response.text).book
  })

export const waitFor = (curator: Curator, id: BookId, ready: (detail: BookDetail) => boolean) =>
  advanceUntil(
    curator.api.books.get({ params: { id } }).pipe(Effect.map((detail) => (ready(detail) ? detail : undefined))),
    { step: "200 millis", maxSteps: 3000 }
  )

export const statusIs = (status: string) => (detail: BookDetail) => detail.book.status === status

export const rangesOf = (detail: BookDetail): Array<MapRangeInput> =>
  (detail.proposal?.ranges ?? []).map((range) => ({
    role: range.role,
    firstPage: range.firstPage,
    lastPage: range.lastPage,
    set: range.set,
    group: range.group
  }))

// A Book through its cost preview and Book Map run, up to the proposal.
export const proposedBook = (
  curator: Curator,
  edition = "First edition",
  psPages?: number,
  keys?: Readonly<Record<number, string>>
) =>
  proposedFrom(curator, {
    edition,
    ...(psPages === undefined ? {} : { psPages }),
    ...(keys === undefined ? {} : { keys })
  })

// The same, for a fixture Book with any of its options.
export const proposedFrom = (curator: Curator, options: Parameters<typeof makeBook>[0] & { readonly edition: string }) =>
  Effect.gen(function*() {
    const edition = options.edition
    const fixture = yield* Effect.promise(() => makeBook(options))
    const book = yield* upload(curator, fixture.bytes, `Practice Questions, ${edition}`)
    yield* waitFor(curator, book.id, statusIs("previewed"))
    yield* curator.api.books.start({ params: { id: book.id }, payload: { spendCap: 1 } })
    return yield* waitFor(curator, book.id, statusIs("map-proposed"))
  })

export const confirmAndExtract = (curator: Curator, id: BookId, ranges: ReadonlyArray<MapRangeInput>) =>
  Effect.gen(function*() {
    const confirmed = yield* curator.api.books.confirmMap({ params: { id }, payload: { ranges } })
    const version = confirmed.confirmed!.version
    return yield* waitFor(curator, id, (detail) => detail.book.status === "extracted" && detail.book.mapVersion === version)
  })

export const byNumber = (items: ReadonlyArray<ReviewItemView>, number: number) =>
  items.find((item) => item.question?.sources.some((source) => source.number === number))!

export const codes = (item: ReviewItemView) => item.reasons.map((reason) => reason.code)

// A Book's own item in the Question Bank, by number, as stored.
export const bankItem = (bookId: BookId, number: number) =>
  Effect.gen(function*() {
    const db = yield* Db
    const [row] = yield* db.select({ question: questions, key: parts.key, keyBasis: parts.keyBasis, partId: parts.id })
      .from(sources)
      .innerJoin(questions, eq(questions.id, sources.questionId))
      .innerJoin(parts, and(eq(parts.questionId, questions.id), eq(parts.position, 0)))
      .where(and(eq(sources.bookId, bookId), eq(sources.number, number)))
      .pipe(Effect.orDie)
    return row!
  })

// The requests the fake model was sent for a kind of work.
export const sentFor = (marker: string) =>
  Effect.gen(function*() {
    const requests = yield* (yield* FakeLlm).requests
    return requests.filter((request) => (request.messages[0]?.content ?? "").includes(marker))
  })

export const withModel = (options: FakeEnrichment) =>
  Effect.gen(function*() {
    yield* (yield* FakeLlm).respondWith(makeFakeBookModel(options))
  })
