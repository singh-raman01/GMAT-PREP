import { and, eq, inArray, sql } from "drizzle-orm"
import { Effect } from "effect"
import { studyDayOf } from "../../api/studyDay.ts"
import { Db } from "../db/Database.ts"
import { difficulty, questions, responses, servedQuestions, sessions } from "../db/schema.ts"
import { currentDifficulty, isCorrect, keysOf, mergeTargets, paperSeenBy, readSelection } from "../practice/history.ts"
import { type AbilityFit, fitAbility, recencyWeight } from "./model.ts"
import { firstSeenOf, paperEvents, ratedResponses, type SeenEvent } from "./rated.ts"

// A Profile's Rated Responses with what the fits need: each Question's
// Section and current Difficulty, and whether the Response is right against
// the current key.

export interface RatedAnswer {
  readonly responseId: string
  // The timed set it was given in, its place there, and whether that set has
  // ended: a set's answers count toward Ability only once it ends, so a
  // Score Estimate never gives away a result before the set shows it.
  readonly sessionId: string
  readonly seq: number
  readonly ended: boolean
  readonly questionId: string
  readonly section: string
  readonly difficulty: number
  readonly correct: boolean
  readonly at: number
  // The first Response's time in its set: an answer changed in Review &
  // Edit took none of its own.
  readonly timeSpentMs: number
}

// A Question the Curator merged into another counts as that one. A Withdrawn
// Question's Responses stay in history but leave Ability.
export const ratedHistory = (profileId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const resolve = yield* mergeTargets
    // Each Question's first serving to the Profile is all that decides where
    // it was first Seen; a merged Question's group takes the earliest of its
    // members' first servings.
    const ranked = db.select({
      questionId: servedQuestions.questionId,
      sessionId: servedQuestions.sessionId,
      timed: sessions.timed,
      at: servedQuestions.servedAt,
      order: sql<number>`${servedQuestions}.rowid`.as("served_order"),
      rank: sql<number>`row_number() over (partition by ${servedQuestions.questionId} order by ${servedQuestions.servedAt}, ${servedQuestions}.rowid)`
        .as("served_rank")
    }).from(servedQuestions)
      .innerJoin(sessions, eq(sessions.id, servedQuestions.sessionId))
      .where(eq(sessions.profileId, profileId))
      .as("ranked")
    const served = (yield* db.select({
      questionId: ranked.questionId,
      sessionId: ranked.sessionId,
      timed: ranked.timed,
      at: ranked.at,
      order: ranked.order
    }).from(ranked).where(eq(ranked.rank, 1)))
      .map((event): SeenEvent => ({ ...event, questionId: resolve(event.questionId) }))
      .concat(paperEvents(yield* paperSeenBy(profileId)))
    // Only Responses in a timed set where their Question was first Seen can
    // be Rated, so only those sets' Responses are read.
    const firstSets = [...new Set([...firstSeenOf(served).values()].filter((event) => event.timed).map((event) => event.sessionId))]
      .filter((id): id is string => id !== null)
    if (firstSets.length === 0) return [] as ReadonlyArray<RatedAnswer>
    const facts = yield* db.select({
      id: responses.id,
      sessionId: responses.sessionId,
      questionId: responses.questionId,
      kind: responses.kind,
      seq: responses.seq,
      selection: responses.selection,
      timeSpentMs: responses.timeSpentMs,
      createdAt: responses.createdAt,
      ended: sql<number>`${sessions.status} = 'finished'`,
      // A Mock's Section counts as ended once the Mock is over, so the Score
      // Estimates say nothing of a closed Section while the Mock runs.
      mockId: sql<string | null>`json_extract(${sessions.config}, '$.mock.id')`
    }).from(responses)
      .innerJoin(sessions, eq(sessions.id, responses.sessionId))
      // The sets are the Profile's own, and found by their index.
      .where(inArray(responses.sessionId, firstSets))
    const mockIds = [...new Set(facts.flatMap((fact) => (fact.mockId === null ? [] : [fact.mockId])))]
    const mocksOver = new Set(
      mockIds.length === 0 ? [] : (yield* db.select({ id: sessions.id }).from(sessions)
        .where(and(inArray(sessions.id, mockIds), eq(sessions.status, "finished")))).map((row) => row.id)
    )
    const counted = facts.map((fact) => ({
      ...fact,
      questionId: resolve(fact.questionId),
      ended: Boolean(fact.ended) && (fact.mockId === null || mocksOver.has(fact.mockId))
    }))
    const rated = ratedResponses(served, counted)
    const kept = counted.filter((fact) => rated.has(fact.id))
    const firstTime = new Map<string, { seq: number; timeSpentMs: number }>()
    for (const fact of counted) {
      const key = `${fact.sessionId}|${fact.questionId}`
      const found = firstTime.get(key)
      if (found === undefined || fact.seq < found.seq) firstTime.set(key, { seq: fact.seq, timeSpentMs: fact.timeSpentMs })
    }
    if (kept.length === 0) return [] as ReadonlyArray<RatedAnswer>
    const ids = [...new Set(kept.map((fact) => fact.questionId))]
    const rows = yield* db.select({
      id: questions.id,
      section: questions.section,
      status: questions.status,
      difficulty: currentDifficulty
    }).from(questions)
      .leftJoin(difficulty, eq(difficulty.questionId, questions.id))
      .where(inArray(questions.id, ids))
    const byId = new Map(rows.map((row) => [row.id, row] as const))
    const keys = yield* keysOf(ids)
    return kept.flatMap((fact): Array<RatedAnswer> => {
      const question = byId.get(fact.questionId)
      if (question === undefined || question.status === "withdrawn") return []
      return [{
        responseId: fact.id,
        sessionId: fact.sessionId,
        seq: fact.seq,
        ended: fact.ended,
        questionId: fact.questionId,
        section: question.section,
        difficulty: Number(question.difficulty),
        correct: isCorrect(readSelection(fact.selection), keys.get(fact.questionId) ?? []),
        at: fact.createdAt,
        timeSpentMs: firstTime.get(`${fact.sessionId}|${fact.questionId}`)?.timeSpentMs ?? fact.timeSpentMs
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
