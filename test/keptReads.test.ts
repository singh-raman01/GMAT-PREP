import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Effect, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { Api } from "../src/api/Api.ts"
import type { PracticeView } from "../src/api/Practice.ts"
import { AppConfig } from "../src/server/AppConfig.ts"
import { databaseFile, Db } from "../src/server/db/Database.ts"
import {
  bankVersion,
  books,
  difficulty,
  mistakeLabels,
  optionNotes,
  options,
  parts,
  questions,
  responses,
  sources
} from "../src/server/db/schema.ts"
import { makeSummaryReader, readSummaries } from "../src/server/learning/facts.ts"
import { numbered, seedBook } from "./fixtures/bank.ts"
import { seedExamBank, SmallBlueprint } from "./fixtures/examBank.ts"
import { openBrowser, runWithWorkers } from "./harness.ts"

// What the Error Log, the analytics and the Sectional engine keep between
// reads (decision 127) is read again once what it came from changes.

const learner = (name: string) =>
  Effect.gen(function*() {
    const jar = yield* Ref.make(Cookies.empty)
    const tab = yield* HttpApiClient.make(Api, {
      transformClient: (client) =>
        client.pipe(HttpClient.withCookiesRef(jar), HttpClient.mapRequest(HttpClientRequest.setHeader("x-gp-device", "tab-1")))
    })
    const profile = yield* tab.profiles.create({ payload: { name, timeZone: "UTC" } })
    return Object.assign(tab, { profileId: profile.id })
  })

const versionNow = Effect.gen(function*() {
  const db = yield* Db
  const [row] = yield* db.select({ version: bankVersion.version }).from(bankVersion).pipe(Effect.orDie)
  return row!.version
})

