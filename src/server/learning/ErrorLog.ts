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
  MistakeTypeInvalid,
  parseCursor
} from "../../api/ErrorLog.ts"
import { MistakesView, Named, ResponseView, ServedView, SessionId } from "../../api/Practice.ts"
import { QuestionId } from "../../api/Review.ts"
import { studyDayOf } from "../../api/studyDay.ts"
import { Db } from "../db/Database.ts"
import { books, mistakeLabels, profiles, questions, responses, retrySkips, servedQuestions, sessions } from "../db/schema.ts"
import { debriefOf, namesOf, practiceQuestion, storedQuestions } from "../practice/content.ts"
import { bookmarkedBy, heldBySections, isCorrect, mergeTargets } from "../practice/history.ts"
import { ratedAmong } from "../ratings/rated.ts"
import { Settings } from "../settings/Settings.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import {
  inChunks,
  labelsOf,
  missedPartView,
  questionFactOf,
  type QuestionSummary,
  questionSummaries,
  responseFact
} from "./facts.ts"
import type { Step } from "./ladder.ts"
import { type EntryLadder, laddersOf } from "./ladders.ts"
import { type Miss, missesOf, type ResponseFact, type ServedFact, type SessionFact } from "./misses.ts"
import { type RetryItem, retryListOf } from "./retryConfig.ts"

// The Error Log service (docs/design.md, "Learning loop"): entries and
// their Retry Ladders worked out from the facts on every read, with the
// Learner's Mistake Types and skipped retry steps kept as facts of their
// own. A list reads the Profile's whole history, kept between reads; an
// entry, and a change to it, read only the Sessions that answered its
// Question or took its retry steps.

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

// Facet values sort by name the same way on every read.
const byName = new Intl.Collator("en").compare

