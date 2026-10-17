import { and, eq, gte, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer } from "effect"
import { BlueprintGroups, groupCount, groupOf } from "../../api/blueprint.ts"
import { bandOf } from "../../api/difficulty.ts"
import { CoverageView, CuratorOverview, ReserveGroupView } from "../../api/Overview.ts"
import { Named } from "../../api/Practice.ts"
import { Db } from "../db/Database.ts"
import { difficulty, llmCalls, problemReports, questions, reviewItems } from "../db/schema.ts"
import { JobStore } from "../jobs/JobStore.ts"
import { SiblingsReport } from "../learning/SiblingsReport.ts"
import { currentDifficulty } from "../practice/history.ts"
import { Settings } from "../settings/Settings.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { Bank } from "./Bank.ts"

// The Curator's Overview (docs/design.md, "Analytics"), read from the Bank as
// it stands. The month runs in the app's own time zone, as the Curator has
// no Profile.

export const monthStart = (now: number) => {
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime()
}

export class Overview extends Context.Service<Overview, {
  readonly get: Effect.Effect<CuratorOverview>
}>()("gmat-prep/server/Overview") {
  static readonly layer = Layer.effect(
    Overview,
    Effect.gen(function*() {
      const db = yield* Db
      const taxonomy = (yield* Taxonomy).view
      const settings = yield* Settings
      const bank = yield* Bank
      const siblings = yield* SiblingsReport
      const jobs = yield* JobStore

      const get = Effect.gen(function*() {
        const published = yield* db.select({
          section: questions.section,
          questionType: questions.questionType,
          primarySkill: questions.primarySkill,
          secondarySkills: questions.secondarySkills,
          reserve: questions.reserve,
          releasedAt: questions.releasedAt,
          difficulty: currentDifficulty
        }).from(questions).leftJoin(difficulty, eq(difficulty.questionId, questions.id))
          .where(eq(questions.status, "published")).pipe(Effect.orDie)

        const bands = new Map<string, { easy: number; medium: number; hard: number }>()
        for (const question of published) {
          const band = bandOf(Number(question.difficulty))
          const skills = new Set([
            ...(question.primarySkill === null ? [] : [question.primarySkill]),
            ...(JSON.parse(question.secondarySkills) as ReadonlyArray<string>)
          ])
          for (const skill of skills) {
            const found = bands.get(skill) ?? { easy: 0, medium: 0, hard: 0 }
            found[band] += 1
            bands.set(skill, found)
          }
        }
        const coverage = taxonomy.sections.flatMap((section) =>
          section.topics.flatMap((topic) =>
            topic.skills.map((skill) =>
              new CoverageView({
                skill: new Named({ id: skill.id, name: skill.name }),
                section: new Named({ id: section.id, name: section.name }),
                ...(bands.get(skill.id) ?? { easy: 0, medium: 0, hard: 0 })
              })
            )
          )
        )

        const blueprint = yield* settings.blueprint
        const held = new Map<string, number>()
        for (const question of published) {
          if (question.reserve !== true || question.releasedAt !== null) continue
          const group = groupOf(question.questionType)
          if (group !== undefined) held.set(group.id, (held.get(group.id) ?? 0) + 1)
        }
        const reserve = BlueprintGroups.map((group) => {
          const section = taxonomy.sections.find((each) => each.id === group.section)
          return new ReserveGroupView({
            section: new Named({ id: group.section, name: section?.name ?? group.section }),
            group: new Named({ id: group.id, name: group.name }),
            held: held.get(group.id) ?? 0,
            perMock: groupCount(blueprint, group.id)
          })
        })
        const mocks = Math.min(...reserve.map((group) => Math.floor(group.held / Math.max(1, group.perMock))))

        const [open] = yield* db.select({ count: sql<number>`count(*)` }).from(reviewItems)
          .where(eq(reviewItems.status, "open")).pipe(Effect.orDie)
        // Learners' reports waiting for a decision, and the Questions they are on.
        const [reported] = yield* db.select({
          reports: sql<number>`count(*)`,
          questions: sql<number>`count(distinct ${reviewItems.questionId})`
        }).from(problemReports).innerJoin(reviewItems, eq(reviewItems.id, problemReports.reviewItemId))
          .where(and(eq(reviewItems.status, "open"), eq(reviewItems.kind, "report"))).pipe(Effect.orDie)
        const from = monthStart(yield* Clock.currentTimeMillis)
        const [spent] = yield* db.select({ total: sql<number | null>`sum(${llmCalls.cost})` }).from(llmCalls)
          .where(gte(llmCalls.createdAt, from)).pipe(Effect.orDie)
        return new CuratorOverview({
          coverage,
          reserve,
          mocks,
          siblings: (yield* siblings.report).length,
          thinSkills: (yield* bank.thinSkills).length,
          reviewQueue: Number(open?.count ?? 0),
          problemReports: Number(reported?.reports ?? 0),
          reportedQuestions: Number(reported?.questions ?? 0),
          monthFrom: from,
          spend: Number(spent?.total ?? 0),
          jobs: yield* jobs.changedSince(from)
        })
      })

      return Overview.of({ get })
    })
  )
}
