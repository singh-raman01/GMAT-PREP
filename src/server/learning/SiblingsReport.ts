import { eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Named } from "../../api/Practice.ts"
import { FewSiblings, SkillSiblings } from "../../api/Siblings.ts"
import { sectionOf } from "../../api/taxonomyRules.ts"
import { Db } from "../db/Database.ts"
import { questions, retrySkips } from "../db/schema.ts"
import { namesOf } from "../practice/content.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"

// The Curator's view of Skills running out of Siblings (docs/design.md,
// "Learning loop").

export class SiblingsReport extends Context.Service<SiblingsReport, {
  readonly report: Effect.Effect<ReadonlyArray<SkillSiblings>>
}>()("gmat-prep/server/SiblingsReport") {
  static readonly layer = Layer.effect(
    SiblingsReport,
    Effect.gen(function*() {
      const db = yield* Db
      const taxonomy = (yield* Taxonomy).view
      const names = namesOf(taxonomy)

      const report = Effect.gen(function*() {
        const key = (skill: string, questionType: string) => `${skill}|${questionType}`
        const skips = yield* db.select({ skill: questions.primarySkill, questionType: questions.questionType, at: retrySkips.createdAt })
          .from(retrySkips).innerJoin(questions, eq(questions.id, retrySkips.questionId)).pipe(Effect.orDie)
        const published = yield* db.select({
          skill: questions.primarySkill,
          questionType: questions.questionType,
          open: sql<number>`${questions.reserve} = 0 or ${questions.releasedAt} is not null`
        }).from(questions).where(eq(questions.status, "published")).pipe(Effect.orDie)
        // Published Questions outside the Reserve, by Skill and type; a pair
        // whose Questions are all in it counts 0.
        const counts = new Map<string, number>()
        for (const row of published) {
          if (row.skill === null) continue
          counts.set(key(row.skill, row.questionType), (counts.get(key(row.skill, row.questionType)) ?? 0) + (row.open ? 1 : 0))
        }
        const skipped = new Map<string, { count: number; last: number }>()
        for (const row of skips) {
          if (row.skill === null) continue
          const found = skipped.get(key(row.skill, row.questionType)) ?? { count: 0, last: 0 }
          skipped.set(key(row.skill, row.questionType), { count: found.count + 1, last: Math.max(found.last, row.at) })
        }
        // Every Skill and Question Type a published Question or a skip has:
        // a Data Insights type can take a Quant or Verbal Skill. A pair with
        // neither is the Taxonomy's, not a shortage.
        const sectionNamed = (questionType: string) => {
          const section = taxonomy.sections.find((each) => each.id === sectionOf(questionType))
          return new Named({ id: section?.id ?? sectionOf(questionType), name: section?.name ?? sectionOf(questionType) })
        }
        return [...new Set([...counts.keys(), ...skipped.keys()])].flatMap((pair) => {
          const [skill, questionType] = pair.split("|") as [string, string]
          const skips = skipped.get(pair)
          const available = counts.get(pair) ?? 0
          if (skips === undefined && available > FewSiblings) return []
          return [
            new SkillSiblings({
              skill: names.named(skill),
              questionType: names.named(questionType),
              section: sectionNamed(questionType),
              skipped: skips?.count ?? 0,
              lastSkippedAt: skips?.last ?? null,
              available
            })
          ]
        }).toSorted((a, b) =>
          b.skipped - a.skipped || a.available - b.available || a.skill.name.localeCompare(b.skill.name) ||
          a.questionType.name.localeCompare(b.questionType.name)
        )
      })

      return SiblingsReport.of({ report })
    })
  )
}
