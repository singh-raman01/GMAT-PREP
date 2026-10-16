import { eq, inArray, sql } from "drizzle-orm"
import { Effect } from "effect"
import { studyDayOf } from "../../api/studyDay.ts"
import { Db } from "../db/Database.ts"
import { difficulty, questions, responses, servedQuestions, sessions } from "../db/schema.ts"
import { currentDifficulty, isCorrect, keysOf, mergeTargets, readSelection } from "../practice/history.ts"
import { type AbilityFit, fitAbility, recencyWeight } from "./model.ts"
import { ratedResponses } from "./rated.ts"

// A Profile's Rated Responses with what the fits need: each Question's
// Section and current Difficulty, and whether the Response is right against
// the current key.

export interface RatedAnswer {
  readonly responseId: string
  readonly questionId: string
  readonly section: string
  readonly difficulty: number
  readonly correct: boolean
  readonly at: number
}

// A Question the Curator merged into another counts as that one.
export const ratedHistory = (profileId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const resolve = yield* mergeTargets
    const served = (yield* db.select({
      questionId: servedQuestions.questionId,
      sessionId: servedQuestions.sessionId,
      timed: sessions.timed,
      at: servedQuestions.servedAt,
      order: sql<number>`${servedQuestions}.rowid`
    }).from(servedQuestions)
      .innerJoin(sessions, eq(sessions.id, servedQuestions.sessionId))
      .where(eq(sessions.profileId, profileId)))
      .map((event) => ({ ...event, questionId: resolve(event.questionId) }))
    const facts = (yield* db.select().from(responses).where(eq(responses.profileId, profileId)))
      .map((fact) => ({ ...fact, questionId: resolve(fact.questionId) }))
    const rated = ratedResponses(served, facts)
    const kept = facts.filter((fact) => rated.has(fact.id))
    if (kept.length === 0) return [] as ReadonlyArray<RatedAnswer>
    const ids = [...new Set(kept.map((fact) => fact.questionId))]
    const rows = yield* db.select({ id: questions.id, section: questions.section, difficulty: currentDifficulty })
      .from(questions)
      .leftJoin(difficulty, eq(difficulty.questionId, questions.id))
      .where(inArray(questions.id, ids))
    const keys = yield* keysOf(ids)
    return kept.flatMap((fact): Array<RatedAnswer> => {
      const question = rows.find((row) => row.id === fact.questionId)
      if (question === undefined) return []
      return [{
        responseId: fact.id,
        questionId: fact.questionId,
        section: question.section,
        difficulty: Number(question.difficulty),
        correct: isCorrect(readSelection(fact.selection), keys.get(fact.questionId) ?? []),
        at: fact.createdAt
      }]
    })
  })

export interface StudyClock {
  readonly now: number
  readonly timeZone: string
  readonly rolloverHour: number
}

// A Section's Ability from its Rated Responses, each weighted by how many
// Study Days ago it was given.
export const sectionFit = (history: ReadonlyArray<RatedAnswer>, section: string, clock: StudyClock): AbilityFit => {
  const today = studyDayOf(clock.now, clock.timeZone, clock.rolloverHour)
  return fitAbility(
    history.filter((answer) => answer.section === section).map((answer) => ({
      difficulty: answer.difficulty,
      correct: answer.correct,
      weight: recencyWeight(today - studyDayOf(answer.at, clock.timeZone, clock.rolloverHour))
    }))
  )
}

// Questions a Profile answered with a Rated Response, per Section.
export const ratedCounts = (history: ReadonlyArray<RatedAnswer>) => {
  const counts = new Map<string, number>()
  for (const answer of history) counts.set(answer.section, (counts.get(answer.section) ?? 0) + 1)
  return counts
}
