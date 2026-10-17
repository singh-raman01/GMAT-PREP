import { and, asc, eq, gte, inArray, isNotNull, max, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { PartChoice, type Selection } from "../../api/Practice.ts"
import { Db } from "../db/Database.ts"
import { bookmarks, books, difficulty, parts, questions, responses, servedQuestions, sessions, sources } from "../db/schema.ts"
import { chosenQuestions, decodeConfig, SectionKinds } from "../sections/config.ts"
import { marksAndPages, paperSeenOf } from "./paperSeen.ts"
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
export const isCorrect = (selection: Selection, keys: ReadonlyArray<PartKey>) => {
  if (keys.length === 0) return false
  for (const part of keys) {
    if (part.key === null) return false
    let picked = false
    for (const each of selection) {
      if (each.part === part.position && each.choice === part.key) {
        picked = true
        break
      }
    }
    if (!picked) return false
  }
  return true
}

// Each Question's Part keys. A merged Question has the keys of the one it
// became, so every count of right answers judges it as the Error Log does.
export const keysOf = (questionIds: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const keys = new Map<string, Array<PartKey>>()
    if (questionIds.length === 0) return keys
    const db = yield* Db
    const resolve = yield* mergeTargets
    const wanted = [...new Set(questionIds)]
    const rows = yield* db.select({ questionId: parts.questionId, position: parts.position, key: parts.key }).from(parts)
      .where(inArray(parts.questionId, [...new Set(wanted.map(resolve))])).orderBy(asc(parts.position))
    const byQuestion = new Map<string, Array<PartKey>>()
    for (const row of rows) {
      const mine = byQuestion.get(row.questionId) ?? []
      mine.push({ position: row.position, key: row.key })
      byQuestion.set(row.questionId, mine)
    }
    for (const id of wanted) {
      const found = byQuestion.get(resolve(id))
      if (found !== undefined) keys.set(id, found)
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

// When the Profile's Paper Marks made each Question Seen, by the Question
// it counts as.
export const paperSeenBy = (profileId: string, which: "first" | "last" = "first") =>
  Effect.gen(function*() {
    const { marks, pages } = yield* marksAndPages(profileId)
    if (marks.length === 0) return new Map<string, number>() as ReadonlyMap<string, number>
    return paperSeenOf(marks, pages, yield* mergeTargets, which)
  })

// A Question is Seen by a Profile once a Session has served it to them, or a
// Paper Mark covers it.
export const seenBy = (profileId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const resolve = yield* mergeTargets
    const rows = yield* db.selectDistinct({ questionId: servedQuestions.questionId }).from(servedQuestions)
      .innerJoin(sessions, eq(sessions.id, servedQuestions.sessionId))
      .where(eq(sessions.profileId, profileId))
    return new Set([...rows.map((row) => resolve(row.questionId)), ...(yield* paperSeenBy(profileId)).keys()])
  })

// The Questions of every unit the Profile's running Sectionals chose, served
// yet or not, by the Question each counts as, and those of a running Mock's
// Sections, closed ones too. Practice leaves them out until the Sectional or
// Mock ends, so no Practice Set can show their keys or say how an answer
// went before its report does.
export const heldBySections = (profileId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const mine = and(eq(sessions.profileId, profileId), inArray(sessions.kind, SectionKinds))
    const running = yield* db.select({ config: sessions.config }).from(sessions)
      .where(and(mine, eq(sessions.status, "active")))
    const mocks = yield* db.select({ id: sessions.id, createdAt: sessions.createdAt }).from(sessions)
      .where(and(eq(sessions.profileId, profileId), eq(sessions.kind, "mock"), eq(sessions.status, "active")))
    // A Mock's Sections start after it does.
    const closed = mocks.length === 0 ? [] : yield* db.select({ config: sessions.config }).from(sessions)
      .where(and(
        eq(sessions.profileId, profileId),
        eq(sessions.kind, "mock-section"),
        eq(sessions.status, "finished"),
        gte(sessions.createdAt, Math.min(...mocks.map((mock) => mock.createdAt)))
      ))
    const configs = [
      ...running.map((session) => decodeConfig(session.config)),
      ...closed.map((session) => decodeConfig(session.config))
        .filter((config) => config.mock !== undefined && mocks.some((mock) => mock.id === config.mock!.id))
    ]
    if (configs.length === 0) return new Set<string>()
    const resolve = yield* mergeTargets
    return new Set(configs.flatMap((config) => chosenQuestions(config).map(resolve)))
  })

// When a Profile last saw each Question it has Seen, a merged Question's
// servings counting for the one it became. A Paper Mark counts as a sighting
// at the time it was made, the latest of those that cover the Question.
export const lastSeenBy = (profileId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const resolve = yield* mergeTargets
    const rows = yield* db.select({ questionId: servedQuestions.questionId, at: max(servedQuestions.servedAt) })
      .from(servedQuestions)
      .innerJoin(sessions, eq(sessions.id, servedQuestions.sessionId))
      .where(eq(sessions.profileId, profileId))
      .groupBy(servedQuestions.questionId)
    const last = new Map<string, number>()
    for (const row of rows) {
      const id = resolve(row.questionId)
      last.set(id, Math.max(last.get(id) ?? 0, Number(row.at ?? 0)))
    }
    for (const [id, at] of yield* paperSeenBy(profileId, "last")) last.set(id, Math.max(last.get(id) ?? 0, at))
    return last
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
// its own Book prints it: by Book, as the Bank took them in, then page and
// number. So a passage's Questions keep the Book's order, even when a Book
// Map fix brought in an earlier page later.
export const publishedPool = Effect.gen(function*() {
  const db = yield* Db
  const found = yield* db.select({
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
    .leftJoin(sources, and(eq(sources.questionId, questions.id), eq(sources.merged, false)))
    .leftJoin(books, eq(books.id, sources.bookId))
    .where(eq(questions.status, "published"))
    .orderBy(
      asc(books.createdAt),
      asc(sources.page),
      asc(sources.number),
      asc(questions.createdAt),
      asc(sql`${questions}.rowid`)
    )
  // One row each, should a Question have two Sources of its own.
  const rows = [...new Map(found.map((row) => [row.id, row] as const)).values()]
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
