import { Effect } from "effect"
import { Db } from "../../src/server/db/Database.ts"
import { difficulty, responses, scoreEstimates, servedQuestions, sessions } from "../../src/server/db/schema.ts"
import { numbered, seedBook } from "./bank.ts"

// A long study history written straight to the database, for the speed
// tests: a Question Bank of three Books, one per Section, and a Profile's
// finished timed Practice Sets over them, one an hour back from `start`.

export const HistoryBooks = 3
export const QuestionsPerBook = 1000

const HourMs = 60 * 60 * 1000

export const seedHistoryBank = Effect.gen(function*() {
  const quant = yield* seedBook("Quant Bank", numbered(QuestionsPerBook, { seed: 0 }))
  const verbal = yield* seedBook(
    "Verbal Bank",
    numbered(QuestionsPerBook, { questionType: "verbal.cr-weaken", primarySkill: "verbal.arguments.causal", seed: 0 })
  )
  const di = yield* seedBook(
    "DI Bank",
    numbered(QuestionsPerBook, {
      questionType: "di.ds",
      primarySkill: "quant.algebra.linear-equations",
      secondarySkills: ["di.sufficiency.value"],
      seed: 0
    })
  )
  return [...quant.ids.values(), ...verbal.ids.values(), ...di.ids.values()]
})

export interface HistoryOptions {
  readonly profileId: string
  // The bank from seedHistoryBank, by Section in that order.
  readonly questionIds: ReadonlyArray<string>
  readonly sessions: number
  readonly perSession: number
  readonly start: number
}

// Each set keeps to one Section, as a filtered set would; Responses vary in
// their answer and time, and each set leaves a Score Estimate.
export const seedHistory = (options: HistoryOptions) =>
  Effect.gen(function*() {
    const db = yield* Db
    const sessionRows: Array<typeof sessions.$inferInsert> = []
    const servedRows: Array<typeof servedQuestions.$inferInsert> = []
    const responseRows: Array<typeof responses.$inferInsert> = []
    const estimateRows: Array<typeof scoreEstimates.$inferInsert> = []
    const labels = ["A", "B", "C", "D", "E"]
    let n = 0
    for (let s = 0; s < options.sessions; s++) {
      const id = crypto.randomUUID()
      const at = options.start - (options.sessions - s) * HourMs
      const section = s % HistoryBooks
      sessionRows.push({
        id,
        profileId: options.profileId,
        kind: "practice",
        timed: true,
        config: "{}",
        status: "finished",
        timeLimitMs: options.perSession * 129_000,
        elapsedMs: options.perSession * 100_000,
        endedBy: "finished",
        createdAt: at,
        finishedAt: at + options.perSession * 100_000
      })
      for (let p = 0; p < options.perSession; p++) {
        const questionId = options.questionIds[
          section * QuestionsPerBook + ((Math.floor(s / HistoryBooks) * options.perSession + p) % QuestionsPerBook)
        ]!
        const spent = 40_000 + ((n * 7919) % 160_000)
        servedRows.push({ sessionId: id, position: p, questionId, servedAt: at + p * 100_000, servedElapsedMs: p * 100_000 })
        responseRows.push({
          id: crypto.randomUUID(),
          profileId: options.profileId,
          sessionId: id,
          questionId,
          seq: p + 1,
          selection: JSON.stringify([{ part: 0, choice: labels[(n * 31) % 5] }]),
          timeSpentMs: spent,
          guessed: false,
          kind: "first",
          supersedes: null,
          createdAt: at + p * 100_000 + spent
        })
        n++
      }
      estimateRows.push({
        id: crypto.randomUUID(),
        profileId: options.profileId,
        section: ["quant", "verbal", "di"][section]!,
        at: at + options.perSession * 100_000,
        ability: Math.sin(s / 50),
        standardError: 0.3,
        score: 75,
        low: 72,
        high: 78,
        calibrated: false,
        ratedResponses: s
      })
    }
    const chunked = <A>(rows: ReadonlyArray<A>, size: number, write: (chunk: Array<A>) => Effect.Effect<unknown, unknown>) =>
      Effect.gen(function*() {
        for (let i = 0; i < rows.length; i += size) yield* write(rows.slice(i, i + size)).pipe(Effect.orDie)
      })
    yield* chunked(sessionRows, 500, (chunk) => db.insert(sessions).values(chunk))
    yield* chunked(servedRows, 1000, (chunk) => db.insert(servedQuestions).values(chunk))
    yield* chunked(responseRows, 1000, (chunk) => db.insert(responses).values(chunk))
    yield* chunked(estimateRows, 1000, (chunk) => db.insert(scoreEstimates).values(chunk))
    yield* chunked(
      options.questionIds.map((questionId, i) => ({ questionId, value: ((i % 7) - 3) / 3, ratedResponses: 1 })),
      1000,
      (chunk) => db.insert(difficulty).values(chunk)
    )
    return { responses: responseRows }
  })
