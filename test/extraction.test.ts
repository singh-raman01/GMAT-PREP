import { describe, expect, test } from "bun:test"
import { and, asc, eq } from "drizzle-orm"
import { Effect, Fiber } from "effect"
import type { MapRangeInput } from "../src/api/Books.ts"
import { Db } from "../src/server/db/Database.ts"
import {
  approaches,
  jobs,
  keyOverrides,
  llmCalls,
  optionNotes,
  pageReadings,
  parts,
  questions,
  reviewItems,
  solverRuns,
  sources,
  stimuli
} from "../src/server/db/schema.ts"
import { AllJobKinds } from "../src/server/jobs/kinds/index.ts"
import { FakeLlm } from "../src/server/llm/LlmTransport.ts"
import { fakeBookModel, makeFakeBookModel } from "./fakeBookModel.ts"
import { PassageLines } from "./fixtures/book.ts"
import {
  bankItem,
  byNumber,
  codes,
  configure,
  confirmAndExtract,
  curatorBrowser,
  proposedBook,
  proposedFrom,
  rangesOf,
  sentFor,
  waitFor,
  withModel
} from "./bookFlow.ts"
import { advanceUntil, openInspectableBrowser, runWithWorker, runWithWorkers, tempDataDir, TestWorkers } from "./harness.ts"

describe("Extracting Problem Solving Questions", () => {
  test("passing Questions are published on their own; the rest wait in the Review Queue with every reason", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        const id = proposed.book.id
        const extracted = yield* confirmAndExtract(curator, id, rangesOf(proposed))
        // The 8 Problem Solving Questions and the 2 Data Sufficiency ones.
        expect(extracted.book.report).toMatchObject({
          extracted: 10,
          merged: 0,
          held: 3,
          published: 7,
          withdrawn: 0,
          skippedGeometry: 1,
          skippedSentenceCorrection: 0,
          unreadPages: []
        })
        expect(extracted.book.job).toMatchObject({
          kind: "book-extract",
          status: "done",
          // A quarter of each Section: one of the Problem Solving Questions,
          // and one of the 2 Data Sufficiency ones, rounded up.
          result: "7 Questions published, 3 held in the Review Queue; 2 joined the Mock Reserve."
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
          tagsPromptVersion: "tag-question@2"
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
        expect(extracted.book.report).toMatchObject({ extracted: 10, merged: 9, held: 1, published: 0, skippedGeometry: 1 })
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
        expect(extracted.book.report).toMatchObject({ extracted: 10, merged: 8, held: 2 })
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
        yield* withModel({ solve: (stem, run) => (stem.startsWith("A shirt") && run === 2 ? "D" : undefined) })
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
        expect(report).toMatchObject({ extracted: 10, held: 1, published: 8, withdrawn: 1, merged: 0 })
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
        expect(merged).toMatchObject({ status: "decided", decision: "merged" })
        expect(yield* curator.api.review.list()).toHaveLength(2)
        const db = yield* Db
        const first = yield* bankItem(proposed.book.id, 1)
        // The merged Question stays, withdrawn, with a record of the merge.
        const [twin] = yield* db.select().from(questions).where(eq(questions.id, merged.question!.id)).pipe(Effect.orDie)
        expect(twin).toMatchObject({ status: "withdrawn", mergedInto: first.question.id })
        const joined = yield* db.select().from(sources).where(eq(sources.questionId, first.question.id))
          .orderBy(asc(sources.number)).pipe(Effect.orDie)
        expect(joined.map((source) => source.number)).toEqual([1, 8])
        const report = (yield* curator.api.books.get({ params: { id: proposed.book.id } })).book.report
        expect(report).toMatchObject({ extracted: 10, held: 2, published: 7, merged: 1 })
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
        // Pages 2 to 23 and 25, each once: eleven of questions, two keys and
        // ten of explanations, ten of them read with the sample.
        expect(ok).toHaveLength(23)
        expect(yield* db.select().from(pageReadings).pipe(Effect.orDie)).toHaveLength(23)
      }),
      AllJobKinds
    ), 20_000)
})

