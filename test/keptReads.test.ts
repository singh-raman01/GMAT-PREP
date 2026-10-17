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
import { numbered, seedBook } from "./fixtures/bank.ts"
import { runWithWorkers } from "./harness.ts"

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
})
