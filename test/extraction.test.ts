import { describe, expect, test } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Effect, Fiber, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { AddedBook, type BookDetail, type BookId, BookUploadPath, type MapRangeInput } from "../src/api/Books.ts"
import type { ReviewItemView } from "../src/api/Review.ts"
import { Db } from "../src/server/db/Database.ts"
import { llmCalls } from "../src/server/db/schema.ts"
import { AllJobKinds } from "../src/server/jobs/kinds/index.ts"
import { FakeLlm } from "../src/server/llm/LlmTransport.ts"
import { ApiKeyStore } from "../src/server/settings/ApiKeyStore.ts"
import { Settings } from "../src/server/settings/Settings.ts"
import { fakeBookModel } from "./fakeBookModel.ts"
import { makeBook } from "./fixtures/book.ts"
import { advanceUntil, openInspectableBrowser, runWithWorker, runWithWorkers, TestWorkers } from "./harness.ts"

const passphrase = "correct horse battery"

const configure = Effect.gen(function*() {
  const settings = yield* Settings
  yield* settings.saveLlm({
    baseUrl: "https://api.example.com/v1",
    jsonMode: "json-schema",
    models: [{ task: "book-map", model: "map-model" }, { task: "extraction", model: "text-model" }],
    prices: [
      { model: "map-model", inputPerMillion: 1, outputPerMillion: 4 },
      { model: "text-model", inputPerMillion: 2, outputPerMillion: 8 }
    ],
    readsImages: []
  })
  yield* (yield* ApiKeyStore).save("sk-test-12345678")
  yield* (yield* FakeLlm).respondWith(fakeBookModel)
})

const curatorBrowser = Effect.gen(function*() {
  const browser = yield* openInspectableBrowser
  yield* browser.api.curatorAccess.setPassphrase({ payload: { passphrase } })
  const token = Option.getOrThrow(yield* browser.cookie("gp_curator"))
  return { api: browser.api, cookie: `gp_curator=${token}` }
})
type Curator = Effect.Success<typeof curatorBrowser>

const decodeAdded = Schema.decodeUnknownSync(Schema.fromJsonString(AddedBook))

const upload = (curator: Curator, bytes: Uint8Array, title: string) =>
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

const waitFor = (curator: Curator, id: BookId, ready: (detail: BookDetail) => boolean) =>
  advanceUntil(
    curator.api.books.get({ params: { id } }).pipe(Effect.map((detail) => (ready(detail) ? detail : undefined))),
    { step: "200 millis", maxSteps: 3000 }
  )

const statusIs = (status: string) => (detail: BookDetail) => detail.book.status === status

const rangesOf = (detail: BookDetail): Array<MapRangeInput> =>
  (detail.proposal?.ranges ?? []).map((range) => ({
    role: range.role,
    firstPage: range.firstPage,
    lastPage: range.lastPage,
    set: range.set,
    group: range.group
  }))

// A Book through its cost preview and Book Map run, up to the proposal.
const proposedBook = (curator: Curator, edition = "First edition") =>
  Effect.gen(function*() {
    const fixture = yield* Effect.promise(() => makeBook({ edition }))
    const book = yield* upload(curator, fixture.bytes, `Practice Questions, ${edition}`)
    yield* waitFor(curator, book.id, statusIs("previewed"))
    yield* curator.api.books.start({ params: { id: book.id }, payload: { spendCap: 1 } })
    return yield* waitFor(curator, book.id, statusIs("map-proposed"))
  })

const confirmAndExtract = (curator: Curator, id: BookId, ranges: ReadonlyArray<MapRangeInput>) =>
  Effect.gen(function*() {
    const confirmed = yield* curator.api.books.confirmMap({ params: { id }, payload: { ranges } })
    const version = confirmed.confirmed!.version
    return yield* waitFor(curator, id, (detail) => detail.book.status === "extracted" && detail.book.mapVersion === version)
  })

const byNumber = (items: ReadonlyArray<ReviewItemView>, number: number) =>
  items.find((item) => item.question?.sources.some((source) => source.number === number))!

const codes = (item: ReviewItemView) => item.reasons.map((reason) => reason.code)

