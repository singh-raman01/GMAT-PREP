import { and, eq, inArray, isNotNull, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Db } from "../db/Database.ts"
import { questions, responses, servedQuestions, sessions } from "../db/schema.ts"
import { mergeTargets } from "../practice/history.ts"

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
  // The order it was recorded in, for servings in the same millisecond.
  readonly order?: number
}

export interface ResponseFact {
  readonly id: string
  readonly sessionId: string
  readonly questionId: string
  readonly kind: string
  // The Session's sequence number, which orders its Responses.
  readonly seq: number
}

// Where each Question was first Seen. Servings in the same millisecond are
// told apart by the order they were recorded in, so the answer never depends
// on the order rows are read in.
export const firstSeenOf = (seen: ReadonlyArray<SeenEvent>): ReadonlyMap<string, SeenEvent> => {
  const before = (a: SeenEvent, b: SeenEvent) =>
    a.at < b.at || (a.at === b.at && (a.order ?? 0) < (b.order ?? 0))
  const firstSeen = new Map<string, SeenEvent>()
  for (const event of seen) {
    const earlier = firstSeen.get(event.questionId)
    if (earlier === undefined || before(event, earlier)) firstSeen.set(event.questionId, event)
  }
  return firstSeen
}

// One Profile's Rated Responses, by id.
export const ratedResponses = (
  seen: ReadonlyArray<SeenEvent>,
  facts: ReadonlyArray<ResponseFact>
): ReadonlySet<string> => {
  const firstSeen = firstSeenOf(seen)
  const final = new Map<string, ResponseFact>()
  for (const fact of facts) {
    const key = `${fact.sessionId}|${fact.questionId}`
    const kept = final.get(key)
    if (kept === undefined || fact.seq > kept.seq) final.set(key, fact)
  }
  const rated = new Set<string>()
  for (const fact of final.values()) {
    const first = firstSeen.get(fact.questionId)
    if (first?.sessionId === fact.sessionId && first.timed && fact.kind !== "time-out") rated.add(fact.id)
  }
  return rated
}

// The Rated Responses among a Profile's Responses to the given Questions. A
// Question the Curator merged into another counts as that one, so it was
// Seen when either was. Only those Questions' history is read.
export const ratedAmong = (profileId: string, questionIds: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    if (questionIds.length === 0) return new Set<string>()
    const db = yield* Db
    const resolve = yield* mergeTargets
    const wanted = new Set(questionIds.map(resolve))
    const merged = yield* db.select({ id: questions.id }).from(questions).where(isNotNull(questions.mergedInto))
    const ids = [...wanted, ...merged.map((row) => row.id).filter((id) => wanted.has(resolve(id)))]
    const served = (yield* db.select({
      questionId: servedQuestions.questionId,
      sessionId: servedQuestions.sessionId,
      timed: sessions.timed,
      at: servedQuestions.servedAt,
      order: sql<number>`${servedQuestions}.rowid`
    }).from(servedQuestions)
      .innerJoin(sessions, eq(sessions.id, servedQuestions.sessionId))
      .where(and(eq(sessions.profileId, profileId), inArray(servedQuestions.questionId, ids))))
      .map((event) => ({ ...event, questionId: resolve(event.questionId) }))
    const facts = (yield* db.select({
      id: responses.id,
      sessionId: responses.sessionId,
      questionId: responses.questionId,
      kind: responses.kind,
      seq: responses.seq
    }).from(responses)
      .where(and(eq(responses.profileId, profileId), inArray(responses.questionId, ids))))
      .map((fact) => ({ ...fact, questionId: resolve(fact.questionId) }))
    return ratedResponses(served, facts)
  })