describe("Kept reads", () => {
  test("the Question Bank's version moves with every write to the tables a Question's summary comes from, and with no Learner's", () =>
    runWithWorkers(Effect.gen(function*() {
      const db = yield* Db
      const { bookId, ids } = yield* seedBook("Quant Review", numbered(2))
      const questionId = ids.get(1)!
      const [part] = yield* db.select({ id: parts.id }).from(parts).where(eq(parts.questionId, questionId)).pipe(Effect.orDie)
      const writes: ReadonlyArray<readonly [string, Effect.Effect<unknown, unknown>]> = [
        ["a question", db.update(questions).set({ stem: "Changed" }).where(eq(questions.id, questionId))],
        ["a part's key", db.update(parts).set({ key: "A" }).where(eq(parts.id, part!.id))],
        ["an option", db.update(options).set({ text: "\\(9\\)" }).where(and(eq(options.partId, part!.id), eq(options.position, 4)))],
        ["an option's note", db.delete(optionNotes).where(eq(optionNotes.partId, part!.id))],
        ["a source", db.update(sources).set({ explanation: "Another route." }).where(eq(sources.questionId, questionId))],
        ["a book", db.update(books).set({ title: "Quant Review, renamed" }).where(eq(books.id, bookId))]
      ]
      for (const [what, write] of writes) {
        const before = yield* versionNow
        yield* write.pipe(Effect.orDie)
        expect({ what, moved: (yield* versionNow) > before }).toEqual({ what, moved: true })
      }
      // A Learner's answers, labels and the Difficulty they move leave it.
      const asha = yield* learner("Asha")
      const before = yield* versionNow
      const set = yield* asha.practice.start({ payload: { choice: { kind: "filters", status: "any", size: 1 } } })
      const answered = yield* asha.practice.answer({
        params: { id: set.id },
        payload: { seq: set.nextSeq, questionId: set.current!.question.id, selection: [{ part: 0, choice: "B" }], guessed: false }
      })
      const [response] = yield* db.select({ id: responses.id }).from(responses).pipe(Effect.orDie)
      yield* db.insert(mistakeLabels).values({
        id: crypto.randomUUID(),
        profileId: asha.profileId,
        responseId: response!.id,
        part: 0,
        mistakeType: "misread",
        createdAt: 0
      }).pipe(Effect.orDie)
      yield* db.insert(difficulty).values({ questionId, value: 0.5, ratedResponses: 1 }).pipe(Effect.orDie)
      expect(answered.status).toBeDefined()
      expect(yield* versionNow).toBe(before)
    })))

  test("the Error Log reads a key another process changed, and the Difficulty a Rated Response moved", () =>
    runWithWorkers(Effect.gen(function*() {
      const { ids } = yield* seedBook("Quant Review", numbered(1))
      const asha = yield* learner("Asha")
      const set: PracticeView = yield* asha.practice.start({ payload: { choice: { kind: "filters", status: "any", size: 1 } } })
      yield* asha.practice.answer({
        params: { id: set.id },
        payload: { seq: set.nextSeq, questionId: set.current!.question.id, selection: [{ part: 0, choice: "A" }], guessed: false }
      })
      // A wrong answer: the key is C. Read once, so its summary is kept.
      const before = yield* asha.errorLog.list({ query: {} })
      expect(before.total).toBe(1)
      // The worker, on its own connection, moves the key to A: the answer is
      // now right, and the entry goes.
      const { dataDir } = yield* AppConfig
      const worker = new Database(databaseFile(dataDir))
      try {
        worker.run("UPDATE parts SET key = 'A' WHERE question_id = ?", [ids.get(1)!])
      } finally {
        worker.close()
      }
      const after = yield* asha.errorLog.list({ query: {} })
      expect(after.total).toBe(0)
      // And back to C: the miss returns, read from the Bank again.
      const db = yield* Db
      yield* db.update(parts).set({ key: "C" }).where(eq(parts.questionId, ids.get(1)!)).pipe(Effect.orDie)
      expect((yield* asha.errorLog.list({ query: {} })).total).toBe(1)
      // The Difficulty is read fresh each time, not kept with the summary:
      // a Rated Response's move shows with no Bank write.
      expect((yield* asha.errorLog.list({ query: {} })).entries[0]!.difficulty).toBe(0)
      yield* db.insert(difficulty).values({ questionId: ids.get(1)!, value: 1.25, ratedResponses: 1 }).pipe(Effect.orDie)
      expect((yield* asha.errorLog.list({ query: {} })).entries[0]!.difficulty).toBe(1.25)
    })))

  test("a summary read that overlaps a Bank write and another read keeps nothing old under the new version, and drops nothing", () =>
    runWithWorkers(Effect.gen(function*() {
      const db = yield* Db
      const { ids } = yield* seedBook("Quant Review", numbered(3))
      const [q1, q2, q3] = [ids.get(1)!, ids.get(2)!, ids.get(3)!]
      // What runs between this read's rows and its next step, as the
      // scheduler can run another request between two statements.
      let meanwhile: Effect.Effect<void, never, Db> | undefined
      const read = (wanted: ReadonlyArray<string>) =>
        readSummaries(wanted).pipe(Effect.tap(() => {
          const next = meanwhile
          meanwhile = undefined
          return next ?? Effect.void
        }))
      const reader = makeSummaryReader(read)
      yield* reader([q3])
      // Q1's rows are read, then the Bank changes Q1's key and another read
      // moves to the new version.
      meanwhile = Effect.gen(function*() {
        yield* db.update(parts).set({ key: "A" }).where(eq(parts.questionId, q1)).pipe(Effect.orDie)
        yield* reader([q2]).pipe(Effect.orDie)
      })
      const first = yield* reader([q1, q3])
      expect([...first.keys()].toSorted()).toEqual([q1, q3].toSorted())
      // Nothing is written after that, and the key read now is the Bank's.
      const later = yield* reader([q1, q3])
      expect(later.get(q1)!.parts[0]!.key).toBe("A")
      expect(later.get(q3)!.parts[0]!.key).toBe("C")
    })))

  test("a Sectional counts as Seen what a merge made since it last read the Profile's history, and stays right past the few Profiles kept", () =>
    runWithWorkers(Effect.gen(function*() {
      const curator = yield* openBrowser
      yield* curator.curatorAccess.setPassphrase({ payload: { passphrase: "correct horse battery" } })
      yield* curator.settings.saveBlueprint({ payload: { blueprint: SmallBlueprint } })
      const { quant } = yield* seedExamBank()
      const db = yield* Db
      const unseenProblems = (tab: { readonly sectionals: { options: () => Effect.Effect<{ readonly sections: ReadonlyArray<{ readonly section: { readonly id: string }; readonly groups: ReadonlyArray<{ readonly group: { readonly id: string }; readonly unseen: number }> }> }, unknown> } }) =>
        tab.sectionals.options().pipe(Effect.map((options) =>
          options.sections.find((each) => each.section.id === "quant")!.groups.find((group) => group.group.id === "ps")!.unseen
        ))
      const asha = yield* learner("Asha")
      expect(yield* unseenProblems(asha)).toBe(4)
      // Asha sees one Problem Solving Question, then ends the Sectional.
      const sectional = yield* asha.sectionals.start({ payload: { section: "quant" } })
      const seen = sectional.current!.question.id
      yield* asha.sectionals.finish({ params: { id: sectional.id } })
      expect(yield* unseenProblems(asha)).toBe(3)
      // The Curator merges the one she saw into another: that one is Seen
      // now, and the merged one leaves the Bank.
      const into = [...quant.ids.values()].find((id) => id !== seen)!
      yield* db.update(questions).set({ mergedInto: into, status: "withdrawn" }).where(eq(questions.id, seen)).pipe(Effect.orDie)
      expect(yield* unseenProblems(asha)).toBe(2)
      // Five more Profiles read theirs, past the four kept; Asha's is read
      // again from the start and is still right.
      for (const name of ["Ben", "Cleo", "Dev", "Eli", "Fay"]) expect(yield* unseenProblems(yield* learner(name))).toBe(3)
      expect(yield* unseenProblems(asha)).toBe(2)
    })), 30_000)

  test("a Mistake Type set through the Error Log shows at once, with the facts kept, and an answer after it is read again", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(3))
      const asha = yield* learner("Asha")
      const set: PracticeView = yield* asha.practice.start({ payload: { choice: { kind: "filters", status: "any", size: 2 } } })
      const answered = yield* asha.practice.answer({
        params: { id: set.id },
        payload: { seq: set.nextSeq, questionId: set.current!.question.id, selection: [{ part: 0, choice: "A" }], guessed: false }
      })
      const [entry] = (yield* asha.errorLog.list({ query: {} })).entries
      expect(entry!.parts[0]!.mistakeType?.id).not.toBe("misread")
      yield* asha.errorLog.setMistakeType({
        params: { questionId: entry!.questionId },
        payload: { responseId: entry!.responseId, part: entry!.parts[0]!.part, mistakeType: "misread" }
      })
      const labelled = (yield* asha.errorLog.list({ query: {} })).entries
      expect(labelled.map((each) => each.parts[0]!.mistakeType?.id)).toEqual(["misread"])
      expect((yield* asha.errorLog.list({ query: { mistakeType: "misread" } })).total).toBe(1)
      // Another wrong answer is a write the facts depend on: it shows too.
      const next = yield* asha.practice.next({ params: { id: set.id }, payload: { position: 1 } })
      yield* asha.practice.answer({
        params: { id: set.id },
        payload: { seq: next.nextSeq, questionId: next.current!.question.id, selection: [{ part: 0, choice: "B" }], guessed: false }
      })
      expect(answered.total).toBe(2)
      const both = (yield* asha.errorLog.list({ query: {} })).entries
      expect(both).toHaveLength(2)
      expect(both.find((each) => each.questionId === entry!.questionId)!.parts[0]!.mistakeType?.id).toBe("misread")
    })))
})

