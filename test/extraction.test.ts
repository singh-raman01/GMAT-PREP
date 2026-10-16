import { describe, expect, test } from "bun:test"
import { and, asc, eq } from "drizzle-orm"
import { Effect, Fiber, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { AddedBook, type BookDetail, type BookId, BookUploadPath, type MapRangeInput } from "../src/api/Books.ts"
import type { ReviewItemView } from "../src/api/Review.ts"
import { Db } from "../src/server/db/Database.ts"
import {
  approaches,
  keyOverrides,
  llmCalls,
  optionNotes,
  pageReadings,
  parts,
  questions,
  reviewItems,
  solverRuns,
  sources
} from "../src/server/db/schema.ts"
import { AllJobKinds } from "../src/server/jobs/kinds/index.ts"
import { FakeLlm } from "../src/server/llm/LlmTransport.ts"
import { ApiKeyStore } from "../src/server/settings/ApiKeyStore.ts"
import { Settings } from "../src/server/settings/Settings.ts"
import { type FakeEnrichment, fakeBookModel, makeFakeBookModel } from "./fakeBookModel.ts"
import { makeBook } from "./fixtures/book.ts"
import { advanceUntil, openInspectableBrowser, runWithWorker, runWithWorkers, TestWorkers } from "./harness.ts"

const passphrase = "correct horse battery"

const configure = Effect.gen(function*() {
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

// A Book's own item in the Question Bank, by number, as stored.
const bankItem = (bookId: BookId, number: number) =>
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
const sentFor = (marker: string) =>
  Effect.gen(function*() {
    const requests = yield* (yield* FakeLlm).requests
    return requests.filter((request) => (request.messages[0]?.content ?? "").includes(marker))
  })

const withModel = (options: FakeEnrichment) =>
  Effect.gen(function*() {
    yield* (yield* FakeLlm).respondWith(makeFakeBookModel(options))
  })

describe("Extracting Problem Solving Questions", () => {
  test("passing Questions are published on their own; the rest wait in the Review Queue with every reason", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        const id = proposed.book.id
        const extracted = yield* confirmAndExtract(curator, id, rangesOf(proposed))
        expect(extracted.book.report).toMatchObject({
          extracted: 8,
          merged: 0,
          held: 3,
          published: 5,
          withdrawn: 0,
          skippedGeometry: 1,
          skippedSentenceCorrection: 0,
          unreadPages: []
        })
        expect(extracted.book.job).toMatchObject({
          kind: "book-extract",
          status: "done",
          result: "5 Questions published, 3 held in the Review Queue; 1 joined the Mock Reserve."
        })

        // The first is published, with its tags, three solves, the Book's
        // explanation as an Approach beside the model's, and a note for
        // each wrong choice.
        const first = yield* bankItem(id, 1)
        expect(first.question).toMatchObject({
          stem: "If \\(3x + 1 = 13\\), what is the value of x?",
          status: "published",
          primarySkill: expect.stringMatching(/^quant\./),
          difficultyEstimate: 0,
          difficultySeed: 0,
          difficultyBasis: "estimate",
          enrichment: "done",
          tagsPromptVersion: "tag-question@1"
        })
        expect(first.key).toBe("C")
        const db = yield* Db
        const solves = yield* db.select().from(solverRuns).where(eq(solverRuns.questionId, first.question.id))
          .pipe(Effect.orDie)
        expect(solves.map((solve) => solve.answer)).toEqual(["C", "C", "C"])
        const routes = yield* db.select().from(approaches).where(eq(approaches.questionId, first.question.id))
          .orderBy(asc(approaches.position)).pipe(Effect.orDie)
        expect(routes.map((route) => [route.author, route.answer])).toEqual([["book", "C"], ["llm", "C"]])
        expect(routes[0]?.steps).toBe("Work it out step by step from what the question gives.")
        const notes = yield* db.select().from(optionNotes).where(eq(optionNotes.partId, first.partId))
          .orderBy(asc(optionNotes.position)).pipe(Effect.orDie)
        expect(notes.map((note) => note.position)).toEqual([0, 1, 3, 4])
        expect(notes.every((note) => note.mistakeType !== "time-pressure")).toBe(true)

        const items = yield* curator.api.review.list()
        expect(items).toHaveLength(3)
        // The sixth's explanation argues for D, so it is not an Approach.
        const sixth = byNumber(items, 6)
        expect(codes(sixth)).toEqual(["key-conflict"])
        expect(sixth.reasons[0]?.detail).toBe("The answer key says C, but the explanation says D.")
        expect(sixth.question).toMatchObject({ key: "C", status: "held", solverAnswers: ["C", "C", "C"] })
        expect(sixth.question?.approaches.map((approach) => approach.author)).toEqual(["llm"])
        expect(sixth.question?.optionNotes.map((note) => note.label)).toEqual(["A", "B", "D", "E"])
        expect(codes(byNumber(items, 8))).toEqual(["near-match"])
        expect(byNumber(items, 8).related?.id as string).toBe(first.question.id)
        // Text whose math does not render is not enriched.
        const ninth = byNumber(items, 9)
        expect(codes(ninth)).toEqual(["render"])
        expect(ninth.reasons[0]?.detail).toContain("\\frac{17}{")
        expect(ninth.question).toMatchObject({ primarySkill: null, solverAnswers: [], approaches: [], optionNotes: [] })
        // Prices stay plain text.
        expect((yield* db.select().from(questions).where(eq(questions.id, (yield* bankItem(id, 2)).question.id))
          .pipe(Effect.orDie))[0]?.stem).toContain("$25")
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
        expect(extracted.book.report).toMatchObject({ extracted: 8, merged: 7, held: 1, published: 0, skippedGeometry: 1 })
        const db = yield* Db
        const firstOne = yield* bankItem(first.book.id, 1)
        const joined = yield* db.select().from(sources).where(eq(sources.questionId, firstOne.question.id))
          .orderBy(asc(sources.createdAt)).pipe(Effect.orDie)
        expect(joined.map((source) => [source.bookId, source.merged])).toEqual([[first.book.id, false], [second.book.id, true]])
        const items = yield* curator.api.review.list()
        const garbled = items.filter((item) => item.reasons.some((reason) => reason.code === "render"))
        expect(garbled).toHaveLength(2)
        expect(codes(garbled[1]!)).toEqual(["render", "near-match"])
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
        // explanation still says C, and so do the solves.
        const second = yield* proposedBook(curator, "Second edition", undefined, { 3: "B" })
        const extracted = yield* confirmAndExtract(curator, second.book.id, rangesOf(second))
        expect(extracted.book.report).toMatchObject({ extracted: 8, merged: 6, held: 2 })
        const items = yield* curator.api.review.list()
        const repeat = items.find((item) => item.question?.sources[0]?.bookTitle === "Practice Questions, Second edition" &&
          item.question.sources[0].number === 3)!
        expect(repeat.question).toMatchObject({ key: "B", sources: [{ number: 3 }] })
        expect(codes(repeat)).toEqual(["key-conflict", "same-text-other-key", "solver-disagreement"])
        expect(repeat.reasons[2]?.detail).toBe("Independent solves answered C, C and C; the key is B.")
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

  test("the Curator publishes past a solver's doubt, keeps a Variant, and withdraws", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        // One solve of the second question goes astray.
        yield* withModel({ solve: (stem, run) => (stem.startsWith("A shirt") && run === 2 ? "D" : "C") })
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, proposed.book.id, rangesOf(proposed))
        const items = yield* curator.api.review.list()
        const review = curator.api.review
        expect(items.map((item) => codes(item))).toEqual([["solver-disagreement"], ["key-conflict"], ["near-match"], ["render"]])

        // The key stands: publishing past a solver's doubt changes nothing else.
        const published = yield* review.publish({ params: { id: byNumber(items, 2).id } })
        expect(published).toMatchObject({ status: "decided", decision: "published", question: { status: "published", key: "C" } })

        const refused = yield* review.publish({ params: { id: byNumber(items, 6).id } }).pipe(Effect.flip)
        expect(refused._tag).toBe("CannotPublish")
        expect(refused._tag === "CannotPublish" && refused.reasons.map((reason) => reason.code)).toEqual(["key-conflict"])

        // A Variant goes through the Publish Gate again, and passes.
        const variant = yield* review.keepAsVariant({ params: { id: byNumber(items, 8).id } })
        expect(variant).toMatchObject({ status: "decided", decision: "published", related: null })

        yield* review.withdraw({ params: { id: byNumber(items, 9).id } })
        const notAPage = yield* review.dismiss({ params: { id: byNumber(items, 6).id } }).pipe(Effect.flip)
        expect(notAPage._tag).toBe("ReviewItemNotOpen")

        expect(yield* review.list()).toHaveLength(1)
        const report = (yield* curator.api.books.get({ params: { id: proposed.book.id } })).book.report
        expect(report).toMatchObject({ extracted: 8, held: 1, published: 6, withdrawn: 1, merged: 0 })
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
        expect(yield* curator.api.review.list()).toHaveLength(2)
        const db = yield* Db
        const first = yield* bankItem(proposed.book.id, 1)
        const joined = yield* db.select().from(sources).where(eq(sources.questionId, first.question.id))
          .orderBy(asc(sources.number)).pipe(Effect.orDie)
        expect(joined.map((source) => source.number)).toEqual([1, 8])
        const report = (yield* curator.api.books.get({ params: { id: proposed.book.id } })).book.report
        expect(report).toMatchObject({ extracted: 8, held: 2, published: 5, merged: 1 })
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

describe("The Publish Gate", () => {
  test("an Approach that misses the key is written once more; one that misses it again holds the Question", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        // The first reply for every question misses the key; for the fourth,
        // the second reply misses it too.
        let fourth = false
        yield* withModel({
          approachAnswer: (key, attempt) => (attempt === 1 || fourth ? "A" : key)
        })
        const fake = yield* FakeLlm
        const respond = makeFakeBookModel({ approachAnswer: (key, attempt) => (attempt === 1 || fourth ? "A" : key) })
        yield* fake.respondWith((request) => {
          fourth = (request.messages[1]?.content ?? "").includes("In how many ways")
          return respond(request)
        })
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, proposed.book.id, rangesOf(proposed))
        // Two for the cost preview's sample; then seven Questions were
        // enriched, each written twice.
        const written = (yield* sentFor("You write teaching material")).slice(2)
        expect(written).toHaveLength(14)
        expect(written[1]?.messages.at(-1)?.content).toContain("Your last reply had these problems")
        const items = yield* curator.api.review.list()
        expect(codes(byNumber(items, 4))).toEqual(["approach-misses-key"])
        expect(byNumber(items, 4).reasons[0]?.detail).toBe(
          "An Approach arrives at A, not the key, C, even after it was written again."
        )
        expect((yield* bankItem(proposed.book.id, 1)).question.status).toBe("published")
      }),
      AllJobKinds
    ))

  test("a tag the Question Type does not allow, or a Book Label two bands from the estimate, holds the Question", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        yield* withModel({
          // A Verbal Skill for the first question, which the reply schema
          // refuses twice, so it is left untagged.
          skill: (stem, offered) => (stem.startsWith("If \\(3x + 1") ? "verbal.cr-reasoning.assumptions" : offered[0]!),
          // The Book labels the third easy; the estimate says hard.
          label: (number) => (number === 3 ? "easy" : null),
          difficulty: (stem) => (stem.startsWith("What is the average") ? 1.4 : 0)
        })
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, proposed.book.id, rangesOf(proposed))
        const items = yield* curator.api.review.list()
        expect(codes(byNumber(items, 1))).toEqual(["tags"])
        expect(byNumber(items, 1).reasons[0]?.detail).toBe("It has no primary Skill.")
        expect(codes(byNumber(items, 3))).toEqual(["difficulty"])
        expect(byNumber(items, 3).reasons[0]?.detail).toBe(
          "The Book labels it easy, but the Difficulty estimate, 1.4, is hard."
        )
        // The Book Label is the starting Difficulty.
        expect((yield* bankItem(proposed.book.id, 3)).question).toMatchObject({
          difficultySeed: -1,
          difficultyBasis: "book-label"
        })
      }),
      AllJobKinds
    ))

  test("a Key Override keeps its reason and sends the Question back through the gate, reusing its tags and solves", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, proposed.book.id, rangesOf(proposed))
        const sixth = byNumber(yield* curator.api.review.list(), 6)
        const tagged = (yield* sentFor("You tag a GMAT question")).length
        const solved = (yield* sentFor("You solve a GMAT question")).length
        const written = (yield* sentFor("You write teaching material")).length

        // The Curator sides with the explanation's D.
        const overridden = yield* curator.api.review.overrideKey({
          params: { id: sixth.id },
          payload: { key: "D", reason: "The explanation is right." }
        })
        expect(overridden.question).toMatchObject({ key: "D", keyBasis: "override", status: "draft" })
        // While it is checked again, it is out of the queue.
        expect((yield* curator.api.review.list()).some((item) => item.id === sixth.id)).toBe(false)

        const back = yield* advanceUntil(
          curator.api.review.list().pipe(Effect.map((items) => items.find((item) => item.id === sixth.id))),
          { step: "200 millis", maxSteps: 3000 }
        )
        // The key conflict is settled by the override; the solves, reused,
        // still say C.
        expect(codes(back)).toEqual(["solver-disagreement"])
        expect(back.question).toMatchObject({ key: "D", solverAnswers: ["C", "C", "C"] })
        expect(back.question?.optionNotes.map((note) => note.label)).toEqual(["A", "B", "C", "E"])
        expect(back.question?.keyOverrides).toMatchObject([{ previousKey: "C", newKey: "D", reason: "The explanation is right." }])
        expect((yield* sentFor("You tag a GMAT question")).length).toBe(tagged)
        expect((yield* sentFor("You solve a GMAT question")).length).toBe(solved)
        expect((yield* sentFor("You write teaching material")).length).toBe(written + 1)
        const db = yield* Db
        expect(yield* db.select().from(keyOverrides).pipe(Effect.orDie)).toHaveLength(1)
      }),
      AllJobKinds
    ))

  test("a Book Map fix that changes a key rewrites the key's content and reuses the rest", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const fake = yield* FakeLlm
        const proposed = yield* proposedBook(curator)
        const full = rangesOf(proposed)
        // The first version leaves out the answer key, so each key comes from
        // its explanation, and the sixth says D, which the solves doubt.
        const withoutKey = full.filter((range) => !(range.role === "answer-key" && range.group === "ps"))
        yield* confirmAndExtract(curator, proposed.book.id, withoutKey)
        let items = yield* curator.api.review.list()
        expect(byNumber(items, 6).question?.key).toBe("D")
        expect(codes(byNumber(items, 6))).toEqual(["solver-disagreement"])
        yield* curator.api.review.publish({ params: { id: byNumber(items, 6).id } })
        const before = (yield* fake.requests).length

        yield* confirmAndExtract(curator, proposed.book.id, full)
        // No page was read again, and only the sixth's Approaches and notes
        // were written again, for its new key.
        const since = (yield* fake.requests).slice(before)
        expect(since).toHaveLength(1)
        expect(since[0]?.messages[0]?.content).toContain("You write teaching material")
        items = yield* curator.api.review.list()
        const sixth = byNumber(items, 6)
        expect(sixth.question).toMatchObject({ key: "C", status: "held", solverAnswers: ["C", "C", "C"] })
        expect(codes(sixth)).toEqual(["key-conflict"])
        expect((yield* bankItem(proposed.book.id, 1)).question.status).toBe("published")
      }),
      AllJobKinds
    ))
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
        const db = yield* Db
        const own = yield* db.select().from(sources).where(eq(sources.bookId, proposed.book.id)).pipe(Effect.orDie)
        expect(own).toHaveLength(8)
        expect(new Set(own.map((source) => source.set))).toEqual(new Set(["Problem Solving practice"]))
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
        expect(codes(eighth)).toEqual(["near-match"])
        expect(eighth.related?.id).toBe(firstId)
        const refused = yield* curator.api.review.publish({ params: { id: eighth.id } }).pipe(Effect.flip)
        expect(refused).toMatchObject({ _tag: "CannotPublish" })
        expect((yield* bankItem(proposed.book.id, 1)).question.status).toBe("published")
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
        expect((yield* bankItem(proposed.book.id, 6)).question.status).toBe("published")

        // The sixth explanation says D, against the key's C.
        yield* confirmAndExtract(curator, proposed.book.id, full)
        const items = yield* curator.api.review.list()
        expect(byNumber(items, 6).question).toMatchObject({ key: "C", status: "held" })
        expect(codes(byNumber(items, 6))).toEqual(["key-conflict"])

        yield* confirmAndExtract(curator, proposed.book.id, withoutRole(full, "explanations"))
        expect((yield* bankItem(proposed.book.id, 6)).question.status).toBe("published")
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
        const third = yield* bankItem(first.book.id, 3)
        expect(third.question.status).toBe("published")

        // The second edition's key says B for the third question; without its
        // answer key, the explanation's C joins it to the first edition's.
        const second = yield* proposedBook(curator, "Second edition", undefined, { 3: "B" })
        yield* confirmAndExtract(curator, second.book.id, withoutRole(rangesOf(second), "answer-key"))
        expect((yield* bankItem(first.book.id, 3)).question.status).toBe("published")

        yield* confirmAndExtract(curator, second.book.id, rangesOf(second))
        const items = yield* curator.api.review.list()
        const held = items.find((item) => item.question?.id === third.question.id)!
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
        const db = yield* Db
        const own = yield* db.select().from(sources).where(eq(sources.bookId, proposed.book.id)).pipe(Effect.orDie)
        expect(own.map((source) => source.number).toSorted()).toEqual([1, 2, 3, 4, 5, 6])
        expect((yield* curator.api.review.list()).some((item) => codes(item).includes("near-match"))).toBe(false)
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
        expect(codes(firstEighth!)).toEqual(["near-match"])
        expect(codes(secondEighth!)).toEqual(["key-conflict", "same-text-other-key", "solver-disagreement"])
        expect(secondEighth!.related?.id).toBe(firstEighth!.question!.id)
        const firstOne = firstEighth!.related!.id

        yield* curator.api.review.merge({ params: { id: firstEighth!.id } })
        items = yield* curator.api.review.list()
        const repointed = items.find((item) => item.id === secondEighth!.id)!
        expect(repointed.related?.id).toBe(firstOne)
        const kept = yield* curator.api.review.keepAsVariant({ params: { id: repointed.id } })
        expect(kept).toMatchObject({ status: "open", related: null })
        expect(codes(kept)).toEqual(["key-conflict", "solver-disagreement"])
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
        const items = yield* curator.api.review.list()
        expect(codes(byNumber(items, 3))).toEqual(["no-key"])

        const second = yield* proposedBook(curator, "Second edition")
        yield* confirmAndExtract(curator, second.book.id, rangesOf(second))
        const third = yield* bankItem(first.book.id, 3)
        expect(third.key).toBe("C")
        expect(third.question).toMatchObject({ status: "published", enrichment: "done" })
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
        const item = byNumber(yield* curator.api.review.list(), 6)
        const db = yield* Db
        yield* db.update(reviewItems).set({ reasons: JSON.stringify([{ code: "from-the-future", detail: "?" }]) })
          .where(eq(reviewItems.id, item.id)).pipe(Effect.orDie)
        const listed = byNumber(yield* curator.api.review.list(), 6)
        expect(codes(listed)).toEqual(["structure"])
        const refused = yield* curator.api.review.publish({ params: { id: item.id } }).pipe(Effect.flip)
        expect(refused).toMatchObject({ _tag: "CannotPublish" })
      }),
      AllJobKinds
    ))
})