describe("Enriching after a stop", () => {
  test("a worker killed while enriching resumes without tagging or solving any Question twice", () =>
    runWithWorkers(
      Effect.gen(function*() {
        yield* configure
        const fake = yield* FakeLlm
        const curator = yield* curatorBrowser
        const workers = yield* TestWorkers
        const first = yield* workers.start
        const proposed = yield* proposedBook(curator)
        // The API goes down at the full run's first Approaches call, after
        // that Question's tags and solves are stored, and the worker is
        // killed while it waits to try again.
        let written = 0
        let down = false
        yield* fake.respondWith((request) => {
          if ((request.messages[0]?.content ?? "").includes("You write teaching material")) {
            written += 1
            // The cost preview's sample wrote two.
            if (written === 3) down = true
            if (down) return { status: 503, message: "overloaded" }
          }
          return fakeBookModel(request)
        })
        yield* curator.api.books.confirmMap({ params: { id: proposed.book.id }, payload: { ranges: rangesOf(proposed) } })
        yield* advanceUntil(Effect.sync(() => (down ? true : undefined)), { step: "200 millis", maxSteps: 3000 })
        yield* Fiber.interrupt(first)

        down = false
        yield* fake.respondWith(fakeBookModel)
        yield* workers.start
        yield* waitFor(curator, proposed.book.id, (detail) => detail.book.status === "extracted")
        const db = yield* Db
        const extraction = yield* db.select({ id: jobs.id }).from(jobs).where(eq(jobs.kind, "book-extract")).pipe(Effect.orDie)
        const okCalls = (task: string) =>
          db.select().from(llmCalls)
            .where(and(eq(llmCalls.task, task), eq(llmCalls.outcome, "ok"), eq(llmCalls.jobId, extraction[0]!.id)))
            .pipe(Effect.orDie)
        // Nine Questions are enriched: each tagged once and solved three times.
        expect(yield* okCalls("tagging")).toHaveLength(9)
        expect(yield* okCalls("solving")).toHaveLength(27)
        expect(yield* okCalls("approaches")).toHaveLength(9)
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
        // Two for the cost preview's sample; then nine Questions were
        // enriched, each written twice but for the Data Sufficiency one keyed
        // A, whose first reply reaches it.
        const written = (yield* sentFor("You write teaching material")).slice(2)
        expect(written).toHaveLength(17)
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

  test("a Skill the reply schema refuses leaves the Question untagged and held, as does a Book Label two bands off", () =>
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

  test("after a Key Override, the Book's explanation stays an Approach only if it reaches the new key", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        // The explanations state no letter, and the second argues for the
        // Book's C, an erratum: every solve says D.
        const base = makeFakeBookModel({ solve: (stem) => (stem.startsWith("A shirt") ? "D" : undefined) })
        yield* (yield* FakeLlm).respondWith((request) => {
          const reply = base(request)
          if (!("content" in reply) || !(request.messages[0]?.content ?? "").includes("worked explanations")) return reply
          const value = JSON.parse(reply.content) as {
            explanations: Array<{ number: number; explanation: string; answer: string | null }>
          }
          return {
            ...reply,
            content: JSON.stringify({
              explanations: value.explanations.map((item) => ({
                ...item,
                answer: null,
                explanation: item.number === 2 ? "Divide $25 by 0.8 to get $31.25, so choose C." : item.explanation
              }))
            })
          }
        })
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, proposed.book.id, rangesOf(proposed))
        // An explanation stating no letter reaches its own Book's key.
        const db = yield* Db
        const first = yield* bankItem(proposed.book.id, 1)
        const routesOf = (questionId: string) =>
          db.select().from(approaches).where(eq(approaches.questionId, questionId)).orderBy(asc(approaches.position))
            .pipe(Effect.orDie)
        expect((yield* routesOf(first.question.id)).map((route) => [route.author, route.answer])).toEqual([
          ["book", "C"],
          ["llm", "C"]
        ])
        const second = byNumber(yield* curator.api.review.list(), 2)
        expect(codes(second)).toEqual(["solver-disagreement"])
        const written = (yield* sentFor("You write teaching material")).length

        yield* curator.api.review.overrideKey({ params: { id: second.id }, payload: { key: "D", reason: "Erratum: D." } })
        const id = second.question!.id
        yield* advanceUntil(bankItem(proposed.book.id, 2).pipe(
          Effect.map((row) => (row.question.status !== "draft" ? row : undefined))
        ), { step: "200 millis", maxSteps: 3000 })
        expect((yield* bankItem(proposed.book.id, 2)).question.status).toBe("published")
        expect((yield* routesOf(id)).map((route) => [route.author, route.answer])).toEqual([["llm", "D"]])
        // The model was not shown the explanation that argues for C.
        const rewrite = (yield* sentFor("You write teaching material")).slice(written)
        expect(rewrite).toHaveLength(1)
        expect(rewrite[0]?.messages.at(-1)?.content).not.toContain("so choose C")
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
        expect(extracted.book.report).toMatchObject({ extracted: 10, merged: 0, skippedGeometry: 1 })
        const db = yield* Db
        const own = yield* db.select().from(sources).where(eq(sources.bookId, proposed.book.id)).pipe(Effect.orDie)
        expect(own).toHaveLength(10)
        expect(new Set(own.map((source) => source.set))).toEqual(new Set(["Problem Solving practice", "Data Sufficiency"]))
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

  test("an explanation that comes or goes is checked again and its Approach follows it, even when the key stays", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        const full = rangesOf(proposed)
        const db = yield* Db
        const authorsOf = (number: number) =>
          Effect.gen(function*() {
            const item = yield* bankItem(proposed.book.id, number)
            const routes = yield* db.select({ author: approaches.author }).from(approaches)
              .where(eq(approaches.questionId, item.question.id)).orderBy(asc(approaches.position)).pipe(Effect.orDie)
            return routes.map((route) => route.author)
          })
        yield* confirmAndExtract(curator, proposed.book.id, withoutRole(full, "explanations"))
        expect((yield* bankItem(proposed.book.id, 6)).question.status).toBe("published")
        expect(yield* authorsOf(1)).toEqual(["llm"])

        // The sixth explanation says D, against the key's C.
        yield* confirmAndExtract(curator, proposed.book.id, full)
        const items = yield* curator.api.review.list()
        expect(byNumber(items, 6).question).toMatchObject({ key: "C", status: "held" })
        expect(codes(byNumber(items, 6))).toEqual(["key-conflict"])
        expect(yield* authorsOf(1)).toEqual(["book", "llm"])

        yield* confirmAndExtract(curator, proposed.book.id, withoutRole(full, "explanations"))
        expect((yield* bankItem(proposed.book.id, 6)).question.status).toBe("published")
        expect(yield* authorsOf(1)).toEqual(["llm"])
      }),
      AllJobKinds
    ))

  test("a Book Label that a fix brings sends the Question through the gate again", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        // The Book labels the first question hard; the model estimates it easy.
        yield* withModel({
          label: (number) => (number === 1 ? "hard" : null),
          difficulty: (stem) => (stem.startsWith("If \\(3x + 1") ? -1.2 : 0)
        })
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        const full = rangesOf(proposed)
        // The labels are printed with the explanations.
        yield* confirmAndExtract(curator, proposed.book.id, withoutRole(full, "explanations"))
        expect((yield* bankItem(proposed.book.id, 1)).question).toMatchObject({
          status: "published",
          difficultySeed: -1.2,
          difficultyBasis: "estimate"
        })
        yield* confirmAndExtract(curator, proposed.book.id, full)
        expect((yield* bankItem(proposed.book.id, 1)).question).toMatchObject({
          status: "held",
          bookLabel: "hard",
          difficultySeed: 1,
          difficultyBasis: "book-label"
        })
        expect(codes(byNumber(yield* curator.api.review.list(), 1))).toEqual(["difficulty"])
      }),
      AllJobKinds
    ))

  test("a fix keeps the questions about a key that a Key Override settled", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        const full = rangesOf(proposed)
        yield* confirmAndExtract(curator, proposed.book.id, full)
        const sixth = byNumber(yield* curator.api.review.list(), 6)
        expect(codes(sixth)).toEqual(["key-conflict"])
        yield* curator.api.review.overrideKey({ params: { id: sixth.id }, payload: { key: "D", reason: "Errata say D." } })
        const back = yield* advanceUntil(
          curator.api.review.list().pipe(Effect.map((items) => items.find((item) => item.id === sixth.id))),
          { step: "200 millis", maxSteps: 3000 }
        )
        expect(codes(back)).toEqual(["solver-disagreement"])
        yield* curator.api.review.publish({ params: { id: back.id } })

        // The answer key range is dropped, then restored.
        yield* confirmAndExtract(curator, proposed.book.id, withoutRole(full, "answer-key"))
        yield* confirmAndExtract(curator, proposed.book.id, full)
        const now = yield* bankItem(proposed.book.id, 6)
        expect(now).toMatchObject({ key: "D", keyBasis: "override" })
        expect(now.question.status).toBe("published")
        expect(now.question.linkReasons).not.toContain("key-conflict")
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
        expect(extracted.book.report).toMatchObject({ extracted: 8, skippedGeometry: 0 })
        const db = yield* Db
        const own = yield* db.select().from(sources).where(eq(sources.bookId, proposed.book.id)).pipe(Effect.orDie)
        expect(own.map((source) => source.number).toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 10, 11])
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

describe("When a reply or a job falls short", () => {
  const withoutRole = (ranges: ReadonlyArray<MapRangeInput>, role: MapRangeInput["role"]) =>
    ranges.filter((range) => !(range.role === role && range.group === "ps"))

  test("a Question another Book's fix sends back is checked by a job that Book's run queues", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const first = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, first.book.id, rangesOf(first))
        const third = yield* bankItem(first.book.id, 3)
        const second = yield* proposedBook(curator, "Second edition", undefined, { 3: "B" })
        const secondRanges = rangesOf(second)
        // Without its answer key, the second edition's third question joins
        // the first edition's; with it, its key B holds that Question.
        yield* confirmAndExtract(curator, second.book.id, withoutRole(secondRanges, "answer-key"))
        yield* confirmAndExtract(curator, second.book.id, secondRanges)
        expect((yield* bankItem(first.book.id, 3)).question.status).toBe("held")

        // The second edition's first page of questions leaves its map, and
        // with it the Source that disagreed.
        const later = secondRanges.map((range) =>
          range.role === "questions" && range.group === "ps" ? { ...range, firstPage: 3 } : range
        )
        yield* confirmAndExtract(curator, second.book.id, later)
        const db = yield* Db
        const [refresh] = yield* db.select().from(jobs).where(eq(jobs.kind, "question-refresh")).pipe(Effect.orDie)
        expect(JSON.parse(refresh!.params)).toMatchObject({ questionIds: [third.question.id] })
        const now = yield* advanceUntil(
          bankItem(first.book.id, 3).pipe(Effect.map((row) => (row.question.status === "draft" ? undefined : row))),
          { step: "200 millis", maxSteps: 3000 }
        )
        expect(now.question.id).toBe(third.question.id)
        expect(now.question.status).toBe("published")
        expect(yield* curator.api.review.drafts()).toMatchObject({ checking: 0, paused: 0, stranded: 0 })
      }),
      AllJobKinds
    ))

  test("a Source that brings the only explanation rewrites the Approaches, and so does its leaving", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const first = yield* proposedBook(curator)
        // The first edition is read without its explanations.
        yield* confirmAndExtract(curator, first.book.id, withoutRole(rangesOf(first), "explanations"))
        const authors = (questionId: string) =>
          Effect.gen(function*() {
            const db = yield* Db
            const rows = yield* db.select({ author: approaches.author }).from(approaches)
              .where(eq(approaches.questionId, questionId)).orderBy(asc(approaches.position)).pipe(Effect.orDie)
            return rows.map((row) => row.author)
          })
        const third = yield* bankItem(first.book.id, 3)
        expect(third.question.status).toBe("published")
        expect(yield* authors(third.question.id)).toEqual(["llm"])

        // The second edition joins it as a Source with an explanation, which
        // becomes an Approach of its own.
        const second = yield* proposedBook(curator, "Second edition")
        const secondRanges = rangesOf(second)
        yield* confirmAndExtract(curator, second.book.id, secondRanges)
        expect((yield* bankItem(first.book.id, 3)).question.status).toBe("published")
        expect(yield* authors(third.question.id)).toEqual(["book", "llm"])

        // Then the second edition's first page of questions leaves its map:
        // the Approaches are written again without that explanation.
        const later = secondRanges.map((range) =>
          range.role === "questions" && range.group === "ps" ? { ...range, firstPage: 3 } : range
        )
        yield* confirmAndExtract(curator, second.book.id, later)
        const back = yield* advanceUntil(
          bankItem(first.book.id, 3).pipe(Effect.map((row) => (row.question.status === "draft" ? undefined : row))),
          { step: "200 millis", maxSteps: 3000 }
        )
        expect(back.question.status).toBe("published")
        expect(yield* authors(third.question.id)).toEqual(["llm"])
      }),
      AllJobKinds
    ))

  test("another Book's run leaves a cancelled run's drafts for the Curator to send for checking", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const first = yield* proposedBook(curator)
        // The API is down for Approaches, so the first run pauses while
        // enriching, and the Curator cancels it.
        yield* (yield* FakeLlm).respondWith((request) =>
          (request.messages[0]?.content ?? "").includes("You write teaching material")
            ? { status: 503, message: "down" }
            : fakeBookModel(request)
        )
        yield* curator.api.books.confirmMap({ params: { id: first.book.id }, payload: { ranges: rangesOf(first) } })
        const paused = yield* waitFor(curator, first.book.id, (detail) =>
          detail.book.job?.kind === "book-extract" && detail.book.job.status === "paused")
        yield* curator.api.jobs.cancel({ params: { id: paused.book.job!.id } })
        const stranded = (yield* curator.api.review.drafts()).stranded
        expect(stranded).toBeGreaterThan(3)
        yield* (yield* FakeLlm).respondWith(fakeBookModel)

        // The second edition's run covers questions 7 to 9 only.
        const second = yield* proposedBook(curator, "Second edition")
        const lastPage = rangesOf(second).map((range) =>
          range.role === "questions" && range.group === "ps" ? { ...range, firstPage: 4 } : range
        )
        const before = (yield* (yield* FakeLlm).requests).length
        yield* confirmAndExtract(curator, second.book.id, lastPage)
        const sent = (yield* (yield* FakeLlm).requests).slice(before)
        // Its run never sent the first edition's sixth question to the model.
        expect(sent.some((request) => (request.messages[1]?.content ?? "").includes("What is 15 percent of 80"))).toBe(false)
        expect((yield* bankItem(first.book.id, 6)).question.status).toBe("draft")
        const waiting = yield* curator.api.review.drafts()
        expect(waiting).toMatchObject({ checking: 0, paused: 0 })
        expect(waiting.stranded).toBeGreaterThan(3)

        // The Curator sends them for checking.
        yield* curator.api.review.checkDrafts()
        const done = yield* advanceUntil(
          curator.api.review.drafts().pipe(Effect.map((view) => (view.checking === 0 && view.stranded === 0 ? view : undefined))),
          { step: "200 millis", maxSteps: 3000 }
        )
        expect(done).toMatchObject({ checking: 0, paused: 0, stranded: 0 })
        expect((yield* bankItem(first.book.id, 6)).question.status).not.toBe("draft")
      }),
      AllJobKinds
    ))

  test("a draft whose only job is paused is counted as waiting for that job", () =>
    runWithWorkers(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const workers = yield* TestWorkers
        const worker = yield* workers.start
        const proposed = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, proposed.book.id, rangesOf(proposed))
        const sixth = byNumber(yield* curator.api.review.list(), 6)
        yield* Fiber.interrupt(worker)
        yield* curator.api.review.overrideKey({ params: { id: sixth.id }, payload: { key: "D", reason: "Errata." } })
        const db = yield* Db
        const [refresh] = yield* db.select().from(jobs).where(eq(jobs.kind, "question-refresh")).pipe(Effect.orDie)
        yield* curator.api.jobs.pause({ params: { id: refresh!.id as never } })
        expect(yield* curator.api.review.drafts()).toMatchObject({ checking: 0, paused: 1, stranded: 0 })
        // "Check them now" leaves it to the paused job.
        expect(yield* curator.api.review.checkDrafts()).toMatchObject({ checking: 0, paused: 1, stranded: 0 })
        expect((yield* db.select().from(jobs).where(eq(jobs.kind, "question-refresh")).pipe(Effect.orDie)).length).toBe(1)
      }),
      AllJobKinds
    ))

  test("starting the app again does not queue work the Curator cancelled", async () => {
    const dataDir = tempDataDir()
    await runWithWorkers(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const workers = yield* TestWorkers
        const worker = yield* workers.start
        const proposed = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, proposed.book.id, rangesOf(proposed))
        const sixth = byNumber(yield* curator.api.review.list(), 6)
        yield* Fiber.interrupt(worker)
        yield* curator.api.review.overrideKey({ params: { id: sixth.id }, payload: { key: "D", reason: "Errata." } })
        const db = yield* Db
        const [refresh] = yield* db.select().from(jobs).where(eq(jobs.kind, "question-refresh")).pipe(Effect.orDie)
        yield* curator.api.jobs.cancel({ params: { id: refresh!.id as never } })
      }),
      AllJobKinds,
      dataDir
    )
    await runWithWorkers(
      Effect.gen(function*() {
        const db = yield* Db
        const refreshes = yield* db.select().from(jobs).where(eq(jobs.kind, "question-refresh")).pipe(Effect.orDie)
        expect(refreshes.map((job) => job.status)).toEqual(["cancelled"])
        // The draft waits for the Curator.
        const drafts = yield* db.select({ id: questions.id }).from(questions).where(eq(questions.status, "draft"))
          .pipe(Effect.orDie)
        expect(drafts).toHaveLength(1)
      }),
      AllJobKinds,
      dataDir
    )
  })

  test("a draft whose job was cancelled is counted, and checked when the Curator asks", () =>
    runWithWorkers(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const workers = yield* TestWorkers
        const worker = yield* workers.start
        const proposed = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, proposed.book.id, rangesOf(proposed))
        const sixth = byNumber(yield* curator.api.review.list(), 6)
        // With no worker running, the Key Override's job waits, and is
        // cancelled.
        yield* Fiber.interrupt(worker)
        yield* curator.api.review.overrideKey({ params: { id: sixth.id }, payload: { key: "D", reason: "Errata." } })
        expect(yield* curator.api.review.drafts()).toMatchObject({ checking: 1, stranded: 0 })
        const db = yield* Db
        const [refresh] = yield* db.select().from(jobs).where(eq(jobs.kind, "question-refresh")).pipe(Effect.orDie)
        yield* curator.api.jobs.cancel({ params: { id: refresh!.id as never } })
        expect(yield* curator.api.review.drafts()).toMatchObject({ checking: 0, stranded: 1 })

        expect(yield* curator.api.review.checkDrafts()).toMatchObject({ checking: 1, stranded: 0 })
        yield* workers.start
        const back = yield* advanceUntil(
          curator.api.review.list().pipe(Effect.map((items) => items.find((item) => item.id === sixth.id))),
          { step: "200 millis", maxSteps: 3000 }
        )
        expect(back.question).toMatchObject({ key: "D", status: "held" })
        expect(codes(back)).toEqual(["solver-disagreement"])
      }),
      AllJobKinds
    ))

  test("Check again asks again for tags an unusable reply left out", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        // A Verbal Skill for the first question, which the reply schema
        // refuses twice.
        yield* withModel({
          skill: (stem, offered) => (stem.startsWith("If \\(3x + 1") ? "verbal.cr-reasoning.assumptions" : offered[0]!)
        })
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, proposed.book.id, rangesOf(proposed))
        const first = byNumber(yield* curator.api.review.list(), 1)
        expect(codes(first)).toEqual(["tags"])
        expect(first.checkable).toBe(true)
        // Items whose reasons a new reply cannot settle are not checkable,
        // nor is text in doubt, which is not enriched at all.
        expect(byNumber(yield* curator.api.review.list(), 6).checkable).toBe(false)
        expect(codes(byNumber(yield* curator.api.review.list(), 9))).toEqual(["render"])
        expect(byNumber(yield* curator.api.review.list(), 9).checkable).toBe(false)
        const notCheckable = yield* curator.api.review.checkAgain({ params: { id: byNumber(yield* curator.api.review.list(), 6).id } })
          .pipe(Effect.flip)
        expect(notCheckable._tag).toBe("ReviewItemNotOpen")

        yield* (yield* FakeLlm).respondWith(fakeBookModel)
        const tagged = (yield* sentFor("You tag a GMAT question")).length
        const checking = yield* curator.api.review.checkAgain({ params: { id: first.id } })
        expect(checking.question?.status).toBe("draft")
        yield* advanceUntil(
          bankItem(proposed.book.id, 1).pipe(Effect.map((row) => (row.question.status !== "draft" ? row : undefined))),
          { step: "200 millis", maxSteps: 3000 }
        )
        expect((yield* bankItem(proposed.book.id, 1)).question.status).toBe("published")
        expect((yield* sentFor("You tag a GMAT question")).length).toBe(tagged + 1)
      }),
      AllJobKinds
    ))

  test("Check again writes again the Approaches that missed the key", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        let fourth = false
        const respond = makeFakeBookModel({ approachAnswer: (key) => (fourth ? "A" : key) })
        yield* (yield* FakeLlm).respondWith((request) => {
          fourth = (request.messages[1]?.content ?? "").includes("In how many ways")
          return respond(request)
        })
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, proposed.book.id, rangesOf(proposed))
        const item = byNumber(yield* curator.api.review.list(), 4)
        expect(codes(item)).toEqual(["approach-misses-key"])
        yield* (yield* FakeLlm).respondWith(fakeBookModel)
        const written = (yield* sentFor("You write teaching material")).length
        yield* curator.api.review.checkAgain({ params: { id: item.id } })
        yield* advanceUntil(
          bankItem(proposed.book.id, 4).pipe(Effect.map((row) => (row.question.status !== "draft" ? row : undefined))),
          { step: "200 millis", maxSteps: 3000 }
        )
        expect((yield* bankItem(proposed.book.id, 4)).question.status).toBe("published")
        expect((yield* sentFor("You write teaching material")).length).toBe(written + 1)
      }),
      AllJobKinds
    ))

  test("a merge after a Key Override that agrees carries the override to the Question it joins", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const first = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, first.book.id, rangesOf(first))
        // The second edition misprints question 3's key as B.
        const second = yield* proposedBook(curator, "Second edition", undefined, { 3: "B" })
        yield* confirmAndExtract(curator, second.book.id, rangesOf(second))
        const item = byNumber(yield* curator.api.review.list(), 3)
        expect(codes(item)).toContain("same-text-other-key")
        yield* curator.api.review.overrideKey({ params: { id: item.id }, payload: { key: "C", reason: "Misprint; it is C." } })
        const back = yield* advanceUntil(
          curator.api.review.list().pipe(Effect.map((items) => items.find((each) => each.id === item.id))),
          { step: "200 millis", maxSteps: 3000 }
        )
        expect(codes(back)).toEqual(["same-text-other-key"])

        yield* curator.api.review.merge({ params: { id: back.id } })
        yield* advanceUntil(Effect.succeed(undefined), { step: "200 millis", maxSteps: 20 }).pipe(Effect.ignore)
        // The first edition's Question stays published, now under the
        // Curator's key, which settles the misprinted Source.
        const joined = yield* bankItem(first.book.id, 3)
        expect(joined).toMatchObject({ key: "C", keyBasis: "override" })
        expect(joined.question.status).toBe("published")
        expect(JSON.parse(joined.question.linkReasons)).toEqual([])
        const db = yield* Db
        const overrides = yield* db.select().from(keyOverrides).pipe(Effect.orDie)
        expect(overrides).toMatchObject([{ partId: joined.partId, newKey: "C", reason: "Misprint; it is C." }])
      }),
      AllJobKinds
    ))

  test("a merge that would lose a Key Override is refused, and a merge into a Question being checked waits", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, proposed.book.id, rangesOf(proposed))
        const eighth = byNumber(yield* curator.api.review.list(), 8)
        expect(codes(eighth)).toEqual(["near-match"])
        yield* curator.api.review.overrideKey({ params: { id: eighth.id }, payload: { key: "D", reason: "Errata say D." } })
        const back = yield* advanceUntil(
          curator.api.review.list().pipe(Effect.map((items) => items.find((item) => item.id === eighth.id))),
          { step: "200 millis", maxSteps: 3000 }
        )
        const refused = yield* curator.api.review.merge({ params: { id: back.id } }).pipe(Effect.flip)
        expect(refused).toMatchObject({ _tag: "KeysDiffer", key: "D", relatedKey: "C" })
        const db = yield* Db
        expect(yield* db.select().from(keyOverrides).pipe(Effect.orDie)).toHaveLength(1)

        // While the related Question is being checked, a merge into it waits.
        yield* db.update(questions).set({ status: "draft" }).where(eq(questions.id, back.related!.id)).pipe(Effect.orDie)
        const waits = yield* curator.api.review.merge({ params: { id: back.id } }).pipe(Effect.flip)
        expect(waits._tag).toBe("MergeTargetChecking")
      }),
      AllJobKinds
    ))

  test("a Question of the first Book that the second Book's run publishes joins the Reserve decision", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const first = yield* proposedBook(curator)
        // Without its answer key and explanations the first edition has no
        // keys, so its Questions are held.
        yield* confirmAndExtract(curator, first.book.id, rangesOf(first).filter((range) => range.role === "questions"))
        const second = yield* proposedBook(curator, "Second edition")
        yield* confirmAndExtract(curator, second.book.id, rangesOf(second))
        const third = yield* bankItem(first.book.id, 3)
        expect(third.question.status).toBe("published")
        expect(third.question.reserve).not.toBeNull()
      }),
      AllJobKinds
    ))
})

