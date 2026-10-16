import { and, eq, inArray } from "drizzle-orm"
import { Clock, Context, Effect, Layer } from "effect"
import { bandNames, bandOf } from "../../api/difficulty.ts"
import {
  ErrorLogDetail,
  ErrorLogEntry,
  ErrorLogEntryNotFound,
  ErrorLogFacets,
  type ErrorLogFilters,
  ErrorLogView,
  type ErrorReason,
  type ErrorStatus,
  HistoryItem,
  MistakeTypeInvalid
} from "../../api/ErrorLog.ts"
import { MistakesView, Named, ResponseView, ServedView, SessionId } from "../../api/Practice.ts"
import { QuestionId } from "../../api/Review.ts"
import { studyDayOf } from "../../api/studyDay.ts"
import { Db } from "../db/Database.ts"
import { mistakeLabels, profiles, questions, responses, servedQuestions, sessions } from "../db/schema.ts"
import { debriefOf, namesOf, practiceQuestion, type StoredQuestion, storedQuestions } from "../practice/content.ts"
import { bookmarkedBy, isCorrect, mergeTargets } from "../practice/history.ts"
import { ratedAmong } from "../ratings/rated.ts"
import { decodeConfig } from "../sections/config.ts"
import { Settings } from "../settings/Settings.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { labelsOf, missedPartView, questionFacts, responseFact } from "./facts.ts"
import { type Miss, missesOf, type SessionFact } from "./misses.ts"

// The Error Log service (docs/design.md, "Learning loop"): entries worked
// out from the facts on every read, with the Learner's Mistake Types kept
// as facts of their own.

const DayMs = 24 * 60 * 60 * 1000
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DayMs

// Slow and guessed entries carry these in place of a Mistake Type, so the
// Mistake Type filter can pick them out too.
const ReasonNames: Readonly<Record<"slow" | "guessed", string>> = { slow: "Slow", guessed: "Guessed" }
const StatusNames: Readonly<Record<ErrorStatus, string>> = { open: "Open", withdrawn: "Withdrawn" }

interface Entry {
  readonly view: ErrorLogEntry
  readonly secondarySkills: ReadonlyArray<string>
  readonly misses: ReadonlyArray<Miss>
  // The Questions whose Responses count for it: itself and those merged into it.
  readonly members: ReadonlyArray<string>
}

