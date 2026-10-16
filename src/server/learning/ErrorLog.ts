import { and, eq, inArray, isNotNull, type SQL, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer } from "effect"
import { bandNames, bandOf, type DifficultyBand } from "../../api/difficulty.ts"
import {
  ErrorLogDetail,
  ErrorLogEntry,
  ErrorLogEntryHeld,
  ErrorLogEntryNotFound,
  ErrorLogFacets,
  type ErrorLogFilters,
  ErrorLogPageSize,
  ErrorLogView,
  type ErrorReason,
  type ErrorStatus,
  HistoryItem,
  LadderStepView,
  LadderView,
  MistakeTypeInvalid
} from "../../api/ErrorLog.ts"
import { MistakesView, Named, ResponseView, ServedView, SessionId } from "../../api/Practice.ts"
import { QuestionId } from "../../api/Review.ts"
import { studyDayOf } from "../../api/studyDay.ts"
import { Db } from "../db/Database.ts"
import { mistakeLabels, profiles, questions, responses, retrySkips, servedQuestions, sessions } from "../db/schema.ts"
import { debriefOf, namesOf, practiceQuestion, storedQuestions } from "../practice/content.ts"
import { bookmarkedBy, heldBySections, isCorrect, mergeTargets } from "../practice/history.ts"
import { ratedAmong } from "../ratings/rated.ts"
import { Settings } from "../settings/Settings.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { labelsOf, missedPartView, questionFactOf, type QuestionSummary, questionSummaries, responseFact } from "./facts.ts"
import type { Step } from "./ladder.ts"
import { type EntryLadder, laddersOf } from "./ladders.ts"
import { type Miss, missesOf, type ResponseFact, type ServedFact, type SessionFact } from "./misses.ts"
import { type RetryItem, retryListOf } from "./retryConfig.ts"

// The Error Log service (docs/design.md, "Learning loop"): entries worked
// out from the facts on every read, with the Learner's Mistake Types kept
// as facts of their own. A list reads the Profile's whole history once; an
// entry, and a change to it, read only the Sessions that answered its
// Question.

const DayMs = 24 * 60 * 60 * 1000
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DayMs

// Slow and guessed entries carry these in place of a Mistake Type, so the
// Mistake Type filter can pick them out too, as it can the wrong Parts that
// still need a label.
const Unlabelled = "unlabelled"
const KindNames: Readonly<Record<"slow" | "guessed" | typeof Unlabelled, string>> = {
  slow: "Slow",
  guessed: "Guessed",
  [Unlabelled]: "Not yet labelled"
}
const StatusNames: Readonly<Record<ErrorStatus, string>> = { open: "Open", resolved: "Resolved", withdrawn: "Withdrawn" }
const BandOrder: ReadonlyArray<DifficultyBand> = ["easy", "medium", "hard"]

// The Session kinds whose Responses can enter the Error Log.
const Kinds = ["practice", "sectional", "mock-section"]

type ShownSession = SessionFact & {
  readonly timed: boolean
  readonly finished: boolean
  // A retry set's Retry Ladder steps; none for any other Session.
  readonly retry: ReadonlyArray<RetryItem>
}

// A Study Day as a date.
const dayText = (day: number) => new Date(day * DayMs).toISOString().slice(0, 10)

const ladderView = (found: EntryLadder | undefined) =>
  found === undefined ? null : new LadderView({
    step: found.ladder.step,
    dueOn: found.ladder.dueDay === null ? null : dayText(found.ladder.dueDay),
    steps: found.ladder.history.map((step) =>
      new LadderStepView({ step: step.step, on: dayText(step.day), outcome: step.outcome, note: step.note ?? null })
    )
  })

interface Facts {
  readonly sessions: ReadonlyMap<string, ShownSession>
  readonly responses: ReadonlyArray<ResponseFact>
  readonly misses: ReadonlyArray<Miss>
  readonly summaries: ReadonlyMap<string, QuestionSummary>
  readonly resolve: (questionId: string) => string
  readonly labels: ReadonlyMap<string, string>
  readonly ladders: ReadonlyMap<string, EntryLadder>
  readonly timeZone: string
  // Today's Study Day, in the Profile's time zone and rollover hour.
  readonly today: number
}