// The verbal fixture Book: Problem Solving 1 to 9, Data Sufficiency 10 and
// 11, Critical Reasoning 12 to 14, and a passage with Reading Comprehension
// 15 to 17, the passage and 15 on one page and 16 and 17 on the next.
const verbalBook = (curator: Effect.Success<typeof curatorBrowser>) =>
  Effect.gen(function*() {
    const proposed = yield* proposedFrom(curator, { edition: "First edition", verbal: true })
    return yield* confirmAndExtract(curator, proposed.book.id, rangesOf(proposed))
  })

describe("Extracting verbal and Data Sufficiency Questions", () => {
  test("each item joins its Section, a passage becomes one Stimulus, and the Taxonomy's type rules hold", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const extracted = yield* verbalBook(curator)
        const id = extracted.book.id
        expect(extracted.book.report).toMatchObject({ extracted: 16, skippedGeometry: 1 })
        // The model read the boldface question as an inference and the
        // EXCEPT question as a weakener; the question's own words settle them.
        const cr = yield* Effect.forEach([12, 13, 14], (number) => bankItem(id, number))
        expect(cr.map((item) => [item.question.section, item.question.questionType, item.question.status])).toEqual([
          ["verbal", "verbal.cr-weaken", "published"],
          ["verbal", "verbal.cr-structure", "published"],
          ["verbal", "verbal.cr-strengthen", "published"]
        ])
        const rc = yield* Effect.forEach([15, 16, 17], (number) => bankItem(id, number))
        expect(rc.map((item) => [item.question.questionType, item.question.status])).toEqual([
          ["verbal.rc-main-idea", "published"],
          ["verbal.rc-detail", "published"],
          ["verbal.rc-application", "published"]
        ])
        const db = yield* Db
        const passages = yield* db.select().from(stimuli).pipe(Effect.orDie)
        expect(passages).toMatchObject([{ kind: "passage", body: PassageLines.join(" ") }])
        expect(rc.map((item) => item.question.stimulusId)).toEqual([passages[0]!.id, passages[0]!.id, passages[0]!.id])
        // The Mock Reserve decides the passage as one.
        expect(new Set(rc.map((item) => item.question.reserve)).size).toBe(1)
        // Old-style Data Sufficiency joins Data Insights, with Quant maths and
        // one sufficiency Skill.
        const value = yield* bankItem(id, 10)
        expect(value.question).toMatchObject({
          section: "di",
          questionType: "di.ds",
          stem: "What is the value of x?\n\n(1) x + 2 = 5\n\n(2) x is a prime number.",
          status: "published",
          primarySkill: expect.stringMatching(/^quant\./)
        })
        expect(value.key).toBe("A")
        expect(JSON.parse(value.question.secondarySkills)).toEqual(["di.sufficiency.value"])
        expect(JSON.parse((yield* bankItem(id, 11)).question.secondarySkills)).toEqual(["di.sufficiency.yes-no"])
        // Enrichment reads the passage with each of its Questions.
        const tagged = (yield* sentFor("You tag a GMAT question")).filter((request) =>
          (request.messages.at(-1)?.content ?? "").includes("how many times did the council meet")
        )
        expect(tagged[0]?.messages.at(-1)?.content).toContain(`The passage:\n${PassageLines.join(" ")}`)
        const sufficiency = (yield* sentFor("You tag a GMAT question")).filter((request) =>
          (request.messages[0]?.content ?? "").includes("This is a Data Sufficiency question")
        )
        expect(sufficiency).toHaveLength(2)
      }),
      AllJobKinds
    ))

  test("the golden set covers them: the check reads a passage from the page before its Question", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        yield* verbalBook(curator)
        const golden = curator.api.golden
        const view = yield* golden.get()
        const candidate = (number: number) => view.candidates.find((each) => each.number === number)!
        expect(candidate(16).stimulus).toMatchObject({ kind: "passage", body: PassageLines.join(" ") })
        for (const number of [10, 13, 16]) {
          const each = candidate(number)
          yield* golden.approve({
            params: { questionId: each.questionId },
            payload: { primarySkill: each.primarySkill!, secondarySkills: [...each.secondarySkills] }
          })
        }
        yield* golden.check({ payload: { spendCap: 1 } })
        const done = yield* advanceUntil(
          golden.get().pipe(Effect.map((current) => (current.report !== null ? current : undefined))),
          { step: "200 millis", maxSteps: 3000 }
        )
        expect(done.report).toMatchObject({ items: 3, textExact: 3, keysExact: 3, tagAgreement: 1, passed: true })
      }),
      AllJobKinds
    ))
})

