import { and, eq, isNotNull } from "drizzle-orm"
import { Effect } from "effect"
import { Db } from "../db/Database.ts"
import { approaches, difficulty, questions, sources } from "../db/schema.ts"
import { currentDifficulty } from "../practice/history.ts"
import type { LessonCandidate } from "./pick.ts"

// The Questions a Lesson may teach from (decision 96): published, outside
// the Mock Reserve (or released from it), carrying the subject as their
// primary Skill or as their Question Type. Read for every subject at once,
// keyed by subject id.
export const lessonCandidates = Effect.gen(function*() {
  const db = yield* Db
  const rows = yield* db.select({
    id: questions.id,
    questionType: questions.questionType,
    primarySkill: questions.primarySkill,
    difficulty: currentDifficulty,
    stimulusId: questions.stimulusId,
    reserve: questions.reserve,
    releasedAt: questions.releasedAt
  }).from(questions)
    .leftJoin(difficulty, eq(difficulty.questionId, questions.id))
    .where(eq(questions.status, "published"))
  const open = rows.filter((row) => row.reserve === false || row.releasedAt !== null)
  const published = eq(questions.status, "published")
  const withApproach = new Set(
    (yield* db.selectDistinct({ questionId: approaches.questionId }).from(approaches)
      .innerJoin(questions, eq(questions.id, approaches.questionId)).where(published)).map((row) => row.questionId)
  )
  const withExplanation = new Set(
    (yield* db.selectDistinct({ questionId: sources.questionId }).from(sources)
      .innerJoin(questions, eq(questions.id, sources.questionId))
      .where(and(published, isNotNull(sources.explanation)))).map((row) => row.questionId)
  )
  const bySubject = new Map<string, Array<LessonCandidate>>()
  const add = (subject: string, candidate: LessonCandidate) => {
    const found = bySubject.get(subject)
    if (found === undefined) bySubject.set(subject, [candidate])
    else found.push(candidate)
  }
  for (const row of open) {
    const candidate: LessonCandidate = {
      id: row.id,
      difficulty: Number(row.difficulty),
      hasApproach: withApproach.has(row.id),
      hasExplanation: withExplanation.has(row.id),
      stimulusId: row.stimulusId
    }
    add(row.questionType, candidate)
    if (row.primarySkill !== null) add(row.primarySkill, candidate)
  }
  return bySubject as ReadonlyMap<string, ReadonlyArray<LessonCandidate>>
}).pipe(Effect.orDie)