// An entry as plain data; its view is built only for the page shown.
interface Entry {
  readonly questionId: string
  readonly question: QuestionSummary
  // Oldest first.
  readonly misses: ReadonlyArray<Miss>
  readonly latest: Miss
  readonly status: ErrorStatus
  readonly band: DifficultyBand
  // The latest miss's Mistake Types, the Learner's where set, with Slow,
  // Guessed and Not yet labelled among them.
  readonly kinds: ReadonlyArray<string>
  readonly trapPatterns: ReadonlyArray<string>
  readonly ladder: EntryLadder | undefined
}

// What the Retries service reads: each entry with a Retry Ladder, today's
// Study Day, and a retry set not finished yet.
export interface RetryState {
  readonly today: number
  readonly entries: ReadonlyArray<{
    readonly questionId: string
    readonly question: QuestionSummary
    readonly status: ErrorStatus
    readonly lastMissedAt: number
    readonly ladder: EntryLadder
  }>
  readonly running: string | undefined
}

export class ErrorLog extends Context.Service<ErrorLog, {
  list(profileId: string, filters: ErrorLogFilters): Effect.Effect<ErrorLogView>
  get(profileId: string, questionId: string): Effect.Effect<ErrorLogDetail, ErrorLogEntryNotFound | ErrorLogEntryHeld>
  setMistakeType(
    profileId: string,
    questionId: string,
    change: { readonly responseId: string; readonly part: number; readonly mistakeType: string }
  ): Effect.Effect<ErrorLogEntry, ErrorLogEntryNotFound | MistakeTypeInvalid>
  retryState(profileId: string): Effect.Effect<RetryState>
}>()("gmat-prep/server/ErrorLog") {
  static readonly layer = Layer.effect(
    ErrorLog,
    Effect.gen(function*() {
      const db = yield* Db
      const settings = yield* Settings
      const taxonomy = (yield* Taxonomy).view
      const names = namesOf(taxonomy)
      const run = <A, E>(effect: Effect.Effect<A, E, Db>) => effect.pipe(Effect.provideService(Db, db), Effect.orDie)

      // Sessions, with whether each shows how its answers went yet: an
      // untimed Practice Set at once, a timed one when it ends, a Sectional
      // when it closes, a Mock's Section when the Mock is over.
      const readSessions = (where: SQL | undefined) =>
        Effect.gen(function*() {
          const rows = yield* run(
            db.select({
              id: sessions.id,
              kind: sessions.kind,
              status: sessions.status,
              timed: sessions.timed,
              timeLimitMs: sessions.timeLimitMs,
              mockId: sql<string | null>`json_extract(${sessions.config}, '$.mock.id')`,
              retry: sql<string | null>`json_extract(${sessions.config}, '$.retry')`
            }).from(sessions).where(where)
          )
          const mockIds = [...new Set(rows.flatMap((row) => (row.mockId === null ? [] : [row.mockId])))]
          const mocksOver = new Set(
            mockIds.length === 0 ? [] : (yield* run(
              db.select({ id: sessions.id }).from(sessions)
                .where(and(inArray(sessions.id, mockIds), eq(sessions.status, "finished")))
            )).map((row) => row.id)
          )
          return new Map(rows.map((row) => [row.id, {
            id: row.id,
            kind: row.kind,
            timed: row.timed,
            finished: row.status === "finished",
            retry: row.kind === "practice" ? retryListOf(row.retry) : [],
            limitMs: row.timed ? row.timeLimitMs : null,
            shown: row.kind === "practice"
              ? !row.timed || row.status === "finished"
              : row.status === "finished" && (row.kind === "sectional" || (row.mockId !== null && mocksOver.has(row.mockId)))
          } satisfies ShownSession] as const))
        })

      const responseColumns = {
        id: responses.id,
        sessionId: responses.sessionId,
        questionId: responses.questionId,
        kind: responses.kind,
        seq: responses.seq,
        selection: responses.selection,
        timeSpentMs: responses.timeSpentMs,
        guessed: responses.guessed,
        createdAt: responses.createdAt
      }
      const servedColumns = {
        sessionId: servedQuestions.sessionId,
        questionId: servedQuestions.questionId,
        servedElapsedMs: servedQuestions.servedElapsedMs
      }

      // The misses from these Sessions' Responses, judged by the Questions
      // they count as.
      const factsFrom = (
        profileId: string,
        found: ReadonlyMap<string, ShownSession>,
        answers: ReadonlyArray<Parameters<typeof responseFact>[0]>,
        served: ReadonlyArray<ServedFact>,
        resolve: (questionId: string) => string,
        skipsWhere: SQL
      ) =>
        Effect.gen(function*() {
          const responseFacts = answers.map(responseFact)
          const summaries = yield* run(questionSummaries(answers.flatMap((answer) => [answer.questionId, resolve(answer.questionId)])))
          const overrides = yield* settings.targetTimes
          const misses = missesOf({
            sessions: [...found.values()],
            responses: responseFacts,
            served,
            questions: new Map([...summaries].map(([id, question]) => [id, questionFactOf(question, overrides)] as const)),
            resolve
          })
          // A few misses are looked up one by one; many, by the Profile.
          const missed = misses.map((miss) => miss.responseId)
          const labels = missed.length === 0 ? new Map<string, string>() : yield* run(labelsOf(
            missed.length > 500
              ? eq(mistakeLabels.profileId, profileId)
              : and(eq(mistakeLabels.profileId, profileId), inArray(mistakeLabels.responseId, missed))!
          ))
          const [profile] = yield* run(
            db.select({ timeZone: profiles.timeZone, rolloverHour: profiles.rolloverHour }).from(profiles)
              .where(eq(profiles.id, profileId))
          )
          const timeZone = profile?.timeZone ?? "UTC"
          const dayOf = (at: number) => studyDayOf(at, timeZone, profile?.rolloverHour ?? 4)
          const skips = yield* run(db.select().from(retrySkips).where(and(eq(retrySkips.profileId, profileId), skipsWhere)))
          const ladders = laddersOf({
            misses,
            sessions: [...found.values()].flatMap((session) =>
              session.retry.length === 0 ? [] : [{ id: session.id, shown: session.shown, retry: session.retry }]
            ),
            responses: responseFacts,
            questions: new Map([...summaries].map(([id, question]) => [id, questionFactOf(question, overrides)] as const)),
            skips: skips.map((row) => ({ questionId: row.questionId, step: row.step as Step, at: row.createdAt, note: row.note })),
            resolve,
            dayOf
          })
          return {
            sessions: found,
            responses: responseFacts,
            misses,
            summaries,
            resolve,
            labels,
            ladders,
            timeZone,
            today: dayOf(yield* Clock.currentTimeMillis)
          } satisfies Facts
        })

      // Each Profile's Responses, kept between reads for the few Profiles read
      // last. A Response is never changed once written, so a read takes only
      // the rows written since; a count or a last row that disagrees, as after
      // a deletion or a restore, reads them all again.
      type Kept = { readonly answers: ReadonlyArray<Parameters<typeof responseFact>[0]>; readonly last: number }
      const kept = new Map<string, Kept>()
      const KeptProfiles = 4
      const rowid = sql<number>`${responses}.rowid`
      const answersOf = (profileId: string) =>
        Effect.gen(function*() {
          const before = kept.get(profileId)
          const [stats] = yield* run(
            db.select({ count: sql<number>`count(*)`, last: sql<number | null>`max(${responses}.rowid)` }).from(responses)
              .where(eq(responses.profileId, profileId))
          )
          const count = Number(stats?.count ?? 0)
          const last = Number(stats?.last ?? 0)
          const since = before === undefined || last < before.last ? undefined : yield* run(
            db.select({ ...responseColumns, rowid }).from(responses)
              .where(and(eq(responses.profileId, profileId), sql`${responses}.rowid > ${before.last}`))
          )
          const all = (rows: ReadonlyArray<{ readonly rowid: number }>) => rows.reduce((most, row) => Math.max(most, row.rowid), 0)
          const next: Kept = before !== undefined && since !== undefined && before.answers.length + since.length === count
            ? { answers: since.length === 0 ? before.answers : [...before.answers, ...since], last: Math.max(before.last, all(since)) }
            : yield* run(db.select({ ...responseColumns, rowid }).from(responses).where(eq(responses.profileId, profileId))).pipe(
              Effect.map((rows) => ({ answers: rows, last: all(rows) }))
            )
          kept.delete(profileId)
          kept.set(profileId, next)
          for (const oldest of [...kept.keys()].slice(0, Math.max(0, kept.size - KeptProfiles))) kept.delete(oldest)
          return next.answers
        })

      // Every fact of the Profile's history.
      const profileFacts = (profileId: string) =>
        Effect.gen(function*() {
          const found = yield* readSessions(and(eq(sessions.profileId, profileId), inArray(sessions.kind, Kinds)))
          const answers = yield* answersOf(profileId)
          // Only a timed Session's clock says when a Question was served.
          const served = yield* run(
            db.select(servedColumns).from(servedQuestions).innerJoin(sessions, eq(sessions.id, servedQuestions.sessionId))
              .where(and(eq(sessions.profileId, profileId), eq(sessions.timed, true)))
          )
          return yield* factsFrom(profileId, found, answers, served, yield* run(mergeTargets), sql`1 = 1`)
        })

      // The facts of one entry: every Session that answered its Question, or
      // a Question merged into it, with all their Responses, since a passage
      // is timed as a whole.
      // The facts of one entry: every Session that answered its Question, or
      // a Question merged into it, with all their Responses, since a passage
      // is timed as a whole; the retry sets that took its Retry Ladder's
      // steps with a Sibling; and its skipped steps.
      const entryFacts = (profileId: string, entryId: string, resolve: (questionId: string) => string) =>
        Effect.gen(function*() {
          const merged = yield* run(db.select({ id: questions.id }).from(questions).where(isNotNull(questions.mergedInto)))
          const members = [entryId, ...merged.map((row) => row.id).filter((id) => id !== entryId && resolve(id) === entryId)]
          const answered = (yield* run(
            db.selectDistinct({ sessionId: responses.sessionId }).from(responses)
              .where(and(eq(responses.profileId, profileId), inArray(responses.questionId, members)))
          )).map((row) => row.sessionId)
          // A retry set names its entries in its config; the match is checked
          // again when the set's retry list is read.
          const retried = (yield* run(
            db.select({ id: sessions.id }).from(sessions).where(and(
              eq(sessions.profileId, profileId),
              eq(sessions.kind, "practice"),
              sql`json_extract(${sessions.config}, '$.retry') is not null`,
              sql`(${sql.join(members.map((id) => sql`instr(${sessions.config}, ${id}) > 0`), sql` or `)})`
            ))
          )).map((row) => row.id)
          const sessionIds = [...new Set([...answered, ...retried])]
          const skipsWhere = inArray(retrySkips.questionId, members)
          if (sessionIds.length === 0) return yield* factsFrom(profileId, new Map(), [], [], resolve, skipsWhere)
          const found = yield* readSessions(and(inArray(sessions.id, sessionIds), inArray(sessions.kind, Kinds)))
          const answers = yield* run(db.select(responseColumns).from(responses).where(inArray(responses.sessionId, sessionIds)))
          const served = yield* run(db.select(servedColumns).from(servedQuestions).where(inArray(servedQuestions.sessionId, sessionIds)))
          return yield* factsFrom(profileId, found, answers, served, resolve, skipsWhere)
        })

      const entriesOf = (facts: Facts): ReadonlyArray<Entry> =>
        [...Map.groupBy(facts.misses, (miss) => miss.questionId)].flatMap(([questionId, misses]): Array<Entry> => {
          const question = facts.summaries.get(questionId)
          if (question === undefined) return []
          const ordered = misses.toSorted((a, b) => a.at - b.at)
          const latest = ordered.at(-1)!
          const kinds = [
            ...latest.parts.map((part) => facts.labels.get(`${latest.responseId}:${part.part}`) ?? part.mistakeType ?? Unlabelled),
            ...latest.reasons.filter((reason) => reason !== "wrong")
          ]
          const ladder = facts.ladders.get(questionId)
          return [{
            questionId,
            question,
            misses: ordered,
            latest,
            ladder,
            status: question.status === "withdrawn" ? "withdrawn" : ladder?.ladder.status === "resolved" ? "resolved" : "open",
            band: bandOf(question.difficulty),
            kinds: [...new Set(kinds)],
            trapPatterns: [...new Set(latest.parts.flatMap((part) => (part.trapPattern === null ? [] : [part.trapPattern])))]
          }]
        }).toSorted((a, b) => b.latest.at - a.latest.at)

      // A Book by its title and edition; Books that share both also say when
      // they were added.
      const bookNamesOf = (entries: ReadonlyArray<Entry>) => {
        const all = [...new Map(entries.flatMap((entry) => entry.question.books).map((book) => [book.id, book] as const)).values()]
        const plain = (book: QuestionSummary["books"][number]) => (book.edition === "" ? book.title : `${book.title}, ${book.edition}`)
        const shared = Map.groupBy(all, plain)
        return new Map(all.map((book) => [
          book.id,
          shared.get(plain(book))!.length > 1
            ? `${plain(book)}, added ${new Date(book.createdAt).toISOString().slice(0, 10)}`
            : plain(book)
        ] as const))
      }

      const viewOf = (facts: Facts, entry: Entry, bookNames: ReadonlyMap<string, string>) =>
        new ErrorLogEntry({
          questionId: QuestionId.make(entry.questionId),
          section: names.named(entry.question.section),
          questionType: names.named(entry.question.questionType),
          primarySkill: entry.question.primarySkill === null ? null : names.named(entry.question.primarySkill),
          difficulty: entry.question.difficulty,
          band: entry.band,
          books: entry.question.books.map((book) => new Named({ id: book.id, name: bookNames.get(book.id) ?? book.title })),
          stem: entry.question.stem,
          status: entry.status,
          reasons: entry.latest.reasons,
          parts: entry.latest.parts.map((part) =>
            missedPartView(part, facts.labels.get(`${entry.latest.responseId}:${part.part}`), entry.question, names)
          ),
          responseId: entry.latest.responseId,
          misses: entry.misses.length,
          firstMissedAt: entry.misses[0]!.at,
          lastMissedAt: entry.latest.at,
          ladder: ladderView(entry.ladder)
        })

      const matches = (entry: Entry, filters: ErrorLogFilters, timeZone: string) => {
        const day = studyDayOf(entry.latest.at, timeZone, 0)
        const question = entry.question
        return (filters.section === undefined || question.section === filters.section) &&
          (filters.skill === undefined || question.primarySkill === filters.skill || question.secondarySkills.includes(filters.skill)) &&
          (filters.questionType === undefined || question.questionType === filters.questionType) &&
          (filters.mistakeType === undefined || entry.kinds.includes(filters.mistakeType)) &&
          (filters.trapPattern === undefined || entry.trapPatterns.includes(filters.trapPattern)) &&
          (filters.band === undefined || entry.band === filters.band) &&
          (filters.book === undefined || question.books.some((book) => book.id === filters.book)) &&
          (filters.status === undefined || entry.status === filters.status) &&
          (filters.from === undefined || day >= dayNumber(filters.from)) &&
          (filters.to === undefined || day <= dayNumber(filters.to))
      }

      // Each value's count over the entries, by name unless an order is given.
      const counted = (
        values: ReadonlyArray<ReadonlyArray<{ readonly id: string; readonly name: string }>>,
        order?: ReadonlyArray<string>
      ) => {
        const counts = new Map<string, { id: string; name: string; entries: number }>()
        for (const each of values) {
          for (const value of new Map(each.map((item) => [item.id, item] as const)).values()) {
            const found = counts.get(value.id) ?? { id: value.id, name: value.name, entries: 0 }
            counts.set(value.id, { ...found, entries: found.entries + 1 })
          }
        }
        return [...counts.values()].toSorted((a, b) =>
          order === undefined ? a.name.localeCompare(b.name) : order.indexOf(a.id) - order.indexOf(b.id)
        )
      }

      const kindName = (id: string) =>
        id === "slow" || id === "guessed" || id === Unlabelled ? { id, name: KindNames[id] } : names.named(id)

      const facetsOf = (entries: ReadonlyArray<Entry>, bookNames: ReadonlyMap<string, string>) =>
        new ErrorLogFacets({
          sections: counted(entries.map((entry) => [names.named(entry.question.section)])),
          skills: counted(entries.map((entry) =>
            [...(entry.question.primarySkill === null ? [] : [entry.question.primarySkill]), ...entry.question.secondarySkills]
              .map((skill) => names.named(skill))
          )),
          questionTypes: counted(entries.map((entry) => [names.named(entry.question.questionType)])),
          mistakeTypes: counted(entries.map((entry) => entry.kinds.map(kindName))),
          trapPatterns: counted(entries.map((entry) => entry.trapPatterns.map((id) => names.named(id)))),
          bands: counted(entries.map((entry) => [{ id: entry.band, name: bandNames[entry.band] }]), BandOrder),
          books: counted(entries.map((entry) =>
            entry.question.books.map((book) => ({ id: book.id, name: bookNames.get(book.id) ?? book.title }))
          )),
          statuses: counted(entries.map((entry) => [{ id: entry.status, name: StatusNames[entry.status] }]))
        })

      const list = (profileId: string, filters: ErrorLogFilters) =>
        Effect.gen(function*() {
          const facts = yield* profileFacts(profileId)
          const held = yield* run(heldBySections(profileId))
          const all = entriesOf(facts)
          const shown = all.filter((entry) => !held.has(entry.questionId))
          const kept = shown.filter((entry) => matches(entry, filters, facts.timeZone))
          const bookNames = bookNamesOf(shown)
          const offset = filters.offset ?? 0
          return new ErrorLogView({
            entries: kept.slice(offset, offset + (filters.limit ?? ErrorLogPageSize)).map((entry) => viewOf(facts, entry, bookNames)),
            matching: kept.length,
            total: shown.length,
            held: all.length - shown.length,
            facets: facetsOf(shown, bookNames),
            timeZone: facts.timeZone
          })
        })

      // The entry a Question belongs to, from its own facts.
      const entryOf = (profileId: string, questionId: string) =>
        Effect.gen(function*() {
          const resolve = yield* run(mergeTargets)
          const entryId = resolve(questionId)
          const facts = yield* entryFacts(profileId, entryId, resolve)
          const entry = entriesOf(facts).find((each) => each.questionId === entryId)
          if (entry === undefined) return yield* new ErrorLogEntryNotFound()
          return { facts, entry }
        })

      const get = (profileId: string, questionId: string) =>
        Effect.gen(function*() {
          const { facts, entry } = yield* entryOf(profileId, questionId)
          if ((yield* run(heldBySections(profileId))).has(entry.questionId)) return yield* new ErrorLogEntryHeld()
          const question = (yield* run(storedQuestions([entry.questionId]))).get(entry.questionId)!
          const latest = entry.latest
          const keys = question.parts.map((part) => ({ position: part.position, key: part.key }))
          const finals = new Map(entry.misses.map((miss) => [miss.responseId, miss.reasons] as const))
          // Every Response to it, or to a Question merged into it, judged by
          // its current key.
          const mine = facts.responses
            .filter((response) => facts.resolve(response.questionId) === entry.questionId && facts.sessions.has(response.sessionId))
            .toSorted((a, b) => a.at - b.at || a.seq - b.seq)
          const history = mine.map((response) => {
            const session = facts.sessions.get(response.sessionId)!
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
          const final = mine.find((response) => response.id === latest.responseId)!
          // The time the first answer took; a change in Review & Edit takes none.
          const first = mine.find((response) => response.sessionId === latest.sessionId) ?? final
          const rated = yield* run(ratedAmong(profileId, [final.questionId]))
          const view = viewOf(facts, entry, bookNamesOf([entry]))
          return new ErrorLogDetail({
            entry: view,
            served: new ServedView({
              position: 0,
              question: practiceQuestion(question, names, null),
              bookmarked: (yield* run(bookmarkedBy(profileId))).has(entry.questionId),
              response: new ResponseView({
                selection: final.selection,
                guessed: final.guessed,
                timeSpentMs: first.timeSpentMs,
                correct: final.kind !== "time-out" && isCorrect(final.selection, keys),
                rated: rated.has(final.id),
                timedOut: final.kind === "time-out"
              }),
              debrief: debriefOf(question, final.selection, names),
              mistakes: latest.parts.length === 0 ? null : new MistakesView({
                questionId: view.questionId,
                responseId: latest.responseId,
                parts: view.parts,
                choices: taxonomy.mistakeTypes.map((each) => names.named(each.id))
              })
            }),
            timed: facts.sessions.get(latest.sessionId)?.timed ?? false,
            history
          })
        })

      // Any of the entry's misses can be labelled, as each Session's Debrief
      // offers its own; the latest one shows in the list.
      const setMistakeType = (
        profileId: string,
        questionId: string,
        change: { readonly responseId: string; readonly part: number; readonly mistakeType: string }
      ) =>
        Effect.gen(function*() {
          if (!taxonomy.mistakeTypes.some((each) => each.id === change.mistakeType)) {
            return yield* new MistakeTypeInvalid({ problem: `There is no Mistake Type ${change.mistakeType}.` })
          }
          const { entry } = yield* entryOf(profileId, questionId)
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
          const after = yield* entryOf(profileId, questionId).pipe(Effect.orDie)
          return viewOf(after.facts, after.entry, bookNamesOf([after.entry]))
        })

      const retryState = (profileId: string) =>
        Effect.gen(function*() {
          const facts = yield* profileFacts(profileId)
          return {
            today: facts.today,
            entries: entriesOf(facts).flatMap((entry) =>
              entry.ladder === undefined ? [] : [{
                questionId: entry.questionId,
                question: entry.question,
                status: entry.status,
                lastMissedAt: entry.latest.at,
                ladder: entry.ladder
              }]
            ),
            // A retry set not finished: started, or paused.
            running: [...facts.sessions.values()].find((session) => session.retry.length > 0 && !session.finished)?.id
          } satisfies RetryState
        })

      return ErrorLog.of({ list, get, setMistakeType, retryState })
    })
  )
}