describe("The golden set", () => {
  test("a merge takes the merged Question's approval with it, and a check reads only the approved item", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const first = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, first.book.id, rangesOf(first))
        const golden = curator.api.golden
        const view = yield* golden.get()
        const of = (number: number) => view.candidates.find((each) => each.number === number)!
        // The eighth, held as a near match of the first, and the first are
        // both approved.
        for (const number of [1, 8]) {
          yield* golden.approve({
            params: { questionId: of(number).questionId },
            payload: { primarySkill: of(number).primarySkill!, secondarySkills: [] }
          })
        }
        const item = byNumber(yield* curator.api.review.list(), 8)
        expect(item.question?.golden).toBe(true)
        yield* curator.api.review.merge({ params: { id: item.id } })
        const after = yield* golden.get()
        expect(after.approved).toBe(1)
        expect(after.candidates.filter((each) => each.approved).map((each) => each.number)).toEqual([1])

        // The first now has the eighth's item as a Source in the same Book;
        // the check reads the first's own item only.
        yield* golden.check({ payload: { spendCap: 1 } })
        const done = yield* advanceUntil(
          golden.get().pipe(Effect.map((current) => (current.report !== null ? current : undefined))),
          { step: "200 millis", maxSteps: 3000 }
        )
        expect(done.report).toMatchObject({ items: 1, passed: true, misses: [] })
      }),
      AllJobKinds
    ))

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
        expect(view.candidates.map((candidate) => candidate.number)).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 10, 11])
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

  test("a check expects the Book's key, tags as production does, covers the set it started with, and runs alone", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure
        const curator = yield* curatorBrowser
        const proposed = yield* proposedBook(curator)
        yield* confirmAndExtract(curator, proposed.book.id, rangesOf(proposed))
        // The Curator overrides the sixth's key to its explanation's D.
        const sixth = byNumber(yield* curator.api.review.list(), 6)
        yield* curator.api.review.overrideKey({ params: { id: sixth.id }, payload: { key: "D", reason: "Errata." } })
        yield* advanceUntil(
          curator.api.review.list().pipe(Effect.map((items) => items.find((item) => item.id === sixth.id))),
          { step: "200 millis", maxSteps: 3000 }
        )
        const golden = curator.api.golden
        const view = yield* golden.get()
        const candidate = (number: number) => view.candidates.find((each) => each.number === number)!
        expect(candidate(6)).toMatchObject({ key: "D", bookKey: "C" })
        for (const number of [1, 6]) {
          yield* golden.approve({
            params: { questionId: candidate(number).questionId },
            payload: { primarySkill: candidate(number).primarySkill!, secondarySkills: [] }
          })
        }
        // Tagging during the check waits until released, so the Curator can
        // approve another Question while it runs.
        let hold = true
        let asked = 0
        yield* (yield* FakeLlm).respondWith((request) => {
          if ((request.messages[0]?.content ?? "").includes("You tag a GMAT question") && hold) {
            asked += 1
            return { status: 503, message: "busy" }
          }
          return fakeBookModel(request)
        })
        const tagRequests = (yield* sentFor("You tag a GMAT question")).length
        yield* golden.check({ payload: { spendCap: 1 } })
        const twice = yield* golden.check({ payload: { spendCap: 1 } }).pipe(Effect.flip)
        expect(twice._tag).toBe("GoldenCheckRunning")
        yield* advanceUntil(Effect.sync(() => (asked > 0 ? true : undefined)), { step: "200 millis", maxSteps: 3000 })
        yield* golden.approve({
          params: { questionId: candidate(4).questionId },
          payload: { primarySkill: candidate(4).primarySkill!, secondarySkills: [] }
        })
        hold = false
        const done = yield* advanceUntil(
          golden.get().pipe(Effect.map((current) => (current.report !== null ? current : undefined))),
          { step: "1 second", maxSteps: 3000 }
        )
        expect(done.report).toMatchObject({ items: 2, textExact: 2, keysExact: 2, passed: true })
        const checkTags = (yield* sentFor("You tag a GMAT question")).slice(tagRequests)
          .filter((request) => (request.messages.at(-1)?.content ?? "").length > 0)
        expect(checkTags.some((request) => (request.messages.at(-1)?.content ?? "").includes("The book's explanation:")))
          .toBe(true)
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
        // The fake tags every Question with the first maths Skill it is
        // offered, the 2 Data Sufficiency ones too.
        const first = (yield* bankItem(proposed.book.id, 1)).question.primarySkill!
        expect(thin.find((skill) => skill.id === first)?.questions).toBe(7)
        expect(thin.every((skill) => /^(quant|di)\./.test(skill.id) && skill.questions < 15)).toBe(true)
        expect(thin.at(-1)?.id).toBe(first)
        expect(thin.length).toBeGreaterThan(10)
      }),
      AllJobKinds
    ))

  test("a Learner practises an extracted Book in order, past its Reserve Questions and held items", () =>
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
        // A Problem Solving and a Data Sufficiency Question are held for
        // Mocks.
        expect(started.total).toBe(5)
        expect(started.heldForMocks).toHaveLength(2)
        expect(started.unavailable).toHaveLength(3)
        expect(started.current?.question.source).toMatchObject({ bookTitle: "Practice Questions, First edition", page: 2 })

        const reserve = yield* curator.api.bank.reserve()
        expect(reserve.find((section) => section.id === "quant")).toMatchObject({ questions: 5, held: 1, released: 0 })
        yield* curator.api.bank.releaseReserve({ payload: { section: "quant", count: 1 } })
        const after = yield* learner.api.practice.preview({ payload: { choice } })
        expect(after).toMatchObject({ questions: 6, heldForMocks: 1, unavailable: 3 })
      }),
      AllJobKinds
    ))
})
