import { inArray } from "drizzle-orm"
import { Effect } from "effect"
import { Db } from "../db/Database.ts"
import { questions, responses } from "../db/schema.ts"

// Whether any of these Questions, or one merged into one of them at any
// depth, has been answered. A change to their keys then judges past
// Responses again, which a snapshot comes before (decision 118).
export const answered = (questionIds: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const db = yield* Db
    const seen = new Set(questionIds)
    for (let next = [...seen]; next.length > 0;) {
      const merged = yield* db.select({ id: questions.id }).from(questions).where(inArray(questions.mergedInto, next))
      next = merged.map((question) => question.id).filter((id) => !seen.has(id))
      for (const id of next) seen.add(id)
    }
    if (seen.size === 0) return false
    const [found] = yield* db.select({ id: responses.id }).from(responses).where(inArray(responses.questionId, [...seen])).limit(1)
    return found !== undefined
  }).pipe(Effect.orDie)
