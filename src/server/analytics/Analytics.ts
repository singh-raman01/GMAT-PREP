import { and, eq, inArray, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import {
  MistakeTrendView,
  PacingPointView,
  ScopeView,
  SkillMapView,
  StudyView,
  TimingView,
  WeakAreasView,
  WeakAreaView
} from "../../api/Analytics.ts"
import { joinedKey } from "../../api/keys.ts"
import { Named, SessionId } from "../../api/Practice.ts"
import { SectionMinutes } from "../../api/Sectionals.ts"
import { studyDayOf } from "../../api/studyDay.ts"
import { targetSecondsFor } from "../../api/targetTimes.ts"
import { sectionOf } from "../../api/taxonomyRules.ts"
import { Db } from "../db/Database.ts"
import { approaches, books, questions, servedQuestions, sessions, sources } from "../db/schema.ts"
import { ErrorLog, type LearningHistory } from "../learning/ErrorLog.ts"
import { inChunks, questionSummaries } from "../learning/facts.ts"
import { namesOf } from "../practice/content.ts"
import { isCorrect } from "../practice/history.ts"
import { ratedHistory, sectionFit } from "../ratings/history.ts"
import { recencyWeight } from "../ratings/model.ts"
import { studyClockOf } from "../ratings/rateSession.ts"
import { Settings } from "../settings/Settings.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { type RatedFact, type ScopeAbility, scopeAbilities, scopeKey } from "./abilities.ts"
import { answeredOf } from "./answers.ts"
import { frequenciesOf } from "./frequency.ts"
import { endingOf, mistakeWeeksOf, pacesOf, pacingOf, studyDaysOf, type TimedAnswer } from "./views.ts"
import { mixesOf, weakAreasOf } from "./weakAreas.ts"

// The Learner's analytics (docs/design.md, "Analytics"), worked out on read
// from the Profile's own facts.

const DayMs = 24 * 60 * 60 * 1000
const dayText = (day: number) => new Date(day * DayMs).toISOString().slice(0, 10)
const LimitMs = SectionMinutes * 60 * 1000
// The Mistakes view looks back this many Study Weeks.
const MistakeWeeks = 12
// A Weak Area's remedy serves this many Questions.
const RemedySize = 10

export class Analytics extends Context.Service<Analytics, {
  weakAreas(profileId: string): Effect.Effect<WeakAreasView>
  skillMap(profileId: string): Effect.Effect<SkillMapView>
  timing(profileId: string): Effect.Effect<TimingView>
  mistakes(profileId: string): Effect.Effect<MistakeTrendView>
  study(profileId: string): Effect.Effect<StudyView>
}>()("gmat-prep/server/Analytics") {
  static readonly layer = Layer.effect(
    Analytics,
    Effect.gen(function*() {
      const db = yield* Db
      const errorLog = yield* ErrorLog
      const settings = yield* Settings
      const taxonomy = (yield* Taxonomy).view
      const names = namesOf(taxonomy)
      const run = <A, E>(effect: Effect.Effect<A, E, Db>) => effect.pipe(Effect.provideService(Db, db), Effect.orDie)
      const named = (id: string) => names.named(id)
      const kindName = (id: string) =>
        id === "slow" ? new Named({ id, name: "Slow" }) : id === "guessed" ? new Named({ id, name: "Guessed" }) : named(id)

      // Skill and Question Type Abilities from the Rated Responses of the
      // Sessions that have ended, as Score Estimates count them.
      const abilitiesFor = (profileId: string) =>
        Effect.gen(function*() {
          const clock = yield* run(studyClockOf(profileId))
          const history = clock === undefined ? [] : (yield* run(ratedHistory(profileId))).filter((answer) => answer.ended)
          if (clock === undefined || history.length === 0) {
            return { abilities: [] as ReadonlyArray<ScopeAbility>, sectionAbility: new Map<string, number>(), rated: 0 }
          }
          const summaries = yield* run(questionSummaries(history.map((answer) => answer.questionId)))
          const overrides = yield* settings.targetTimes
          const dayOf = (at: number) => studyDayOf(at, clock.timeZone, clock.rolloverHour)
          const today = dayOf(clock.now)
          const sectionAbility = new Map(
            [...new Set(history.map((answer) => answer.section))].map((section) => [section, sectionFit(history, section, clock).ability] as const)
          )
          const facts = history.flatMap((answer): Array<RatedFact> => {
            const question = summaries.get(answer.questionId)
            if (question === undefined) return []
            const targetMs = targetSecondsFor(question.questionType, overrides) * 1000
            return [{
              section: answer.section,
              questionType: question.questionType,
              primarySkill: question.primarySkill,
              secondarySkills: question.secondarySkills,
              difficulty: answer.difficulty,
              correct: answer.correct,
              recency: recencyWeight(today - dayOf(answer.at)),
              pace: targetMs > 0 ? answer.timeSpentMs / targetMs : 1
            }]
          })
          return { abilities: scopeAbilities(facts, sectionAbility), sectionAbility, rated: facts.length }
        })

      const scopeView = (ability: ScopeAbility) =>
        new ScopeView({
          kind: ability.kind,
          scope: named(ability.id),
          section: named(ability.sections[0] ?? sectionOf(ability.id)),
          evidence: ability.evidence,
          enough: ability.enough,
          ability: ability.fit.ability,
          standardError: ability.fit.standardError,
          reference: ability.reference,
          gap: ability.gap,
          pace: ability.pace,
          slow: ability.slow
        })

      // Every published Question, with whether a Book marked official is
      // among its Sources.
      const bank = db.select({
        questionType: questions.questionType,
        primarySkill: questions.primarySkill,
        secondarySkills: questions.secondarySkills,
        official: sql<number>`max(coalesce(${books.official}, 0))`
      }).from(questions)
        .leftJoin(sources, and(eq(sources.questionId, questions.id), eq(sources.merged, false)))
        .leftJoin(books, eq(books.id, sources.bookId))
        .where(eq(questions.status, "published"))
        .groupBy(questions.id)
        .pipe(
          Effect.orDie,
          Effect.map((rows) =>
            rows.map((row) => ({
              official: Boolean(row.official),
              questionType: row.questionType,
              primarySkill: row.primarySkill,
              secondarySkills: JSON.parse(row.secondarySkills) as ReadonlyArray<string>
            }))
          )
        )

      const weakAreas = (profileId: string) =>
        Effect.gen(function*() {
          const { abilities, rated } = yield* abilitiesFor(profileId)
          const frequencies = frequenciesOf(yield* bank)
          const history = yield* errorLog.history(profileId)
          const mixes = mixesOf(history.misses.flatMap(({ miss, mistakeTypes }) => {
            const question = history.summaries.get(miss.questionId)
            if (question === undefined) return []
            return [{
              questionType: question.questionType,
              primarySkill: question.primarySkill,
              secondarySkills: question.secondarySkills,
              kinds: [
                ...mistakeTypes.filter((kind): kind is string => kind !== null),
                ...miss.reasons.filter((reason) => reason !== "wrong")
              ]
            }]
          }))
          return new WeakAreasView({
            areas: weakAreasOf(abilities, frequencies, mixes).map((area) =>
              new WeakAreaView({
                ability: scopeView(area.ability),
                frequency: area.frequency,
                priority: area.priority,
                mix: [...area.mix].toSorted((a, b) => b[1] - a[1]).map(([kind, count]) => ({ kind: kindName(kind), count })),
                remedy: {
                  timed: area.remedy.timed,
                  choice: {
                    kind: "filters",
                    status: "any",
                    size: RemedySize,
                    ...(area.remedy.timed ? { timed: true } : {}),
                    ...(area.kind === "skill" ? { skill: area.id } : { questionType: area.id })
                  }
                }
              })
            ),
            frequencyBasis: frequencies.basis,
            ratedResponses: rated,
            thin: abilities.filter((ability) => !ability.enough).length
          })
        })

      const skillMap = (profileId: string) =>
        Effect.gen(function*() {
          const { abilities, sectionAbility } = yield* abilitiesFor(profileId)
          const byKey = new Map(abilities.map((ability) => [scopeKey(ability.kind, ability.id), ability] as const))
          const viewOf = (kind: "skill" | "questionType", id: string) => {
            const found = byKey.get(scopeKey(kind, id))
            return found === undefined ? null : scopeView(found)
          }
          return new SkillMapView({
            sections: taxonomy.sections.map((section) => ({
              section: new Named({ id: section.id, name: section.name }),
              ability: sectionAbility.get(section.id) ?? null,
              topics: section.topics.map((topic) => ({
                topic: new Named({ id: topic.id, name: topic.name }),
                skills: topic.skills.map((skill) => ({ skill: new Named({ id: skill.id, name: skill.name }), scope: viewOf("skill", skill.id) }))
              })),
              questionTypes: section.questionTypes.map((type) => ({
                questionType: new Named({ id: type.id, name: type.name }),
                scope: viewOf("questionType", type.id)
              }))
            }))
          })
        })

      // Each answered Question of the Sessions that show how they went, and
      // whether its final answer is right against the current key.
      const shownAnswers = (history: LearningHistory) =>
        answeredOf(history.responses, history.resolve).flatMap((answered) => {
          const session = history.sessions.get(answered.sessionId)
          const question = history.summaries.get(answered.questionId)
          if (session === undefined || question === undefined) return []
          return [{
            ...answered,
            session,
            question,
            correct: session.shown ? answered.final.kind !== "time-out" && isCorrect(answered.final.selection, question.parts) : null
          }]
        })

      const timing = (profileId: string) =>
        Effect.gen(function*() {
          const history = yield* errorLog.history(profileId)
          const timed = shownAnswers(history).filter((answer) => answer.session.shown && answer.session.limitMs !== null)
          const served = timed.length === 0 ? [] : yield* run(
            db.select({
              sessionId: servedQuestions.sessionId,
              questionId: servedQuestions.questionId,
              position: servedQuestions.position,
              servedElapsedMs: servedQuestions.servedElapsedMs
            }).from(servedQuestions).innerJoin(sessions, eq(sessions.id, servedQuestions.sessionId))
              .where(and(eq(sessions.profileId, profileId), eq(sessions.timed, true)))
          )
          const servedAt = new Map(served.map((row) => [`${row.sessionId}|${row.questionId}`, row] as const))
          const servedCount = new Map<string, number>()
          for (const row of served) servedCount.set(row.sessionId, (servedCount.get(row.sessionId) ?? 0) + 1)
          // The Strategy of each Question's fastest Approach that reaches its key.
          const ids = [...new Set(timed.map((answer) => answer.questionId))]
          const routes = yield* run(inChunks(ids, (chunk) =>
            db.select({ questionId: approaches.questionId, strategy: approaches.strategy, seconds: approaches.expectedSeconds, answer: approaches.answer })
              .from(approaches).where(inArray(approaches.questionId, chunk))
          ))
          const fastest = new Map<string, { strategy: string; seconds: number }>()
          for (const route of routes) {
            const question = history.summaries.get(route.questionId)
            const key = question === undefined ? null : joinedKey(question.parts.map((part) => part.key))
            if (key === null || route.answer !== key) continue
            const found = fastest.get(route.questionId)
            if (found === undefined || route.seconds < found.seconds) fastest.set(route.questionId, { strategy: route.strategy, seconds: route.seconds })
          }
          const answers = timed.map((answer): TimedAnswer => {
            const row = servedAt.get(`${answer.sessionId}|${answer.servedId}`)
            return {
              sessionId: answer.sessionId,
              kind: answer.session.kind,
              position: row?.position ?? 0,
              questionType: answer.question.questionType,
              correct: answer.correct === true,
              timedOut: answer.first.kind === "time-out",
              timeSpentMs: answer.first.timeSpentMs,
              targetMs: history.targetMs(answer.questionId),
              servedElapsedMs: row?.servedElapsedMs ?? null,
              strategy: fastest.get(answer.questionId)?.strategy ?? null
            }
          })
          const paces = pacesOf(answers)
          // Finished Mocks and their Sections, in place order.
          const mockRows = yield* run(
            db.select({ id: sessions.id, finishedAt: sessions.finishedAt }).from(sessions)
              .where(and(eq(sessions.profileId, profileId), eq(sessions.kind, "mock"), eq(sessions.status, "finished")))
          )
          const sectionRows = mockRows.length === 0 ? [] : yield* run(
            db.select({
              id: sessions.id,
              section: sql<string>`json_extract(${sessions.config}, '$.section')`,
              mockId: sql<string>`json_extract(${sessions.config}, '$.mock.id')`,
              place: sql<number>`json_extract(${sessions.config}, '$.mock.place')`
            }).from(sessions).where(and(eq(sessions.profileId, profileId), eq(sessions.kind, "mock-section")))
          )
          const bySession = Map.groupBy(answers, (answer) => answer.sessionId)
          return new TimingView({
            questionTypes: [...paces.questionTypes].toSorted((a, b) => b[1].median - a[1].median)
              .map(([id, pace]) => ({ questionType: named(id), pace })),
            strategies: [...paces.strategies].toSorted((a, b) => b[1].median - a[1].median)
              .map(([id, pace]) => ({ strategy: named(id), pace })),
            ending: endingOf(answers),
            mocks: mockRows.toSorted((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).map((mock) => ({
              mockId: SessionId.make(mock.id),
              finishedAt: mock.finishedAt ?? 0,
              sections: sectionRows.filter((row) => row.mockId === mock.id).toSorted((a, b) => a.place - b.place).map((row) => ({
                section: named(row.section),
                limitMs: LimitMs,
                questions: servedCount.get(row.id) ?? 0,
                points: pacingOf(bySession.get(row.id) ?? [], LimitMs, servedCount.get(row.id) ?? 0).map((point) =>
                  new PacingPointView(point)
                )
              }))
            }))
          })
        })

      const mistakes = (profileId: string) =>
        Effect.gen(function*() {
          const history = yield* errorLog.history(profileId)
          const answeredDays = shownAnswers(history).filter((answer) => answer.session.shown)
            .map((answer) => history.dayOf(answer.final.at))
          const wrongParts = history.misses.flatMap(({ miss, mistakeTypes }) =>
            miss.parts.map((part, index) => ({
              day: history.dayOf(miss.at),
              mistakeType: mistakeTypes[index] ?? null,
              trapPattern: part.trapPattern
            }))
          )
          const rates = (counts: ReadonlyMap<string, number>) =>
            [...counts].toSorted((a, b) => b[1] - a[1]).map(([id, per100]) => ({ kind: named(id), per100 }))
          return new MistakeTrendView({
            weeks: mistakeWeeksOf(answeredDays, wrongParts, history.today, MistakeWeeks).map((week) => ({
              from: dayText(week.from),
              to: dayText(week.to),
              questions: week.questions,
              mistakeTypes: rates(week.mistakeTypes),
              trapPatterns: rates(week.trapPatterns)
            }))
          })
        })

      const study = (profileId: string) =>
        Effect.gen(function*() {
          const history = yield* errorLog.history(profileId)
          const answers = shownAnswers(history).map((answer) => ({
            day: history.dayOf(answer.final.at),
            section: answer.question.section,
            timeSpentMs: answer.first.timeSpentMs,
            correct: answer.correct
          }))
          const mocks = yield* run(
            db.select({ finishedAt: sessions.finishedAt }).from(sessions)
              .where(and(eq(sessions.profileId, profileId), eq(sessions.kind, "mock"), eq(sessions.status, "finished")))
          )
          return new StudyView({
            today: dayText(history.today),
            days: studyDaysOf(answers, mocks.flatMap((mock) => (mock.finishedAt === null ? [] : [history.dayOf(mock.finishedAt)]))).map((day) => ({
              day: dayText(day.day),
              minutes: day.minutes,
              questions: day.questions,
              sections: [...day.sections].map(([section, accuracy]) => ({ section: named(section), ...accuracy })),
              mocks: day.mocks
            }))
          })
        })

      return Analytics.of({ weakAreas, skillMap, timing, mistakes, study })
    })
  )
}
