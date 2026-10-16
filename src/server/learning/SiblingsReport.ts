import { and, eq, isNotNull, or } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Named } from "../../api/Practice.ts"
import { FewSiblings, SkillSiblings } from "../../api/Siblings.ts"
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
        const skips = yield* db.select({ skill: questions.primarySkill, at: retrySkips.createdAt }).from(retrySkips)
          .innerJoin(questions, eq(questions.id, retrySkips.questionId)).pipe(Effect.orDie)
        const open = yield* db.select({ skill: questions.primarySkill }).from(questions)
          .where(and(
            eq(questions.status, "published"),
            or(eq(questions.reserve, false), isNotNull(questions.releasedAt))
          )).pipe(Effect.orDie)
        const available = new Map<string, number>()
        for (const row of open) if (row.skill !== null) available.set(row.skill, (available.get(row.skill) ?? 0) + 1)
        const skipped = new Map<string, { count: number; last: number }>()
        for (const row of skips) {
          if (row.skill === null) continue
          const found = skipped.get(row.skill) ?? { count: 0, last: 0 }
          skipped.set(row.skill, { count: found.count + 1, last: Math.max(found.last, row.at) })
        }
        return taxonomy.sections.flatMap((section) =>
          section.topics.flatMap((topic) =>
            topic.skills.flatMap((skill) => {
              const skips = skipped.get(skill.id)
              const left = available.get(skill.id) ?? 0
              // A Skill no Question has yet is the Taxonomy's, not a shortage.
              if (skips === undefined && (left === 0 || left > FewSiblings)) return []
              return [
                new SkillSiblings({
                  skill: names.named(skill.id),
                  section: new Named({ id: section.id, name: section.name }),
                  skipped: skips?.count ?? 0,
                  lastSkippedAt: skips?.last ?? null,
                  available: left
                })
              ]
            })
          )
        ).toSorted((a, b) => b.skipped - a.skipped || a.available - b.available || a.skill.name.localeCompare(b.skill.name))
      })

      return SiblingsReport.of({ report })
    })
  )
}
