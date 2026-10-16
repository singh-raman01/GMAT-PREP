import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { DefaultBlueprint } from "../src/api/blueprint.ts"
import { BookId } from "../src/api/Books.ts"
import { Db } from "../src/server/db/Database.ts"
import { books } from "../src/server/db/schema.ts"
import { paperSeenOf } from "../src/server/practice/paperSeen.ts"
import { numbered, seedBook } from "./fixtures/bank.ts"
import { openBrowser, runWithWorkers } from "./harness.ts"

describe("Paper Marks", () => {
  test("mark a Book or a page range of it, and count the published Questions each makes Seen", () =>
    runWithWorkers(Effect.gen(function*() {
      // One item a page, pages 1 to 10; item 3 is withdrawn.
      const og = yield* seedBook("Official Guide", [...numbered(2), { number: 3, status: "withdrawn" }, ...numbered(7, {}, 4)])
      const asha = yield* openBrowser
      yield* asha.profiles.create({ payload: { name: "Asha" } })
      const bookId = BookId.make(og.bookId)
      const range = yield* asha.paperMarks.add({ payload: { bookId, firstPage: 2, lastPage: 5 } })
      expect(range.map((mark) => [mark.book.title, mark.firstPage, mark.lastPage, mark.questions])).toEqual([
        ["Official Guide", 2, 5, 3]
      ])
      yield* TestClock.adjust("1 minute")
      const both = yield* asha.paperMarks.add({ payload: { bookId, firstPage: null, lastPage: null } })
      expect(both.map((mark) => [mark.firstPage, mark.lastPage, mark.questions])).toEqual([[null, null, 9], [2, 5, 3]])

      const ben = yield* openBrowser
      yield* ben.profiles.create({ payload: { name: "Ben" } })
      expect(yield* ben.paperMarks.list()).toEqual([])
      const notHis = yield* ben.paperMarks.remove({ params: { id: both[0]!.id } }).pipe(Effect.flip)
      expect(notHis._tag).toBe("PaperMarkNotFound")
      const left = yield* asha.paperMarks.remove({ params: { id: both[0]!.id } })
      expect(left.map((mark) => mark.id)).toEqual([range[0]!.id])
    })))

  test("refuse a range given by one end, backwards, or past the Book's last page, and a Book that is not there", () =>
    runWithWorkers(Effect.gen(function*() {
      const og = yield* seedBook("Official Guide", numbered(3))
      const db = yield* Db
      yield* db.update(books).set({ pageCount: 8 }).where(eq(books.id, og.bookId)).pipe(Effect.orDie)
      const asha = yield* openBrowser
      yield* asha.profiles.create({ payload: { name: "Asha" } })
      const bookId = BookId.make(og.bookId)
      const problems = (firstPage: number | null, lastPage: number | null) =>
        asha.paperMarks.add({ payload: { bookId, firstPage, lastPage } }).pipe(
          Effect.flip,
          Effect.map((error) => (error._tag === "PaperMarkInvalid" ? error.problems : error._tag))
        )
      expect(yield* problems(3, null)).toEqual(["Give both the first and the last page, or neither for the whole Book."])
      expect(yield* problems(6, 4)).toEqual(["Page 6 comes after page 4."])
      expect(yield* problems(7, 9)).toEqual(["The Book has 8 pages."])
      const missing = yield* asha.paperMarks.add({
        payload: { bookId: BookId.make(crypto.randomUUID()), firstPage: null, lastPage: null }
      }).pipe(Effect.flip)
      expect(missing._tag).toBe("BookNotFound")
      expect(yield* asha.paperMarks.list()).toEqual([])
    })))
})

describe("What Paper Marks make Seen", () => {
  const mark = (id: string, bookId: string, firstPage: number | null, lastPage: number | null, createdAt: number) => ({
    id,
    bookId,
    firstPage,
    lastPage,
    createdAt
  })

  test("a Question is Seen from the earliest mark covering one of its Sources, as the Question it counts as", () => {
    const seen = paperSeenOf(
      [mark("whole", "og", null, null, 300), mark("range", "og", 10, 20, 100), mark("other", "review", 1, 5, 50)],
      [
        { questionId: "q10", bookId: "og", page: 10 },
        { questionId: "q30", bookId: "og", page: 30 },
        // Merged into q10: its marks count for q10.
        { questionId: "m1", bookId: "review", page: 2 },
        { questionId: "q9", bookId: "review", page: 9 }
      ],
      (id) => (id === "m1" ? "q10" : id)
    )
    expect(Object.fromEntries(seen)).toEqual({ q10: 50, q30: 300 })
  })
})

