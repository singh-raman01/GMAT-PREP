import { and, eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { Db } from "../db/Database.ts"
import { responses, servedQuestions, sessions } from "../db/schema.ts"

// Rated Responses: a Profile's final Response to a Question in the Session
// where the Question was first Seen, when that Session was timed and the
// Response is not a time-out. Only these move Difficulty and Ability, so
// untimed practice never does. A Question first Seen through a Paper Mark or
// a Lesson is never Rated. Nothing stores the flag: it is derived from
// Responses and can be rebuilt (ADR 0005).

export interface SeenEvent {
  readonly questionId: string
  // The Session that served it; null for a Paper Mark or a Lesson.
  readonly sessionId: string | null
  readonly timed: boolean
  readonly at: number
}

export interface ResponseFact {
  readonly id: string
  readonly sessionId: string
  readonly questionId: string
  readonly kind: string
  // The Session's sequence number, which orders its Responses.
  readonly seq: number
}

// One Profile's Rated Responses, by id.
export const ratedResponses = (
  seen: ReadonlyArray<SeenEvent>,
  facts: ReadonlyArray<ResponseFact>
): ReadonlySet<string> => {
  const firstSeen = new Map<string, SeenEvent>()
  for (const event of seen) {
    const earlier = firstSeen.get(event.questionId)
    if (earlier === undefined || event.at < earlier.at) firstSeen.set(event.questionId, event)
  }
  const final = new Map<string, ResponseFact>()
  for (const fact of facts) {
    const key = `${fact.sessionId}|${fact.questionId}`
    const before = final.get(key)
    if (before === undefined || fact.seq > before.seq) final.set(key, fact)
  }
  const rated = new Set<string>()
  for (const fact of final.values()) {
    const first = firstSeen.get(fact.questionId)
    if (first?.sessionId === fact.sessionId && first.timed && fact.kind !== "time-out") rated.add(fact.id)
  }
  return rated
}

// The Rated Responses among a Profile's Responses to the given Questions.
export const ratedAmong = (profileId: string, questionIds: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    if (questionIds.length === 0) return new Set<string>()
    const db = yield* Db
    const served = yield* db.select({
      questionId: servedQuestions.questionId,
      sessionId: servedQuestions.sessionId,
      timed: sessions.timed,
      at: servedQuestions.servedAt
    }).from(servedQuestions)
      .innerJoin(sessions, eq(sessions.id, servedQuestions.sessionId))
      .where(and(eq(sessions.profileId, profileId), inArray(servedQuestions.questionId, [...questionIds])))
    const facts = yield* db.select({
      id: responses.id,
      sessionId: responses.sessionId,
      questionId: responses.questionId,
      kind: responses.kind,
      seq: responses.seq
    }).from(responses)
      .where(and(eq(responses.profileId, profileId), inArray(responses.questionId, [...questionIds])))
    return ratedResponses(served, facts)
  })
