import { and, eq, sql } from "drizzle-orm"
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
import { studyDaysUnder } from "../../api/studyDay.ts"
import { targetSecondsFor } from "../../api/targetTimes.ts"
import { type Blueprint, sectionCount } from "../../api/blueprint.ts"
import { sectionOf } from "../../api/taxonomyRules.ts"
import { Db } from "../db/Database.ts"
import { approaches, books, questions, sessions, sources } from "../db/schema.ts"
import { ErrorLog, type LearningHistory, type ShownSession } from "../learning/ErrorLog.ts"
import { type QuestionSummary, questionSummaries } from "../learning/facts.ts"
import { namesOf } from "../practice/content.ts"
import { isCorrect } from "../practice/history.ts"
import { ratedHistory, sectionFit } from "../ratings/history.ts"
import { recencyWeight } from "../ratings/model.ts"
import { studyClockOf } from "../ratings/rateSession.ts"
import { Settings } from "../settings/Settings.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { type RatedFact, type ScopeAbility, scopeAbilities, scopeKey } from "./abilities.ts"
import { type Answered, answeredOf } from "./answers.ts"
import { frequenciesOf } from "./frequency.ts"
import { endingOf, mistakeWeeksOf, pacesOf, pacingOf, StudyWeek, studyDaysOf, type TimedAnswer } from "./views.ts"
import { mixesOf, trapsOf, weakAreasOf } from "./weakAreas.ts"

// The Learner's analytics (docs/design.md, "Analytics"), worked out on read
// from the Profile's own facts.

const DayMs = 24 * 60 * 60 * 1000
const dayText = (day: number) => new Date(day * DayMs).toISOString().slice(0, 10)
const LimitMs = SectionMinutes * 60 * 1000
// Abilities are kept for this many Profiles, the last read.
const KeptProfiles = 4
// A Weak Area's remedy serves this many Questions.
const RemedySize = 10

// What the Study Plan reads of the analytics (decision 83): each Section's
// Ability and Rated Responses, and the Weak Areas, highest Priority first,
// with what their remedies need.
export interface PlanAnalytics {
  readonly sections: ReadonlyArray<{ readonly id: string; readonly ability: number | null; readonly rated: number }>
  readonly weakAreas: ReadonlyArray<{
    readonly kind: "skill" | "questionType"
    readonly id: string
    readonly name: string
    readonly section: string
    readonly priority: number
    readonly ability: number
    readonly slow: boolean
    readonly topMistake: string | null
    readonly topTrap: string | null
  }>
}