describe("Extracting Problem Solving Questions", () => {
  test("every Question goes to the Review Queue linked to its key and explanation, with every reason found", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        const extracted = yield* confirmAndExtract(curator, proposed.book.id, rangesOf(proposed))
        expect(extracted.book.report).toMatchObject({
          extracted: 8,
          merged: 0,
          held: 8,
          published: 0,
          withdrawn: 0,
          skippedGeometry: 1,
          skippedSentenceCorrection: 0,
          unreadPages: []
        })
        expect(extracted.book.job).toMatchObject({ kind: "book-extract", status: "done" })

        const items = yield* curator.api.review.list()
        expect(items).toHaveLength(8)
        const first = byNumber(items, 1)
        expect(first.question).toMatchObject({
          section: "quant",
          questionType: "quant.ps",
          stem: "If \\(3x + 1 = 13\\), what is the value of x?",
          key: "C",
          keyBasis: "book",
          status: "held",
          explanation: "Work it out step by step from what the question gives."
        })
        expect(first.question?.options.map((option) => option.label)).toEqual(["A", "B", "C", "D", "E"])
        expect(first.question?.sources).toMatchObject([{ set: "4.0 Problem Solving", number: 1, page: 2 }])
        expect(first.reasons).toEqual([])
        // Prices stay plain text.
        expect(byNumber(items, 2).question?.options[2]).toEqual({ label: "C", text: "$31.25" })
        expect(codes(byNumber(items, 6))).toEqual(["key-conflict"])
        expect(byNumber(items, 6).reasons[0]?.detail).toBe("The answer key says C, but the explanation says D.")
        expect(codes(byNumber(items, 8))).toEqual(["near-match"])
        expect(byNumber(items, 8).related?.id).toBe(first.question!.id)
        expect(codes(byNumber(items, 9))).toEqual(["render"])
        expect(byNumber(items, 9).reasons[0]?.detail).toContain("\\frac{17}{")
        // The geometry question is skipped, not held.
        expect(items.some((item) => item.question?.sources.some((source) => source.number === 7))).toBe(false)
      }),
      AllJobKinds
    ))

  test("a second edition repeating the Questions joins them as Sources", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const first = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, first.book.id, rangesOf(first))
        const second = yield* proposedBook(curator, "Second edition")
        const extracted = yield* confirmAndExtract(curator, second.book.id, rangesOf(second))
        expect(extracted.book.report).toMatchObject({ extracted: 8, merged: 8, held: 0, skippedGeometry: 1 })
        const items = yield* curator.api.review.list()
        expect(items).toHaveLength(8)
        expect(byNumber(items, 1).question?.sources.map((source) => source.bookTitle)).toEqual([
          "Practice Questions, First edition",
          "Practice Questions, Second edition"
        ])
      }),
      AllJobKinds
    ))

  test("the Curator publishes, keeps a Variant, merges a repeat and withdraws", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, proposed.book.id, rangesOf(proposed))
        const items = yield* curator.api.review.list()
        const review = curator.api.review

        const published = yield* review.publish({ params: { id: byNumber(items, 1).id } })
        expect(published).toMatchObject({ status: "decided", decision: "published", question: { status: "published" } })

        const refused = yield* review.publish({ params: { id: byNumber(items, 6).id } }).pipe(Effect.flip)
        expect(refused._tag).toBe("CannotPublish")
        expect(refused._tag === "CannotPublish" && refused.reasons.map((reason) => reason.code)).toEqual(["key-conflict"])

        // The near match is a Variant: still waiting, now publishable.
        const variant = yield* review.keepAsVariant({ params: { id: byNumber(items, 8).id } })
        expect(variant).toMatchObject({ status: "open", reasons: [], related: null })
        yield* review.publish({ params: { id: variant.id } })

        yield* review.withdraw({ params: { id: byNumber(items, 9).id } })
        const notAPage = yield* review.dismiss({ params: { id: byNumber(items, 2).id } }).pipe(Effect.flip)
        expect(notAPage._tag).toBe("ReviewItemNotOpen")

        expect(yield* review.list()).toHaveLength(5)
        const report = (yield* curator.api.books.get({ params: { id: proposed.book.id } })).book.report
        expect(report).toMatchObject({ extracted: 8, held: 5, published: 2, withdrawn: 1, merged: 0 })
      }),
      AllJobKinds
    ))

  test("a near match the Curator merges joins the other Question as a Source", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, proposed.book.id, rangesOf(proposed))
        const items = yield* curator.api.review.list()
        const merged = yield* curator.api.review.merge({ params: { id: byNumber(items, 8).id } })
        expect(merged).toMatchObject({ status: "decided", decision: "merged", question: null })
        const after = yield* curator.api.review.list()
        expect(after).toHaveLength(7)
        expect(byNumber(after, 1).question?.sources.map((source) => source.number)).toEqual([1, 8])
        const report = (yield* curator.api.books.get({ params: { id: proposed.book.id } })).book.report
        expect(report).toMatchObject({ extracted: 8, held: 7, merged: 1 })
      }),
      AllJobKinds
    ))

  test("a page without a text layer in a mapped range waits in the Review Queue", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        // The Curator maps the scanned page 10 as Problem Solving questions.
        const ranges = [
          ...rangesOf(proposed),
          { role: "questions", firstPage: 10, lastPage: 10, set: "Scanned practice", group: "ps" } as const
        ]
        const extracted = yield* confirmAndExtract(curator, proposed.book.id, ranges)
        expect(extracted.book.report?.unreadPages).toEqual([10])
        const page = (yield* curator.api.review.list()).find((item) => item.page !== null)!
        expect(page).toMatchObject({ question: null, page: { number: 10 }, reasons: [{ code: "unread-page" }] })
        expect(page.reasons[0]?.detail).toContain("cannot read images")
        const dismissed = yield* curator.api.review.dismiss({ params: { id: page.id } })
        expect(dismissed).toMatchObject({ status: "decided", decision: "dismissed" })
      }),
      AllJobKinds
    ))

  test("fixing the Book Map reads only the changed pages and relinks only the affected Questions", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const fake = yield* FakeLlm
        const proposed = yield* proposedBook(curator)
        const full = rangesOf(proposed)
        // The first version leaves out the answer key, so each key comes
        // from its explanation, and the sixth says D.
        const withoutKey = full.filter((range) => !(range.role === "answer-key" && range.group === "ps"))
        yield* confirmAndExtract(curator, proposed.book.id, withoutKey)
        let items = yield* curator.api.review.list()
        expect(byNumber(items, 6).question?.key).toBe("D")
        expect(codes(byNumber(items, 6))).toEqual([])
        yield* curator.api.review.publish({ params: { id: byNumber(items, 6).id } })
        yield* curator.api.review.publish({ params: { id: byNumber(items, 1).id } })
        const before = (yield* fake.requests).length

        yield* confirmAndExtract(curator, proposed.book.id, full)
        // Only the answer key page was read.
        const reads = (yield* fake.requests).slice(before)
        expect(reads).toHaveLength(1)
        expect(reads[0]?.messages[0]?.content).toContain("answer keys")
        items = yield* curator.api.review.list()
        const sixth = byNumber(items, 6)
        expect(sixth.question).toMatchObject({ key: "C", status: "held" })
        expect(codes(sixth)).toEqual(["key-conflict", "key-changed"])
        expect(sixth.reasons[1]?.detail).toBe("A Book Map fix changed its key from D to C.")
        // The others were not touched: the first stays published, and no
        // other item came back.
        expect(items.map((item) => item.question?.sources[0]?.number).toSorted()).toEqual([2, 3, 4, 5, 6, 8, 9])
      }),
      AllJobKinds
    ))

  test("a worker killed part way resumes without reading any page twice", () =>
    runWithWorkers(
      Effect.gen(function*() {
        yield* configure
        const fake = yield* FakeLlm
        const curator = yield* curatorBrowser
        const workers = yield* TestWorkers
        const first = yield* workers.start
        const proposed = yield* proposedBook(curator)

        // The API goes down after three extraction pages, and the worker is
        // killed while it waits to try again.
        let readings = 0
        let down = false
        yield* fake.respondWith((request) => {
          if ((request.messages[0]?.content ?? "").includes("You transcribe") || request.messages[0]?.content.includes("answer keys")) {
            if (down) return { status: 503, message: "overloaded" }
            readings += 1
            if (readings === 3) down = true
          }
          return fakeBookModel(request)
        })
        yield* curator.api.books.confirmMap({ params: { id: proposed.book.id }, payload: { ranges: rangesOf(proposed) } })
        yield* advanceUntil(Effect.sync(() => (down ? true : undefined)), { step: "200 millis", maxSteps: 3000 })
        yield* Fiber.interrupt(first)

        down = false
        yield* fake.respondWith(fakeBookModel)
        yield* workers.start
        yield* advanceUntil(
          curator.api.books.get({ params: { id: proposed.book.id } }).pipe(
            Effect.map((detail) => (detail.book.status === "extracted" ? detail : undefined))
          ),
          { step: "5 seconds", maxSteps: 600 }
        )
        const db = yield* Db
        const ok = yield* db.select().from(llmCalls)
          .where(and(eq(llmCalls.task, "extraction"), eq(llmCalls.outcome, "ok")))
          .pipe(Effect.orDie)
        // Pages 2 to 8: three of questions, one key, three of explanations.
        expect(ok).toHaveLength(7)
        expect((yield* curator.api.review.list())).toHaveLength(8)
      }),
      AllJobKinds
    ))
})