describe("The golden set", () => {
  test("the Curator approves the first Book's Questions with tags, and a check reports exactness and tag agreement", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const first = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, first.book.id, rangesOf(first))
        const second = yield* proposedBook(curator, "Second edition")
        yield* confirmAndExtract(curator, second.book.id, rangesOf(second))
        const golden = curator.api.golden

        let view = yield* golden.get()
        expect(view.book?.id).toBe(first.book.id)
        expect(view).toMatchObject({ limit: 100, approved: 0, report: null, job: null })
        expect(view.candidates.map((candidate) => candidate.number)).toEqual([1, 2, 3, 4, 5, 6, 8, 9])
        const [one, two, three] = view.candidates
        const modelSkill = one!.primarySkill!

        const refused = yield* golden.approve({
          params: { questionId: three!.questionId },
          payload: { primarySkill: "verbal.reading.inference", secondarySkills: [] }
        }).pipe(Effect.flip)
        expect(refused).toMatchObject({ _tag: "GoldenTagsInvalid" })
        const db = yield* Db
        const secondOwn = yield* bankItem(second.book.id, 9)
        const notFirst = yield* golden.approve({
          params: { questionId: secondOwn.question.id as never },
          payload: { primarySkill: modelSkill, secondarySkills: [] }
        }).pipe(Effect.flip)
        expect(notFirst).toMatchObject({ _tag: "NotGoldenCandidate" })

        yield* golden.approve({ params: { questionId: one!.questionId }, payload: { primarySkill: modelSkill, secondarySkills: [] } })
        // The Curator labels the second with another Skill than the model's.
        view = yield* golden.approve({
          params: { questionId: two!.questionId },
          payload: { primarySkill: "quant.computation.ordering", secondarySkills: [] }
        })
        expect(view.approved).toBe(2)
        const readingsBefore = (yield* db.select().from(pageReadings).pipe(Effect.orDie)).length

        view = yield* golden.check({ payload: { spendCap: 1 } })
        expect(view.job).toMatchObject({ kind: "golden-check" })
        const failed = yield* advanceUntil(
          golden.get().pipe(Effect.map((current) => (current.report !== null ? current : undefined))),
          { step: "200 millis", maxSteps: 3000 }
        )
        expect(failed.report).toMatchObject({
          items: 2,
          textExact: 2,
          partsExact: 2,
          keysExact: 2,
          tagAgreement: 0.5,
          passed: false
        })
        expect(failed.report?.misses).toMatchObject([{ number: 2, text: true, key: true, tags: false }])
        // The Book's own readings were left alone.
        expect((yield* db.select().from(pageReadings).pipe(Effect.orDie)).length).toBe(readingsBefore)

        yield* golden.approve({ params: { questionId: two!.questionId }, payload: { primarySkill: modelSkill, secondarySkills: [] } })
        const finishedBefore = failed.report!.finishedAt
        yield* advanceUntil(Effect.succeed(undefined), { step: "1 second", maxSteps: 2 }).pipe(Effect.ignore)
        yield* golden.check({ payload: { spendCap: 1 } })
        const passed = yield* advanceUntil(
          golden.get().pipe(
            Effect.map((current) => (current.report !== null && current.report.finishedAt > finishedBefore ? current : undefined))
          ),
          { step: "200 millis", maxSteps: 3000 }
        )
        expect(passed.report).toMatchObject({ items: 2, tagAgreement: 1, passed: true, misses: [] })
        expect(passed.job?.result).toBe("Golden set of 2: text exact on 2, Parts on 2, keys on 2; tags agree on 100%. Passed.")
      }),
      AllJobKinds
    ))
})

