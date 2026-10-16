import { describe, expect, test } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Effect, Fiber, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { AddedBook, type BookDetail, type BookId, BookUploadPath, type MapRangeInput } from "../src/api/Books.ts"
import type { ReviewItemView } from "../src/api/Review.ts"
import { Db } from "../src/server/db/Database.ts"
import { llmCalls, pageReadings, reviewItems } from "../src/server/db/schema.ts"
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
const proposedBook = (
  curator: Curator,
  edition = "First edition",
  psPages?: number,
  keys?: Readonly<Record<number, string>>
) =>
  Effect.gen(function*() {
    const fixture = yield* Effect.promise(() =>
      makeBook({ edition, ...(psPages === undefined ? {} : { psPages }), ...(keys === undefined ? {} : { keys }) })
    )
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
        // The question whose math the model garbles is held beside the first
        // edition's copy instead of joining it unseen.
        expect(extracted.book.report).toMatchObject({ extracted: 8, merged: 7, held: 1, skippedGeometry: 1 })
        const items = yield* curator.api.review.list()
        expect(items).toHaveLength(9)
        expect(byNumber(items, 1).question?.sources.map((source) => source.bookTitle)).toEqual([
          "Practice Questions, First edition",
          "Practice Questions, Second edition"
        ])
        const garbled = items.filter((item) => item.reasons.some((reason) => reason.code === "render"))
        expect(garbled).toHaveLength(2)
        expect(garbled[1]?.reasons.map((reason) => reason.code)).toEqual(["render", "near-match"])
        expect(garbled[1]?.related?.id).toBe(garbled[0]!.question!.id)
      }),
      AllJobKinds
    ))

  test("a Question repeated with another key is held beside the first, not merged", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const first = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, first.book.id, rangesOf(first))
        // The second edition's key gives B for the third question, though its
        // explanation still says C.
        const second = yield* proposedBook(curator, "Second edition", undefined, { 3: "B" })
        const extracted = yield* confirmAndExtract(curator, second.book.id, rangesOf(second))
        expect(extracted.book.report).toMatchObject({ extracted: 8, merged: 6, held: 2 })
        const items = yield* curator.api.review.list()
        const repeat = items.find((item) => item.question?.sources[0]?.bookTitle === "Practice Questions, Second edition")!
        expect(repeat.question).toMatchObject({ key: "B", sources: [{ number: 3 }] })
        expect(codes(repeat)).toEqual(["key-conflict", "same-text-other-key"])
        expect(repeat.related?.key).toBe("C")
      }),
      AllJobKinds
    ))

  test("Sentence Correction ranges are counted and skipped, not read as Questions", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const fake = yield* FakeLlm
        const proposed = yield* proposedBook(curator)
        // The Curator marks the page of two Data Sufficiency questions as
        // Sentence Correction, to see it skipped.
        const ranges = [
          ...rangesOf(proposed).filter((range) => range.group !== "ds"),
          { role: "questions", firstPage: 9, lastPage: 9, set: "Sentence Correction", group: "sc" } as const
        ]
        const extracted = yield* confirmAndExtract(curator, proposed.book.id, ranges)
        expect(extracted.book.report).toMatchObject({ extracted: 8, skippedSentenceCorrection: 2, skippedGeometry: 1 })
        const listed = (yield* fake.requests).filter((request) => request.messages[0]?.content.includes("list the question numbers"))
        expect(listed).toHaveLength(1)
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
        // Nothing was read again: the cost preview's sample had already read
        // the answer key page, and every other page was read for the first
        // version.
        expect((yield* fake.requests).slice(before)).toHaveLength(0)
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
        // 25 pages, so pages are left to read after the cost preview's sample.
        const proposed = yield* proposedBook(curator, "First edition", 10)

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
        // Pages 2 to 22, each once: ten of questions, one key and ten of
        // explanations, nine of them read with the sample.
        expect(ok).toHaveLength(21)
        expect(yield* db.select().from(pageReadings).pipe(Effect.orDie)).toHaveLength(21)
      }),
      AllJobKinds
    ), 20_000)
})