export class ErrorLog extends Context.Service<ErrorLog, {
  list(profileId: string, filters: ErrorLogFilters): Effect.Effect<ErrorLogView>
  get(profileId: string, questionId: string): Effect.Effect<ErrorLogDetail, ErrorLogEntryNotFound>
  setMistakeType(
    profileId: string,
    questionId: string,
    change: { readonly responseId: string; readonly part: number; readonly mistakeType: string }
  ): Effect.Effect<ErrorLogEntry, ErrorLogEntryNotFound | MistakeTypeInvalid>
}>()("gmat-prep/server/ErrorLog") {
  static readonly layer = Layer.effect(
    ErrorLog,
    Effect.gen(function*() {
      const db = yield* Db
      const settings = yield* Settings
      const taxonomy = (yield* Taxonomy).view
      const names = namesOf(taxonomy)
      const run = <A, E>(effect: Effect.Effect<A, E, Db>) => effect.pipe(Effect.provideService(Db, db), Effect.orDie)

      // Every fact the Error Log reads for a Profile.
      const factsOf = (profileId: string) =>
        Effect.gen(function*() {
          const rows = yield* run(
            db.select().from(sessions).where(and(
              eq(sessions.profileId, profileId),
              inArray(sessions.kind, ["practice", "sectional", "mock-section", "mock"])
            ))
          )
          const finishedMocks = new Set(rows.filter((row) => row.kind === "mock" && row.status === "finished").map((row) => row.id))
          const shown = (row: (typeof rows)[number]) => {
            if (row.kind === "practice") return !row.timed || row.status === "finished"
            if (row.status !== "finished") return false
            if (row.kind === "sectional") return true
            const mock = decodeConfig(row.config).mock
            return mock !== undefined && finishedMocks.has(mock.id)
          }
          const sessionFacts: Array<SessionFact & { readonly row: (typeof rows)[number] }> = rows
            .filter((row) => row.kind !== "mock")
            .map((row) => ({ id: row.id, kind: row.kind, limitMs: row.timed ? row.timeLimitMs : null, shown: shown(row), row }))
          const answers = yield* run(db.select().from(responses).where(eq(responses.profileId, profileId)))
          const responseFacts = answers.map(responseFact)
          const sessionIds = sessionFacts.map((session) => session.id)
          const served = sessionIds.length === 0 ? [] : yield* run(
            db.select({
              sessionId: servedQuestions.sessionId,
              questionId: servedQuestions.questionId,
              servedElapsedMs: servedQuestions.servedElapsedMs
            }).from(servedQuestions).where(inArray(servedQuestions.sessionId, sessionIds))
          )
          const resolve = yield* run(mergeTargets)
          const answered = [...new Set(answers.map((answer) => answer.questionId))]
          const ids = [...new Set([...answered, ...answered.map(resolve)])]
          const stored = yield* run(storedQuestions(ids))
          const rowsOf = ids.length === 0 ? [] : yield* run(
            db.select({
              id: questions.id,
              status: questions.status,
              stimulusId: questions.stimulusId,
              secondarySkills: questions.secondarySkills
            }).from(questions).where(inArray(questions.id, ids))
          )
          const details = new Map(rowsOf.map((row) => [row.id, row] as const))
          const overrides = yield* settings.targetTimes
          const stimulusOf = new Map(rowsOf.map((row) => [row.id, row.stimulusId] as const))
          const misses = missesOf({
            sessions: sessionFacts,
            responses: responseFacts,
            served,
            questions: questionFacts(stored, stimulusOf, overrides)
          })
          const labels = yield* run(labelsOf(eq(mistakeLabels.profileId, profileId)))
          const [profile] = yield* run(db.select({ timeZone: profiles.timeZone }).from(profiles).where(eq(profiles.id, profileId)))
          return {
            sessions: sessionFacts,
            responses: responseFacts,
            misses,
            stored,
            details,
            resolve,
            labels,
            timeZone: profile?.timeZone ?? "UTC"
          }
        })

      type Facts = Effect.Success<ReturnType<typeof factsOf>>

      const entriesOf = (facts: Facts): ReadonlyArray<Entry> => {
        const groups = Map.groupBy(facts.misses, (miss) => facts.resolve(miss.questionId))
        return [...groups].flatMap(([questionId, misses]): Array<Entry> => {
          const question = facts.stored.get(questionId)
          if (question === undefined) return []
          const ordered = misses.toSorted((a, b) => a.at - b.at)
          const latest = ordered.at(-1)!
          const served = facts.stored.get(latest.questionId) ?? question
          const detail = facts.details.get(questionId)
          const books = [...new Map(question.sources.map((source) => [source.bookId, source.bookTitle] as const))]
          return [{
            view: new ErrorLogEntry({
              questionId: QuestionId.make(questionId),
              section: names.named(question.section),
              questionType: names.named(question.questionType),
              primarySkill: question.primarySkill === null ? null : names.named(question.primarySkill),
              difficulty: question.difficulty,
              band: bandOf(question.difficulty),
              books: books.map(([id, title]) => new Named({ id, name: title })),
              stem: question.stem,
              status: detail?.status === "withdrawn" ? "withdrawn" : "open",
              reasons: latest.reasons,
              parts: latest.parts.map((part) =>
                missedPartView(part, facts.labels.get(`${latest.responseId}:${part.part}`), served, names)
              ),
              responseId: latest.responseId,
              misses: ordered.length,
              firstMissedAt: ordered[0]!.at,
              lastMissedAt: latest.at
            }),
            secondarySkills: JSON.parse(detail?.secondarySkills ?? "[]") as ReadonlyArray<string>,
            misses: ordered,
            members: [...new Set([questionId, ...misses.map((miss) => miss.questionId)])]
          }]
        }).toSorted((a, b) => b.view.lastMissedAt - a.view.lastMissedAt)
      }

      // The Mistake Types an entry shows, slow and guessed among them.
      const kindsOf = (entry: Entry) => [
        ...entry.view.parts.flatMap((part) => (part.mistakeType === null ? [] : [part.mistakeType.id])),
        ...entry.view.reasons.filter((reason): reason is "slow" | "guessed" => reason !== "wrong")
      ]

      const matches = (entry: Entry, filters: ErrorLogFilters, timeZone: string) => {
        const view = entry.view
        const day = studyDayOf(view.lastMissedAt, timeZone, 0)
        return (filters.section === undefined || view.section.id === filters.section) &&
          (filters.skill === undefined || view.primarySkill?.id === filters.skill || entry.secondarySkills.includes(filters.skill)) &&
          (filters.questionType === undefined || view.questionType.id === filters.questionType) &&
          (filters.mistakeType === undefined || kindsOf(entry).includes(filters.mistakeType)) &&
          (filters.trapPattern === undefined || view.parts.some((part) => part.trapPattern?.id === filters.trapPattern)) &&
          (filters.band === undefined || view.band === filters.band) &&
          (filters.book === undefined || view.books.some((book) => book.id === filters.book)) &&
          (filters.status === undefined || view.status === filters.status) &&
          (filters.from === undefined || day >= dayNumber(filters.from)) &&
          (filters.to === undefined || day <= dayNumber(filters.to))
      }

      // Each value's count, in the order first met, named.
      const counted = (values: ReadonlyArray<ReadonlyArray<{ readonly id: string; readonly name: string }>>) => {
        const counts = new Map<string, { id: string; name: string; entries: number }>()
        for (const each of values) {
          for (const value of new Map(each.map((item) => [item.id, item] as const)).values()) {
            const found = counts.get(value.id) ?? { id: value.id, name: value.name, entries: 0 }
            counts.set(value.id, { ...found, entries: found.entries + 1 })
          }
        }
        return [...counts.values()].toSorted((a, b) => a.name.localeCompare(b.name))
      }

      const facetsOf = (entries: ReadonlyArray<Entry>) =>
        new ErrorLogFacets({
          sections: counted(entries.map((entry) => [entry.view.section])),
          skills: counted(entries.map((entry) => [
            ...(entry.view.primarySkill === null ? [] : [entry.view.primarySkill]),
            ...entry.secondarySkills.map((skill) => names.named(skill))
          ])),
          questionTypes: counted(entries.map((entry) => [entry.view.questionType])),
          mistakeTypes: counted(entries.map((entry) =>
            kindsOf(entry).map((id) =>
              id === "slow" || id === "guessed" ? { id, name: ReasonNames[id] } : names.named(id)
            )
          )),
          trapPatterns: counted(entries.map((entry) => entry.view.parts.flatMap((part) => (part.trapPattern === null ? [] : [part.trapPattern])))),
          bands: counted(entries.map((entry) => [{ id: entry.view.band, name: bandNames[entry.view.band] }])),
          books: counted(entries.map((entry) => entry.view.books)),
          statuses: counted(entries.map((entry) => [{ id: entry.view.status, name: StatusNames[entry.view.status] }]))
        })

      const list = (profileId: string, filters: ErrorLogFilters) =>
        Effect.gen(function*() {
          const facts = yield* factsOf(profileId)
          const entries = entriesOf(facts)
          return new ErrorLogView({
            entries: entries.filter((entry) => matches(entry, filters, facts.timeZone)).map((entry) => entry.view),
            total: entries.length,
            facets: facetsOf(entries)
          })
        })

      const find = (facts: Facts, questionId: string) => {
        const entry = entriesOf(facts).find((each) => each.view.questionId === facts.resolve(questionId))
        return entry === undefined ? Effect.fail(new ErrorLogEntryNotFound()) : Effect.succeed(entry)
      }

      const get = (profileId: string, questionId: string) =>
        Effect.gen(function*() {
          const facts = yield* factsOf(profileId)
          const entry = yield* find(facts, questionId)
          const question: StoredQuestion = facts.stored.get(entry.view.questionId)!
          const latest = entry.misses.at(-1)!
          const final = facts.responses.find((response) => response.id === latest.responseId)!
          const served = facts.stored.get(latest.questionId) ?? question
          const shown = new Map(facts.sessions.map((session) => [session.id, session] as const))
          const finals = new Map(entry.misses.map((miss) => [miss.responseId, miss.reasons] as const))
          const history = facts.responses
            .filter((response) => entry.members.includes(response.questionId) && shown.has(response.sessionId))
            .toSorted((a, b) => a.at - b.at || a.seq - b.seq)
            .map((response) => {
              const session = shown.get(response.sessionId)!
              const keys = (facts.stored.get(response.questionId) ?? question).parts
                .map((part) => ({ position: part.position, key: part.key }))
              return new HistoryItem({
                sessionId: SessionId.make(response.sessionId),
                sessionKind: session.kind === "mock-section" ? "mock" : session.kind,
                at: response.at,
                kind: response.kind,
                selection: response.selection,
                timeSpentMs: response.timeSpentMs,
                guessed: response.guessed,
                correct: session.shown ? response.kind !== "time-out" && isCorrect(response.selection, keys) : null,
                reasons: [...(finals.get(response.id) ?? [])] as Array<ErrorReason>
              })
            })
          const keys = served.parts.map((part) => ({ position: part.position, key: part.key }))
          const rated = yield* run(ratedAmong(profileId, [latest.questionId]))
          return new ErrorLogDetail({
            entry: entry.view,
            served: new ServedView({
              position: 0,
              question: practiceQuestion(served, names, null),
              bookmarked: (yield* run(bookmarkedBy(profileId))).has(entry.view.questionId),
              response: new ResponseView({
                selection: final.selection,
                guessed: final.guessed,
                // The time the first answer took; a change in Review & Edit takes none.
                timeSpentMs: facts.responses
                  .filter((response) => response.sessionId === latest.sessionId && response.questionId === latest.questionId)
                  .toSorted((a, b) => a.seq - b.seq)[0]?.timeSpentMs ?? final.timeSpentMs,
                correct: final.kind !== "time-out" && isCorrect(final.selection, keys),
                rated: rated.has(final.id),
                timedOut: final.kind === "time-out"
              }),
              debrief: debriefOf(served, final.selection, names),
              mistakes: latest.parts.length === 0 ? null : new MistakesView({
                questionId: entry.view.questionId,
                responseId: latest.responseId,
                parts: entry.view.parts,
                choices: taxonomy.mistakeTypes.map((each) => names.named(each.id))
              })
            }),
            timed: facts.sessions.find((session) => session.id === latest.sessionId)?.limitMs != null,
            history
          })
        })

      const setMistakeType = (
        profileId: string,
        questionId: string,
        change: { readonly responseId: string; readonly part: number; readonly mistakeType: string }
      ) =>
        Effect.gen(function*() {
          if (!taxonomy.mistakeTypes.some((each) => each.id === change.mistakeType)) {
            return yield* new MistakeTypeInvalid({ problem: `There is no Mistake Type ${change.mistakeType}.` })
          }
          const facts = yield* factsOf(profileId)
          const entry = yield* find(facts, questionId)
          const miss = entry.misses.find((each) => each.responseId === change.responseId)
          if (miss === undefined || !miss.parts.some((part) => part.part === change.part)) {
            return yield* new MistakeTypeInvalid({ problem: "That Part was not answered wrong in this entry." })
          }
          yield* run(db.insert(mistakeLabels).values({
            id: crypto.randomUUID(),
            profileId,
            responseId: change.responseId,
            part: change.part,
            mistakeType: change.mistakeType,
            createdAt: yield* Clock.currentTimeMillis
          }))
          return (yield* find(yield* factsOf(profileId), questionId).pipe(Effect.orDie)).view
        })

      return ErrorLog.of({ list, get, setMistakeType })
    })
  )
}