describe("The Question Bank", () => {
  test("after a Book is extracted, Skills with fewer than 15 Questions are flagged for merging", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        expect(yield* curator.api.bank.thinSkills()).toEqual([])
        const proposed = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, proposed.book.id, rangesOf(proposed))
        const thin = yield* curator.api.bank.thinSkills()
        // The fake tags every Question with the first Skill it is offered.
        const first = (yield* bankItem(proposed.book.id, 1)).question.primarySkill!
        expect(thin.find((skill) => skill.id === first)?.questions).toBe(5)
        expect(thin.every((skill) => skill.id.startsWith("quant.") && skill.questions < 15)).toBe(true)
        expect(thin.at(-1)?.id).toBe(first)
        expect(thin.length).toBeGreaterThan(10)
      }),
      AllJobKinds
    ))

  test("a Learner practises an extracted Book in order, past its Reserve Question and held items", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        const id = proposed.book.id
        yield* confirmAndExtract(curator, id, rangesOf(proposed))
        const learner = yield* openInspectableBrowser
        yield* learner.api.profiles.create({ payload: { name: "Asha" } })
        const choice = { kind: "book", bookId: id } as const
        const started = yield* learner.api.practice.start({ payload: { choice } })
        expect(started.total).toBe(4)
        expect(started.heldForMocks).toHaveLength(1)
        expect(started.unavailable).toHaveLength(3)
        expect(started.current?.question.source).toMatchObject({ bookTitle: "Practice Questions, First edition", page: 2 })

        const reserve = yield* curator.api.bank.reserve()
        expect(reserve.find((section) => section.id === "quant")).toMatchObject({ questions: 5, held: 1, released: 0 })
        yield* curator.api.bank.releaseReserve({ payload: { section: "quant", count: 1 } })
        const after = yield* learner.api.practice.preview({ payload: { choice } })
        expect(after).toMatchObject({ questions: 5, heldForMocks: 0, unavailable: 3 })
      }),
      AllJobKinds
    ))
})