describe("Fixing a Book Map", () => {
  const withoutRole = (ranges: ReadonlyArray<MapRangeInput>, role: MapRangeInput["role"]) =>
    ranges.filter((range) => !(range.role === role && range.group === "ps"))

  test("renaming a set keeps its items, so no Source is counted twice", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        const full = rangesOf(proposed)
        yield* confirmAndExtract(curator, proposed.book.id, full)
        const renamed = full.map((range) => (range.group === "ps" ? { ...range, set: "Problem Solving practice" } : range))
        const extracted = yield* confirmAndExtract(curator, proposed.book.id, renamed)
        expect(extracted.book.report).toMatchObject({ extracted: 8, merged: 0, skippedGeometry: 1 })
        const items = yield* curator.api.review.list()
        expect(items.every((item) => item.question === null || item.question.sources.length === 1)).toBe(true)
        expect(byNumber(items, 1).question?.sources[0]?.set).toBe("Problem Solving practice")
      }),
      AllJobKinds
    ))

  test("a fix that brings a key keeps a repeat's reasons and the Question beside it", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        const full = rangesOf(proposed)
        yield* confirmAndExtract(curator, proposed.book.id, full.filter((range) => range.role === "questions"))
        let items = yield* curator.api.review.list()
        const firstId = byNumber(items, 1).question!.id
        expect(codes(byNumber(items, 8))).toEqual(["no-key", "near-match"])

        yield* confirmAndExtract(curator, proposed.book.id, withoutRole(full, "explanations"))
        items = yield* curator.api.review.list()
        const eighth = byNumber(items, 8)
        expect(codes(eighth)).toEqual(["near-match", "key-changed"])
        expect(eighth.related?.id).toBe(firstId)
        const refused = yield* curator.api.review.publish({ params: { id: eighth.id } }).pipe(Effect.flip)
        expect(refused).toMatchObject({ _tag: "CannotPublish" })
      }),
      AllJobKinds
    ))

  test("an explanation that comes or goes is checked again, even when the key stays", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        const full = rangesOf(proposed)
        yield* confirmAndExtract(curator, proposed.book.id, withoutRole(full, "explanations"))
        let items = yield* curator.api.review.list()
        expect(codes(byNumber(items, 6))).toEqual([])
        yield* curator.api.review.publish({ params: { id: byNumber(items, 6).id } })

        // The sixth explanation says D, against the key's C.
        yield* confirmAndExtract(curator, proposed.book.id, full)
        items = yield* curator.api.review.list()
        expect(byNumber(items, 6).question).toMatchObject({ key: "C", status: "held" })
        expect(codes(byNumber(items, 6))).toEqual(["key-conflict"])

        yield* confirmAndExtract(curator, proposed.book.id, withoutRole(full, "explanations"))
        items = yield* curator.api.review.list()
        expect(codes(byNumber(items, 6))).toEqual([])
      }),
      AllJobKinds
    ))

  test("another Book's Source whose key changes holds the Question it joined", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const first = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, first.book.id, rangesOf(first))
        let items = yield* curator.api.review.list()
        const third = byNumber(items, 3)
        yield* curator.api.review.publish({ params: { id: third.id } })

        // The second edition's key says B for the third question; without its
        // answer key, the explanation's C joins it to the first edition's.
        const second = yield* proposedBook(curator, "Second edition", undefined, { 3: "B" })
        yield* confirmAndExtract(curator, second.book.id, withoutRole(rangesOf(second), "answer-key"))
        expect((yield* curator.api.review.list()).some((item) => item.question?.id === third.question!.id)).toBe(false)

        yield* confirmAndExtract(curator, second.book.id, rangesOf(second))
        items = yield* curator.api.review.list()
        const held = items.find((item) => item.question?.id === third.question!.id)!
        expect(held.question).toMatchObject({ key: "C", status: "held" })
        expect(codes(held)).toEqual(["source-key"])
        expect(held.reasons[0]?.detail).toBe(
          "Practice Questions, Second edition, 4.0 Problem Solving, question 3 gives the key B; this Question's key is C."
        )
      }),
      AllJobKinds
    ))

  test("items that leave the Book Map leave the Question Bank and the report", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        const full = rangesOf(proposed)
        yield* confirmAndExtract(curator, proposed.book.id, full)
        // Page 4 holds questions 7 to 9; the seventh is a Retired geometry item.
        const shorter = full.map((range) =>
          range.role === "questions" && range.group === "ps" ? { ...range, lastPage: 3 } : range
        )
        const extracted = yield* confirmAndExtract(curator, proposed.book.id, shorter)
        expect(extracted.book.report).toMatchObject({ extracted: 6, skippedGeometry: 0 })
        expect(extracted.book.job?.result).toBe("Linked 1 question set; 2 items have left the Book Map.")
        const numbers = (yield* curator.api.review.list()).flatMap((item) => item.question?.sources.map((s) => s.number) ?? [])
        expect(numbers.toSorted()).toEqual([1, 2, 3, 4, 5, 6])
      }),
      AllJobKinds
    ))

  test("merging a Question points the items that named it at the one it joined", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const first = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, first.book.id, rangesOf(first))
        // The second edition's eighth question has the same text with key B.
        const second = yield* proposedBook(curator, "Second edition", undefined, { 8: "B" })
        yield* confirmAndExtract(curator, second.book.id, rangesOf(second))
        let items = yield* curator.api.review.list()
        const eighths = items.filter((item) => item.question?.sources.some((source) => source.number === 8))
        const [firstEighth, secondEighth] = eighths
        expect(codes(firstEighth!)).toContain("near-match")
        // Its explanation still says C, so its own key is in conflict too.
        expect(codes(secondEighth!)).toEqual(["key-conflict", "same-text-other-key"])
        expect(secondEighth!.related?.id).toBe(firstEighth!.question!.id)
        const firstOne = firstEighth!.related!.id

        yield* curator.api.review.merge({ params: { id: firstEighth!.id } })
        items = yield* curator.api.review.list()
        const repointed = items.find((item) => item.id === secondEighth!.id)!
        expect(repointed.related?.id).toBe(firstOne)
        const kept = yield* curator.api.review.keepAsVariant({ params: { id: repointed.id } })
        expect(kept.related).toBeNull()
      }),
      AllJobKinds
    ))

  test("a Question with no key takes the key of the same Question from another Book", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const first = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, first.book.id, rangesOf(first).filter((range) => range.role === "questions"))
        let items = yield* curator.api.review.list()
        expect(codes(byNumber(items, 3))).toEqual(["no-key"])

        const second = yield* proposedBook(curator, "Second edition")
        yield* confirmAndExtract(curator, second.book.id, rangesOf(second))
        items = yield* curator.api.review.list()
        const third = items.find((item) => item.question?.sources.length === 2 && item.question.sources[0]?.number === 3)!
        expect(third.question?.key).toBe("C")
        expect(codes(third)).toEqual(["key-changed"])
      }),
      AllJobKinds
    ))

  test("a reason this version does not know still blocks publishing", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, proposed.book.id, rangesOf(proposed))
        const item = byNumber(yield* curator.api.review.list(), 1)
        const db = yield* Db
        yield* db.update(reviewItems).set({ reasons: JSON.stringify([{ code: "from-the-future", detail: "?" }]) })
          .where(eq(reviewItems.id, item.id)).pipe(Effect.orDie)
        const listed = byNumber(yield* curator.api.review.list(), 1)
        expect(codes(listed)).toEqual(["structure"])
        const refused = yield* curator.api.review.publish({ params: { id: item.id } }).pipe(Effect.flip)
        expect(refused).toMatchObject({ _tag: "CannotPublish" })
      }),
      AllJobKinds
    ))
})