export class Analytics extends Context.Service<Analytics, {
  weakAreas(profileId: string): Effect.Effect<WeakAreasView>
  planAnalytics(profileId: string): Effect.Effect<PlanAnalytics>
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
      // known: Questions already read, as the Error Log's history has them.
      // Kept for the few Profiles read last, under the database's version and
      // the Study Day, as recency counts in Study Days.
      const abilitiesKept = new Map<string, { readonly key: string; readonly found: Effect.Success<ReturnType<typeof fitAbilities>> }>()
      const abilitiesFor = (profileId: string, known: ReadonlyMap<string, QuestionSummary> = new Map()) =>
        Effect.gen(function*() {
          const version = yield* errorLog.version(profileId)
          const clock = yield* run(studyClockOf(profileId))
          const key = clock === undefined ? `${version}|none` : `${version}|${studyDaysUnder(clock.rules)(clock.now)}`
          const kept = abilitiesKept.get(profileId)
          if (kept !== undefined && kept.key === key) {
            abilitiesKept.delete(profileId)
            abilitiesKept.set(profileId, kept)
            return kept.found
          }
          const found = yield* fitAbilities(profileId, clock, known)
          abilitiesKept.delete(profileId)
          abilitiesKept.set(profileId, { key, found })
          for (const oldest of [...abilitiesKept.keys()].slice(0, Math.max(0, abilitiesKept.size - KeptProfiles))) abilitiesKept.delete(oldest)
          return found
        })
      const fitAbilities = (
        profileId: string,
        clock: Effect.Success<ReturnType<typeof studyClockOf>>,
        known: ReadonlyMap<string, QuestionSummary>
      ) =>
        Effect.gen(function*() {
          const servings = clock === undefined ? [] : yield* errorLog.servings(profileId)
          const history = clock === undefined
            ? []
            : (yield* run(ratedHistory(
              profileId,
              servings.map((row) => ({ questionId: row.questionId, sessionId: row.sessionId, timed: row.timed, at: row.servedAt, order: row.rowid }))
            ))).filter((answer) => answer.ended)
          if (clock === undefined || history.length === 0) {
            return {
              abilities: [] as ReadonlyArray<ScopeAbility>,
              sectionAbility: new Map<string, number>(),
              rated: 0,
              ratedBySection: new Map<string, number>()
            }
          }
          const missing = [...new Set(history.map((answer) => answer.questionId))].filter((id) => !known.has(id))
          const read = missing.length === 0 ? new Map<string, QuestionSummary>() : yield* run(questionSummaries(missing))
          const summaries = { get: (id: string) => known.get(id) ?? read.get(id) }
          const overrides = yield* settings.targetTimes
          const dayOf = studyDaysUnder(clock.rules)
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
          const ratedBySection = new Map<string, number>()
          for (const fact of facts) ratedBySection.set(fact.section, (ratedBySection.get(fact.section) ?? 0) + 1)
          return { abilities: scopeAbilities(facts, sectionAbility), sectionAbility, rated: facts.length, ratedBySection }
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
        // Every Source counts, a merged one too: an official Book's item that
        // joined a Question already in the Bank makes that Question official.
        .leftJoin(sources, eq(sources.questionId, questions.id))
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

      // The Weak Areas, ranked, with what went wrong in their misses.
      const rankedFor = (profileId: string) =>
        Effect.gen(function*() {
          const history = yield* errorLog.history(profileId)
          const found = yield* abilitiesFor(profileId, history.summaries)
          const frequencies = frequenciesOf(yield* bank)
          // Each Question's misses gathered into one fact, its kinds and
          // Trap Patterns listed once a miss, so counting reads each Question
          // once however often it was missed.
          const byQuestion = new Map<string, { readonly kinds: Array<string>; readonly traps: Array<string> }>()
          for (const { miss, mistakeTypes } of history.misses) {
            let gathered = byQuestion.get(miss.questionId)
            if (gathered === undefined) {
              gathered = { kinds: [], traps: [] }
              byQuestion.set(miss.questionId, gathered)
            }
            for (const kind of mistakeTypes) if (kind !== null) gathered.kinds.push(kind)
            for (const reason of miss.reasons) if (reason !== "wrong") gathered.kinds.push(reason)
            const traps = new Set<string>()
            for (const part of miss.parts) if (part.trapPattern !== null) traps.add(part.trapPattern)
            for (const trap of traps) gathered.traps.push(trap)
          }
          const misses = [...byQuestion].flatMap(([questionId, gathered]) => {
            const question = history.summaries.get(questionId)
            if (question === undefined) return []
            return [{
              questionType: question.questionType,
              primarySkill: question.primarySkill,
              secondarySkills: question.secondarySkills,
              kinds: gathered.kinds,
              traps: gathered.traps
            }]
          })
          return { ...found, frequencies, areas: weakAreasOf(found.abilities, frequencies, mixesOf(misses), trapsOf(misses)) }
        })

      const planAnalytics = (profileId: string) =>
        Effect.gen(function*() {
          const { areas, sectionAbility, ratedBySection } = yield* rankedFor(profileId)
          return {
            sections: taxonomy.sections.map((section) => ({
              id: section.id,
              ability: sectionAbility.get(section.id) ?? null,
              rated: ratedBySection.get(section.id) ?? 0
            })),
            weakAreas: areas.map((area) => ({
              kind: area.kind,
              id: area.id,
              name: named(area.id).name,
              section: area.ability.sections[0] ?? sectionOf(area.id),
              priority: area.priority,
              ability: area.ability.fit.ability,
              slow: area.ability.slow,
              topMistake: area.topMistake,
              topTrap: area.topTrap
            }))
          } satisfies PlanAnalytics
        })

      const weakAreas = (profileId: string) =>
        Effect.gen(function*() {
          const { abilities, rated, frequencies, areas } = yield* rankedFor(profileId)
          return new WeakAreasView({
            areas: areas.map((area) =>
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
      const shownAnswers = (history: LearningHistory) => {
        const shown: Array<
          Answered & { readonly session: ShownSession; readonly question: QuestionSummary; readonly correct: boolean | null }
        > = []
        for (const answered of answeredOf(history.responses, history.resolve)) {
          const session = history.sessions.get(answered.sessionId)
          const question = history.summaries.get(answered.questionId)
          if (session === undefined || question === undefined) continue
          shown.push({
            sessionId: answered.sessionId,
            questionId: answered.questionId,
            servedId: answered.servedId,
            first: answered.first,
            final: answered.final,
            session,
            question,
            correct: session.shown ? answered.final.kind !== "time-out" && isCorrect(answered.final.selection, question.parts) : null
          })
        }
        return shown
      }

      // Every Approach's Strategy, time and answer, by Question in the order
      // the Debrief shows them, kept until the Approaches change. They are
      // only ever deleted and written anew, later than the last, so their
      // count, newest time and last row say when they have.
      let approachesKept: {
        readonly key: string
        readonly byQuestion: ReadonlyMap<string, ReadonlyArray<{ readonly questionId: string; readonly strategy: string; readonly seconds: number; readonly answer: string | null }>>
      } | undefined
      const approachRoutes = Effect.gen(function*() {
        const [mark] = yield* run(db.select({
          count: sql<number>`count(*)`,
          newest: sql<number | null>`max(${approaches.createdAt})`,
          last: sql<number | null>`max(${approaches}.rowid)`
        }).from(approaches))
        const key = `${mark?.count}|${mark?.newest}|${mark?.last}`
        if (approachesKept !== undefined && approachesKept.key === key) return approachesKept.byQuestion
        const rows = yield* run(
          db.select({ questionId: approaches.questionId, strategy: approaches.strategy, seconds: approaches.expectedSeconds, answer: approaches.answer })
            .from(approaches).orderBy(approaches.questionId, approaches.position)
        )
        approachesKept = { key, byQuestion: Map.groupBy(rows, (row) => row.questionId) }
        return approachesKept.byQuestion
      })

      const timing = (profileId: string) =>
        Effect.gen(function*() {
          const history = yield* errorLog.history(profileId)
          const timed = shownAnswers(history).filter((answer) => answer.session.shown && answer.session.limitMs !== null)
          const servedRow = (sessionId: string, questionId: string) =>
            history.served.get(sessionId)?.find((row) => row.questionId === questionId)
          // The Strategy of each Question's fastest Approach that reaches its key.
          const routesOf = yield* approachRoutes
          const routes = [...new Set(timed.map((answer) => answer.questionId))].flatMap((id) => routesOf.get(id) ?? [])
          const fastest = new Map<string, { strategy: string; seconds: number }>()
          for (const route of routes) {
            const question = history.summaries.get(route.questionId)
            const key = question === undefined ? null : joinedKey(question.parts.map((part) => part.key))
            if (key === null || route.answer !== key) continue
            const found = fastest.get(route.questionId)
            if (found === undefined || route.seconds < found.seconds) fastest.set(route.questionId, { strategy: route.strategy, seconds: route.seconds })
          }
          const answers = timed.map((answer): TimedAnswer => {
            const row = servedRow(answer.sessionId, answer.servedId)
            return {
              sessionId: answer.sessionId,
              kind: answer.session.kind,
              position: row?.position ?? 0,
              questionType: answer.question.questionType,
              correct: answer.first.kind !== "time-out" && isCorrect(answer.first.selection, answer.question.parts),
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
              place: sql<number>`json_extract(${sessions.config}, '$.mock.place')`,
              blueprint: sql<string>`json_extract(${sessions.config}, '$.blueprint')`
            }).from(sessions).where(and(eq(sessions.profileId, profileId), eq(sessions.kind, "mock-section")))
          )
          const bySession = Map.groupBy(answers, (answer) => answer.sessionId)
          return new TimingView({
            timeZone: history.timeZone,
            questionTypes: [...paces.questionTypes].toSorted((a, b) => b[1].median - a[1].median)
              .map(([id, pace]) => ({ questionType: named(id), pace })),
            strategies: [...paces.strategies].toSorted((a, b) => b[1].median - a[1].median)
              .map(([id, pace]) => ({ strategy: named(id), pace })),
            ending: endingOf(answers, (sessionId) => {
              const served = history.served.get(sessionId)
              return served === undefined || served.length === 0 ? undefined : Math.max(...served.map((row) => row.position))
            }),
            mocks: mockRows.toSorted((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).map((mock) => ({
              mockId: SessionId.make(mock.id),
              finishedAt: mock.finishedAt ?? 0,
              sections: sectionRows.filter((row) => row.mockId === mock.id).toSorted((a, b) => a.place - b.place).map((row) => {
                // The Section's own size from its Blueprint, so the even pace
                // runs over every Question, reached or not.
                const questions = Math.max(history.served.get(row.id)?.length ?? 0, sectionCount(JSON.parse(row.blueprint) as Blueprint, row.section))
                return {
                  section: named(row.section),
                  limitMs: LimitMs,
                  questions,
                  points: pacingOf(bySession.get(row.id) ?? [], LimitMs, questions).map((point) => new PacingPointView(point))
                }
              })
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
          // Back to the first week with an answer.
          const earliest = Math.min(history.today, ...answeredDays)
          const weekCount = Math.floor((history.today - earliest) / StudyWeek) + 1
          return new MistakeTrendView({
            weeks: mistakeWeeksOf(answeredDays, wrongParts, history.today, weekCount).map((week) => ({
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
              // In the Taxonomy's order, so each day reads the same way.
              sections: taxonomy.sections.flatMap((each) => {
                const accuracy = day.sections.get(each.id)
                return accuracy === undefined ? [] : [{ section: named(each.id), ...accuracy }]
              }),
              mocks: day.mocks
            }))
          })
        })

      // Each view as last worked out for the few Profiles read last, under the
      // database's version and the Study Day: reading a view again, or the
      // view after the one before, costs nothing until something is written.
      const viewsKept = new Map<string, { readonly key: string; readonly value: unknown }>()
      const keptView = <A>(name: string, read: (profileId: string) => Effect.Effect<A>) => (profileId: string) =>
        Effect.gen(function*() {
          const version = yield* errorLog.version(profileId)
          const clock = yield* run(studyClockOf(profileId))
          const key = clock === undefined ? `${version}|none` : `${version}|${studyDaysUnder(clock.rules)(clock.now)}`
          const slot = `${name}|${profileId}`
          const kept = viewsKept.get(slot)
          if (kept !== undefined && kept.key === key) {
            viewsKept.delete(slot)
            viewsKept.set(slot, kept)
            return kept.value as A
          }
          const value = yield* read(profileId)
          viewsKept.delete(slot)
          viewsKept.set(slot, { key, value })
          for (const oldest of [...viewsKept.keys()].slice(0, Math.max(0, viewsKept.size - KeptProfiles * 6))) viewsKept.delete(oldest)
          return value
        })

      return Analytics.of({
        weakAreas: keptView("weakAreas", weakAreas),
        planAnalytics: keptView("planAnalytics", planAnalytics),
        skillMap: keptView("skillMap", skillMap),
        timing: keptView("timing", timing),
        mistakes: keptView("mistakes", mistakes),
        study: keptView("study", study)
      })
    })
  )
}
