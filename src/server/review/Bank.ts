import { and, eq, inArray, isNull } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Semaphore } from "effect"
import { ReserveSection, SkillCount, ThinSkillThreshold, UnknownSection } from "../../api/Bank.ts"
import { bandOf } from "../../api/difficulty.ts"
import { skillsFor } from "../../api/taxonomyRules.ts"
import { Db } from "../db/Database.ts"
import { books, difficulty, questions, stimuli } from "../db/schema.ts"
import { currentDifficulty } from "../practice/history.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { releaseOrder } from "./reserve.ts"

export class Bank extends Context.Service<Bank, {
  readonly thinSkills: Effect.Effect<ReadonlyArray<SkillCount>>
  readonly reserve: Effect.Effect<ReadonlyArray<ReserveSection>>
  release(section: string, count: number): Effect.Effect<ReadonlyArray<ReserveSection>, UnknownSection>
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

      const oneAtATime = (yield* Semaphore.make(1)).withPermits(1)

      const reserve = Effect.gen(function*() {
        const published = yield* db.select({
          section: questions.section,
          reserve: questions.reserve,
          releasedAt: questions.releasedAt
        }).from(questions).where(eq(questions.status, "published"))
        return taxonomy.sections.map((section) => {
          const mine = published.filter((question) => question.section === section.id)
          return new ReserveSection({
            id: section.id,
            name: section.name,
            questions: mine.length,
            held: mine.filter((question) => question.reserve === true && question.releasedAt === null).length,
            released: mine.filter((question) => question.reserve === true && question.releasedAt !== null).length
          })
        })
      }).pipe(Effect.orDie)

      const release = (section: string, count: number) =>
        Effect.gen(function*() {
          if (!taxonomy.sections.some((each) => each.id === section)) return yield* new UnknownSection({ section })
          const held = yield* db.select({
            id: questions.id,
            questionType: questions.questionType,
            hash: questions.normalizedHash,
            difficulty: currentDifficulty,
            stimulusId: questions.stimulusId,
            stimulusHash: stimuli.normalizedHash
          }).from(questions)
            .leftJoin(difficulty, eq(difficulty.questionId, questions.id))
            .leftJoin(stimuli, eq(stimuli.id, questions.stimulusId))
            .where(and(
              eq(questions.section, section),
              eq(questions.status, "published"),
              eq(questions.reserve, true),
              isNull(questions.releasedAt)
            ))
            .pipe(Effect.orDie)
          // A passage's Questions are released together.
          const units = Map.groupBy(held, (question) => question.stimulusId ?? question.id)
          const chosen = releaseOrder(
            [...units].map(([id, members]) => ({
              id,
              size: members.length,
              questionType: members[0]!.questionType,
              band: bandOf(members.reduce((total, member) => total + Number(member.difficulty), 0) / members.length),
              hash: members[0]!.stimulusHash ?? members[0]!.hash
            })),
            count
          ).flatMap((id) => units.get(id)!.map((member) => member.id))
          const now = yield* Clock.currentTimeMillis
          if (chosen.length > 0) {
            yield* db.update(questions).set({ releasedAt: now }).where(inArray(questions.id, chosen))
              .pipe(Effect.orDie)
          }
          return yield* reserve
        }).pipe(oneAtATime)

      return Bank.of({ thinSkills, reserve, release })
    })
  )
}
