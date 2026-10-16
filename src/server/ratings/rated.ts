import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Db } from "../db/Database.ts"
import { mergeTargets } from "../practice/history.ts"
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
  // Two Sessions that served a Question at the same moment are told apart by
  // id, so the answer never depends on the order rows are read in.
  const before = (a: SeenEvent, b: SeenEvent) =>
    a.at < b.at || (a.at === b.at && (a.sessionId ?? "") < (b.sessionId ?? ""))
  const firstSeen = new Map<string, SeenEvent>()
  for (const event of seen) {
    const earlier = firstSeen.get(event.questionId)
    if (earlier === undefined || before(event, earlier)) firstSeen.set(event.questionId, event)
  }
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
// Seen when either was.
export const ratedAmong = (profileId: string, questionIds: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    if (questionIds.length === 0) return new Set<string>()
    const db = yield* Db
    const resolve = yield* mergeTargets
    const wanted = new Set(questionIds.map(resolve))
    const served = (yield* db.select({
      questionId: servedQuestions.questionId,
      sessionId: servedQuestions.sessionId,
      timed: sessions.timed,
      at: servedQuestions.servedAt
    }).from(servedQuestions)
      .innerJoin(sessions, eq(sessions.id, servedQuestions.sessionId))
      .where(eq(sessions.profileId, profileId)))
      .map((event) => ({ ...event, questionId: resolve(event.questionId) }))
      .filter((event) => wanted.has(event.questionId))
    const facts = (yield* db.select({
      id: responses.id,
      sessionId: responses.sessionId,
      questionId: responses.questionId,
      kind: responses.kind,
      seq: responses.seq
    }).from(responses)
      .where(eq(responses.profileId, profileId)))
      .map((fact) => ({ ...fact, questionId: resolve(fact.questionId) }))
      .filter((fact) => wanted.has(fact.questionId))
    return ratedResponses(served, facts)
  })
