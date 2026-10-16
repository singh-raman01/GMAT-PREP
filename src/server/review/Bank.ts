import { eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { SkillCount, ThinSkillThreshold } from "../../api/Bank.ts"
import { skillsFor } from "../../api/taxonomyRules.ts"
import { Db } from "../db/Database.ts"
import { books, questions } from "../db/schema.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"

export class Bank extends Context.Service<Bank, {
  readonly thinSkills: Effect.Effect<ReadonlyArray<SkillCount>>
}>()("gmat-prep/server/Bank") {
  static readonly layer = Layer.effect(
    Bank,
    Effect.gen(function*() {
      const db = yield* Db
      const taxonomy = (yield* Taxonomy).view

      // Only Skills that fit a Question Type the Bank holds are counted, so a
      // Section no Book has covered yet is not flagged wholesale.
      const thinSkills = Effect.gen(function*() {
        const [extracted] = yield* db.select({ id: books.id }).from(books).where(eq(books.status, "extracted")).limit(1)
        if (extracted === undefined) return []
        const published = yield* db.select({
          questionType: questions.questionType,
          primarySkill: questions.primarySkill,
          secondarySkills: questions.secondarySkills
        }).from(questions).where(eq(questions.status, "published"))
        const counts = new Map<string, number>()
        for (const question of published) {
          const tagged = new Set([
            ...(question.primarySkill === null ? [] : [question.primarySkill]),
            ...(JSON.parse(question.secondarySkills) as ReadonlyArray<string>)
          ])
          for (const skill of tagged) counts.set(skill, (counts.get(skill) ?? 0) + 1)
        }
        const types = new Set(published.map((question) => question.questionType))
        const fitting = new Map([...types].flatMap((type) => skillsFor(taxonomy, type)).map((skill) => [skill.id, skill]))
        return [...fitting.values()]
          .map((skill) => new SkillCount({ id: skill.id, name: skill.name, questions: counts.get(skill.id) ?? 0 }))
          .filter((skill) => skill.questions < ThinSkillThreshold)
          .toSorted((a, b) => a.questions - b.questions || a.name.localeCompare(b.name))
      }).pipe(Effect.orDie)

      return Bank.of({ thinSkills })
    })
  )
}