type ShownSession = SessionFact & {
  readonly timed: boolean
  readonly finished: boolean
  readonly createdAt: number
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

// A moment's day and minute in a time zone.
const localTime = (at: number, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(at)
  const part = (type: string) => parts.find((each) => each.type === type)?.value ?? ""
  return { day: `${part("year")}-${part("month")}-${part("day")}`, minute: `${part("hour")}:${part("minute")}` }
}

type BookRow = Pick<typeof books.$inferSelect, "id" | "title" | "edition" | "createdAt">

// Every Book's name: its title and edition; Books that share both also say
// the day they were added, in the Profile's time zone, then the minute, and
// copies added in the same minute are counted in the order added. Names come
// from every Book, so one never changes with the entries shown.
export const bookNamesOf = (all: ReadonlyArray<BookRow>, timeZone: string): ReadonlyMap<string, string> => {
  const plain = (book: BookRow) => (book.edition === "" ? book.title : `${book.title}, ${book.edition}`)
  const steps: ReadonlyArray<(book: BookRow) => string> = [
    plain,
    (book) => `${plain(book)}, added ${localTime(book.createdAt, timeZone).day}`,
    (book) => {
      const added = localTime(book.createdAt, timeZone)
      return `${plain(book)}, added ${added.day} ${added.minute}`
    }
  ]
  const names = new Map<string, string>()
  let sharing = all.toSorted((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const step of steps) {
    const next: Array<BookRow> = []
    for (const [name, group] of Map.groupBy(sharing, step)) {
      if (group.length === 1) names.set(group[0]!.id, name)
      else next.push(...group)
    }
    sharing = next
  }
  for (const [name, group] of Map.groupBy(sharing, steps.at(-1)!)) {
    group.forEach((book, index) => names.set(book.id, `${name}, copy ${index + 1}`))
  }
  return names
}

// Entries run from the latest miss back, Question id breaking ties, and a
// page starts after the entry the last one ended on.
const later = (a: { readonly at: number; readonly id: string }, b: { readonly at: number; readonly id: string }) =>
  b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

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
              createdAt: sessions.createdAt,
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
            createdAt: row.createdAt,
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
        responseFacts: ReadonlyArray<ResponseFact>,
        served: ReadonlyArray<ServedFact> | ReadonlyMap<string, ReadonlyArray<ServedFact>>,
        resolve: (questionId: string) => string,
        skipsWhere: SQL
      ) =>
        Effect.gen(function*() {
          const answered = new Set<string>()
          for (const response of responseFacts) answered.add(response.questionId).add(resolve(response.questionId))
          const summaries = yield* run(questionSummaries([...answered]))
          const overrides = yield* settings.targetTimes
          const questionFacts = new Map([...summaries].map(([id, question]) => [id, questionFactOf(question, overrides)] as const))
          const misses = missesOf({ sessions: [...found.values()], responses: responseFacts, served, questions: questionFacts, resolve })
          // The labels of a few misses are read by their Responses; of many,
          // by the Profile.
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
              session.retry.length === 0
                ? []
                : [{ id: session.id, shown: session.shown, retry: session.retry, createdAt: session.createdAt }]
            ),
            responses: responseFacts,
            questions: questionFacts,
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

      // Each Profile's Responses, with the served rows of its timed Sessions,
      // kept between reads for the few Profiles read last. Neither is changed
      // once written, so a read takes only the Responses written since, and
      // the served rows of their Sessions again. What is kept is checked
      // first: when fewer rows now reach the last Response kept, or another
      // row has taken its place, as after a deletion or a restore, it is all
      // read again.
      type Kept = {
        readonly answers: ReadonlyArray<ResponseFact>
        // Only a timed Session's clock says when a Question was served.
        readonly served: ReadonlyMap<string, ReadonlyArray<ServedFact>>
        // The last Response kept.
        readonly last: { readonly rowid: number; readonly id: string } | undefined
      }
      const kept = new Map<string, Kept>()
      const KeptProfiles = 4
      const rowid = sql<number>`${responses}.rowid`
      const stillKept = (profileId: string, before: Kept) =>
        Effect.gen(function*() {
          if (before.last === undefined) return true
          const [check] = yield* run(
            db.select({
              count: sql<number>`count(*)`,
              last: sql<string | null>`(select ${responses.id} from ${responses} where rowid = ${before.last.rowid})`
            }).from(responses).where(and(eq(responses.profileId, profileId), sql`${responses}.rowid <= ${before.last.rowid}`))
          )
          return Number(check?.count ?? 0) === before.answers.length && check?.last === before.last.id
        })
      const servedOf = (where: SQL) =>
        run(
          db.select(servedColumns).from(servedQuestions).innerJoin(sessions, eq(sessions.id, servedQuestions.sessionId))
            .where(and(where, eq(sessions.timed, true)))
        )
      const historyOf = (profileId: string) =>
        Effect.gen(function*() {
          const found = kept.get(profileId)
          const before = found !== undefined && (yield* stillKept(profileId, found)) ? found : undefined
          // The Profile's rows are read in the table's order, which is faster
          // than by its index, which sorts them by Question.
          const since = yield* run(
            db.select({ ...responseColumns, rowid }).from(responses)
              .where(and(sql`+${responses.profileId} = ${profileId}`, sql`${responses}.rowid > ${before?.last?.rowid ?? 0}`))
          )
          const sessionIds = [...new Set(since.map((row) => row.sessionId))]
          const servedRows = before === undefined
            ? yield* servedOf(eq(sessions.profileId, profileId))
            : sessionIds.length === 0
            ? []
            : yield* run(inChunks(sessionIds, (chunk) => servedOf(inArray(servedQuestions.sessionId, chunk))))
          const served = new Map(before?.served ?? [])
          for (const [sessionId, rows] of Map.groupBy(servedRows, (row) => row.sessionId)) served.set(sessionId, rows)
          const newest = since.reduce<(typeof since)[number] | undefined>(
            (most, row) => (most === undefined || row.rowid > most.rowid ? row : most),
            undefined
          )
          const answers = since.map(responseFact)
          const next: Kept = {
            answers: before === undefined ? answers : answers.length === 0 ? before.answers : [...before.answers, ...answers],
            served,
            last: newest === undefined ? before?.last : { rowid: newest.rowid, id: newest.id }
          }
          kept.delete(profileId)
          kept.set(profileId, next)
          for (const oldest of [...kept.keys()].slice(0, Math.max(0, kept.size - KeptProfiles))) kept.delete(oldest)
          return next
        })

      // Every fact of the Profile's history.
      const profileFacts = (profileId: string) =>
        Effect.gen(function*() {
          const found = yield* readSessions(and(eq(sessions.profileId, profileId), inArray(sessions.kind, Kinds)))
          const history = yield* historyOf(profileId)
          return yield* factsFrom(profileId, found, history.answers, history.served, yield* run(mergeTargets), sql`1 = 1`)
        })

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
          if (sessionIds.length === 0) return yield* factsFrom(profileId, new Map(), [], new Map(), resolve, skipsWhere)
          const found = yield* readSessions(and(inArray(sessions.id, sessionIds), inArray(sessions.kind, Kinds)))
          const answers = yield* run(db.select(responseColumns).from(responses).where(inArray(responses.sessionId, sessionIds)))
          const served = yield* run(db.select(servedColumns).from(servedQuestions).where(inArray(servedQuestions.sessionId, sessionIds)))
          return yield* factsFrom(profileId, found, answers.map(responseFact), served, resolve, skipsWhere)
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
        }).toSorted((a, b) => later({ at: a.latest.at, id: a.questionId }, { at: b.latest.at, id: b.questionId }))

      const bookNames = (timeZone: string) =>
        run(db.select({ id: books.id, title: books.title, edition: books.edition, createdAt: books.createdAt }).from(books)).pipe(
          Effect.map((rows) => bookNamesOf(rows, timeZone))
        )

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
        const day = () => studyDayOf(entry.latest.at, timeZone, 0)
        const question = entry.question
        return (filters.section === undefined || question.section === filters.section) &&
          (filters.skill === undefined || question.primarySkill === filters.skill || question.secondarySkills.includes(filters.skill)) &&
          (filters.questionType === undefined || question.questionType === filters.questionType) &&
          (filters.mistakeType === undefined || entry.kinds.includes(filters.mistakeType)) &&
          (filters.trapPattern === undefined || entry.trapPatterns.includes(filters.trapPattern)) &&
          (filters.band === undefined || entry.band === filters.band) &&
          (filters.book === undefined || question.books.some((book) => book.id === filters.book)) &&
          (filters.status === undefined || entry.status === filters.status) &&
          (filters.from === undefined || day() >= dayNumber(filters.from)) &&
          (filters.to === undefined || day() <= dayNumber(filters.to))
      }

      // How many entries have each value, by name unless an order is given.
      // Values are named once counted, as a history holds thousands.
      const counted = (
        entries: ReadonlyArray<Entry>,
        idsOf: (entry: Entry) => string | ReadonlyArray<string>,
        nameOf: (id: string) => string,
        order?: ReadonlyArray<string>
      ) => {
        const counts = new Map<string, number>()
        for (const entry of entries) {
          const ids = idsOf(entry)
          if (typeof ids === "string") {
            counts.set(ids, (counts.get(ids) ?? 0) + 1)
            continue
          }
          for (let index = 0; index < ids.length; index++) {
            // An entry counts once for each value, however often it has it.
            if (ids.indexOf(ids[index]!) < index) continue
            counts.set(ids[index]!, (counts.get(ids[index]!) ?? 0) + 1)
          }
        }
        return [...counts].map(([id, entries]) => ({ id, name: nameOf(id), entries })).toSorted((a, b) =>
          order === undefined ? byName(a.name, b.name) : order.indexOf(a.id) - order.indexOf(b.id)
        )
      }

      const kindName = (id: string) =>
        id === "slow" || id === "guessed" || id === Unlabelled ? { id, name: KindNames[id] } : names.named(id)
      const taxonomyName = (id: string) => names.named(id).name

      const facetsOf = (entries: ReadonlyArray<Entry>, bookNames: ReadonlyMap<string, string>) =>
        new ErrorLogFacets({
          sections: counted(entries, (entry) => entry.question.section, taxonomyName),
          skills: counted(
            entries,
            (entry) =>
              entry.question.primarySkill === null
                ? entry.question.secondarySkills
                : [entry.question.primarySkill, ...entry.question.secondarySkills],
            taxonomyName
          ),
          questionTypes: counted(entries, (entry) => entry.question.questionType, taxonomyName),
          mistakeTypes: counted(entries, (entry) => entry.kinds, (id) => kindName(id).name),
          trapPatterns: counted(entries, (entry) => entry.trapPatterns, taxonomyName),
          bands: counted(entries, (entry) => entry.band, (id) => bandNames[id as DifficultyBand], BandOrder),
          books: counted(entries, (entry) => entry.question.books.map((book) => book.id), (id) => bookNames.get(id) ?? id),
          statuses: counted(entries, (entry) => entry.status, (id) => StatusNames[id as ErrorStatus])
        })

      const list = (profileId: string, filters: ErrorLogFilters) =>
        Effect.gen(function*() {
          const facts = yield* profileFacts(profileId)
          const held = yield* run(heldBySections(profileId))
          const all = entriesOf(facts)
          const shown = all.filter((entry) => !held.has(entry.questionId))
          const kept = shown.filter((entry) => matches(entry, filters, facts.timeZone))
          const names = yield* bookNames(facts.timeZone)
          // The page starts after the entry the last one ended on, wherever
          // that entry is now: a label change can take it out of the filter.
          const after = filters.after === undefined ? undefined : parseCursor(filters.after)
          const start = after === undefined
            ? 0
            : (() => {
              const found = kept.findIndex((entry) => later(after, { at: entry.latest.at, id: entry.questionId }) < 0)
              return found === -1 ? kept.length : found
            })()
          const page = kept.slice(start, start + (filters.limit ?? ErrorLogPageSize))
          return new ErrorLogView({
            entries: page.map((entry) => viewOf(facts, entry, names)),
            matching: kept.length,
            more: kept.length - start - page.length,
            total: shown.length,
            held: all.length - shown.length,
            facets: facetsOf(shown, names),
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
          const view = viewOf(facts, entry, yield* bookNames(facts.timeZone))
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
          return viewOf(after.facts, after.entry, yield* bookNames(after.facts.timeZone))
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
