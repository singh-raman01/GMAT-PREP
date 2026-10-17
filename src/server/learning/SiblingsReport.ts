import { eq, sql } from "drizzle-orm"
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
        const key = (skill: string, questionType: string) => `${skill}|${questionType}`
        const skips = yield* db.select({ skill: questions.primarySkill, questionType: questions.questionType, at: retrySkips.createdAt })
          .from(retrySkips).innerJoin(questions, eq(questions.id, retrySkips.questionId)).pipe(Effect.orDie)
        const published = yield* db.select({
          skill: questions.primarySkill,
          questionType: questions.questionType,
          open: sql<number>`${questions.reserve} = 0 or ${questions.releasedAt} is not null`
        }).from(questions).where(eq(questions.status, "published")).pipe(Effect.orDie)
        const counts = new Map<string, { all: number; open: number }>()
        for (const row of published) {
          if (row.skill === null) continue
          const found = counts.get(key(row.skill, row.questionType)) ?? { all: 0, open: 0 }
          counts.set(key(row.skill, row.questionType), { all: found.all + 1, open: found.open + (row.open ? 1 : 0) })
        }
        const skipped = new Map<string, { count: number; last: number }>()
        for (const row of skips) {
          if (row.skill === null) continue
          const found = skipped.get(key(row.skill, row.questionType)) ?? { count: 0, last: 0 }
          skipped.set(key(row.skill, row.questionType), { count: found.count + 1, last: Math.max(found.last, row.at) })
        }
        return taxonomy.sections.flatMap((section) =>
          section.topics.flatMap((topic) =>
            topic.skills.flatMap((skill) =>
              section.questionTypes.flatMap((questionType) => {
                const skips = skipped.get(key(skill.id, questionType.id))
                const count = counts.get(key(skill.id, questionType.id)) ?? { all: 0, open: 0 }
                // A Skill and type no published Question has is the
                // Taxonomy's, not a shortage; one whose Questions are all in
                // the Reserve has none to give.
                if (skips === undefined && (count.all === 0 || count.open > FewSiblings)) return []
                return [
                  new SkillSiblings({
                    skill: names.named(skill.id),
                    questionType: names.named(questionType.id),
                    section: new Named({ id: section.id, name: section.name }),
                    skipped: skips?.count ?? 0,
                    lastSkippedAt: skips?.last ?? null,
                    available: count.open
                  })
                ]
              })
            )
          )
        ).toSorted((a, b) =>
          b.skipped - a.skipped || a.available - b.available || a.skill.name.localeCompare(b.skill.name) ||
          a.questionType.name.localeCompare(b.questionType.name)
        )
      })

      return SiblingsReport.of({ report })
    })
  )
}
