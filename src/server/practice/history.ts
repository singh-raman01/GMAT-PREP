import { asc, eq, inArray, isNotNull, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { PartChoice, type Selection } from "../../api/Practice.ts"
import { Db } from "../db/Database.ts"
import { bookmarks, difficulty, parts, questions, responses, servedQuestions, sessions } from "../db/schema.ts"
import type { History, PoolQuestion } from "./selection.ts"

// What Practice Sets read about Questions and about a Profile's history.

// A Question's current Difficulty: as Rated Responses moved it, else its
// seed, else Medium. Needs difficulty left-joined to questions.
export const currentDifficulty = sql<number>`coalesce(${difficulty.value}, ${questions.difficultySeed}, 0)`

// As stored: a time-out's selection is empty.
const StoredSelection = Schema.fromJsonString(Schema.Array(PartChoice))
export const encodeSelection = Schema.encodeSync(StoredSelection)
export const readSelection: (json: string) => Selection = Schema.decodeUnknownSync(StoredSelection)

export interface PartKey {
  readonly position: number
  readonly key: string | null
}

// Right when every Part has a key and the selection gives it; scored against
// the current key, so a Key Override re-scores every past Response.
export const isCorrect = (selection: Selection, keys: ReadonlyArray<PartKey>) =>
  keys.length > 0 &&
  keys.every((part) => part.key !== null && selection.some((each) => each.part === part.position && each.choice === part.key))

export const keysOf = (questionIds: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const keys = new Map<string, Array<PartKey>>()
    if (questionIds.length === 0) return keys
    const db = yield* Db
    const rows = yield* db.select({ questionId: parts.questionId, position: parts.position, key: parts.key }).from(parts)
      .where(inArray(parts.questionId, [...new Set(questionIds)])).orderBy(asc(parts.position))
    for (const row of rows) {
      const mine = keys.get(row.questionId) ?? []
      mine.push({ position: row.position, key: row.key })
      keys.set(row.questionId, mine)
    }
    return keys
  })

// Where a Question's history counts: the Question the Curator merged it
// into, following a merge of that one too, else itself. Served Questions and
// Responses are facts and keep the id they were recorded with.
export const mergeTargets = Effect.gen(function*() {
  const db = yield* Db
  const rows = yield* db.select({ id: questions.id, into: questions.mergedInto }).from(questions)
    .where(isNotNull(questions.mergedInto))
  const into = new Map(rows.map((row) => [row.id, row.into!] as const))
  return (id: string) => {
    let at = id
    for (let hops = 0; hops < 100 && into.has(at); hops++) at = into.get(at)!
    return at
  }
})

// A Question is Seen by a Profile once a Session has served it to them.
export const seenBy = (profileId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const resolve = yield* mergeTargets
    const rows = yield* db.selectDistinct({ questionId: servedQuestions.questionId }).from(servedQuestions)
      .innerJoin(sessions, eq(sessions.id, servedQuestions.sessionId))
      .where(eq(sessions.profileId, profileId))
    return new Set(rows.map((row) => resolve(row.questionId)))
  })

// The Questions a Profile has Bookmarked.
export const bookmarkedBy = (profileId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const rows = yield* db.select({ questionId: bookmarks.questionId }).from(bookmarks)
      .where(eq(bookmarks.profileId, profileId))
    return new Set(rows.map((row) => row.questionId))
  })

// The Profile's history: what it has Seen, Bookmarked, and missed, meaning
// its latest Response is wrong against the current key.
export const historyOf = (profileId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const resolve = yield* mergeTargets
    const seen = yield* seenBy(profileId)
    const answers = yield* db.select({ questionId: responses.questionId, selection: responses.selection }).from(responses)
      .where(eq(responses.profileId, profileId))
      .orderBy(asc(responses.createdAt), asc(sql`${responses}.rowid`))
    const latest = new Map(answers.map((answer) => [resolve(answer.questionId), answer.selection] as const))
    const keys = yield* keysOf([...latest.keys()])
    const missed = new Set(
      [...latest].filter(([questionId, selection]) => !isCorrect(readSelection(selection), keys.get(questionId) ?? []))
        .map(([questionId]) => questionId)
    )
    return { seen, bookmarked: yield* bookmarkedBy(profileId), missed } satisfies History
  })

// Every published Question as Practice Sets choose among them, in the order
// the Bank took them in.
export const publishedPool = Effect.gen(function*() {
  const db = yield* Db
  const rows = yield* db.select({
    id: questions.id,
    section: questions.section,
    questionType: questions.questionType,
    primarySkill: questions.primarySkill,
    secondarySkills: questions.secondarySkills,
    difficulty: currentDifficulty,
    reserve: questions.reserve,
    releasedAt: questions.releasedAt,
    stimulusId: questions.stimulusId
  }).from(questions)
    .leftJoin(difficulty, eq(difficulty.questionId, questions.id))
    .where(eq(questions.status, "published"))
    .orderBy(asc(questions.createdAt), asc(sql`${questions}.rowid`))
  return rows.map((row): PoolQuestion => ({
    id: row.id,
    section: row.section,
    questionType: row.questionType,
    primarySkill: row.primarySkill,
    secondarySkills: JSON.parse(row.secondarySkills) as ReadonlyArray<string>,
    difficulty: Number(row.difficulty),
    reserve: row.reserve,
    released: row.releasedAt !== null,
    stimulusId: row.stimulusId
  }))
})

// One Question's current Difficulty.
export const difficultyOf = (questionId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const [row] = yield* db.select({ value: currentDifficulty }).from(questions)
      .leftJoin(difficulty, eq(difficulty.questionId, questions.id))
      .where(eq(questions.id, questionId))
    return row === undefined ? undefined : Number(row.value)
  })