describe("Paper-Marked Questions", () => {
  const smallBlueprint = Effect.gen(function*() {
    const curator = yield* openBrowser
    yield* curator.curatorAccess.setPassphrase({ payload: { passphrase: "correct horse battery" } })
    yield* curator.settings.saveBlueprint({ payload: { blueprint: { ...DefaultBlueprint, ps: 4 } } })
  })

  test("are Seen: held for Mocks, they open to Practice and leave the start check, until the mark goes", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* smallBlueprint
      const og = yield* seedBook("Official Guide", numbered(10, { reserve: true, seed: 0 }))
      const asha = yield* openBrowser
      yield* asha.profiles.create({ payload: { name: "Asha" } })
      const unseen = asha.sectionals.options().pipe(
        Effect.map((options) => options.sections.find((section) => section.section.id === "quant")!.groups[0]!.unseen)
      )
      const practice = asha.practice.preview({
        payload: { choice: { kind: "filters", section: "quant", status: "any", size: 10 } }
      }).pipe(Effect.map((preview) => preview.questions))
      expect([yield* unseen, yield* practice]).toEqual([10, 0])

      const marked = yield* asha.paperMarks.add({ payload: { bookId: BookId.make(og.bookId), firstPage: 1, lastPage: 4 } })
      expect([yield* unseen, yield* practice]).toEqual([6, 4])
      expect((yield* asha.sectionals.options()).sections.find((section) => section.section.id === "quant")!.ready)
        .toBe(false)

      yield* asha.paperMarks.remove({ params: { id: marked[0]!.id } })
      expect([yield* unseen, yield* practice]).toEqual([10, 0])
    })))

  test("are never Rated, though a timed set serves them", () =>
    runWithWorkers(Effect.gen(function*() {
      const og = yield* seedBook("Official Guide", numbered(3))
      const timedSet = (who: Effect.Success<typeof openBrowser>) =>
        Effect.gen(function*() {
          let view = yield* who.practice.start({ payload: { choice: { kind: "filters", status: "any", size: 3, timed: true } } })
          while (view.current !== null) {
            view = yield* who.practice.answer({
              params: { id: view.id },
              payload: { seq: view.nextSeq, questionId: view.current.question.id, selection: [{ part: 0, choice: "C" }], guessed: false }
            })
          }
          return yield* who.practice.scores()
        })
      const asha = yield* openBrowser
      yield* asha.profiles.create({ payload: { name: "Asha" } })
      yield* asha.paperMarks.add({ payload: { bookId: BookId.make(og.bookId), firstPage: null, lastPage: null } })
      yield* TestClock.adjust("1 minute")
      expect(yield* timedSet(asha)).toEqual([])

      const ben = yield* openBrowser
      yield* ben.profiles.create({ payload: { name: "Ben" } })
      expect((yield* timedSet(ben))[0]).toMatchObject({ ratedResponses: 3 })
    })))
})

describe("A Section and Paper Marks", () => {
  test("serves a passage marked on paper only when nothing unseen fits, and its report counts it", () =>
    runWithWorkers(Effect.gen(function*() {
      const curator = yield* openBrowser
      yield* curator.curatorAccess.setPassphrase({ payload: { passphrase: "correct horse battery" } })
      yield* curator.settings.saveBlueprint({ payload: { blueprint: { ...DefaultBlueprint, rc: [3, 4], cr: 1 } } })
      const rc = { questionType: "verbal.rc-detail", primarySkill: "verbal.reading.detail" }
      const cr = { questionType: "verbal.cr-weaken", primarySkill: "verbal.arguments.causal" }
      const seeded = yield* seedBook("Verbal Review", [
        ...[1, 2, 3, 4, 5].flatMap((p) => numbered(3, { ...rc, reserve: true, passage: `Passage ${p}.` }, p * 10)),
        ...numbered(2, { ...cr, reserve: true }, 100),
        // The one passage of four, on pages 200 to 203.
        ...numbered(4, { ...rc, reserve: false, passage: "A passage of four." }, 200)
      ])
      const four = [200, 201, 202, 203].map((n) => seeded.ids.get(n)!)
      const asha = yield* openBrowser
      yield* asha.profiles.create({ payload: { name: "Asha" } })
      yield* asha.paperMarks.add({ payload: { bookId: BookId.make(seeded.bookId), firstPage: 200, lastPage: 203 } })
      yield* TestClock.adjust("1 minute")
      let view = yield* asha.sectionals.start({ payload: { section: "verbal" } })
      while (view.stage === "question") {
        view = yield* asha.sectionals.answer({
          params: { id: view.id },
          payload: { seq: view.nextSeq, questionId: view.current!.question.id, selection: [{ part: 0, choice: "C" }] }
        })
      }
      const report = (yield* asha.sectionals.finish({ params: { id: view.id } })).report!
      const marked = report.results.filter((result) => four.includes(result.questionId))
      expect(marked).toHaveLength(4)
      expect(marked.every((result) => result.repeat)).toBe(true)
      expect(report).toMatchObject({ repeats: 4, paperRepeats: 4 })
      // None of them is Rated: only the passage of three and the CR Question are.
      expect((yield* asha.practice.scores())[0]).toMatchObject({ section: { id: "verbal" }, ratedResponses: 4 })
    })))
})
