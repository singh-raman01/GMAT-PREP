import { and, asc, eq, isNotNull, isNull, lt, max, ne } from "drizzle-orm"
import { Clock, Effect, Option, Schema } from "effect"
import { sha256 } from "../access/tokens.ts"
import { Db } from "../db/Database.ts"
import { books, bookSkips, options, parts, questions, reviewItems, sources, taxonomyVersions } from "../db/schema.ts"
import {
  type Candidate,
  candidateProblems,
  comparableText,
  NearMatch,
  type Reason,
  type ReasonCode,
  similarity,
  type Skip,
  trigrams
} from "./linking.ts"

// Writing linked items into the Question Bank. Each item is written in one
// transaction and found again by its Book, the page it starts on and its
// number, so a run that stops part way, a Book Map fix or a renamed set
// writes each item once. A Question keeps the reasons linking found, which
// are worked out again whenever what the Book gives for it changes. A new
// Question, or one whose reasons or key changed, is a draft: enrichment and
// the Publish Gate decide whether it is published or held.

// A Question as compared with new items.
export interface BankEntry {
  readonly id: string
  readonly hash: string
  readonly trigrams: ReadonlySet<string>
  readonly key: string | null
}

// The Questions of a Section, other than withdrawn ones, for comparing.
export const loadBank = (section: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const rows = yield* db.select({
      id: questions.id,
      hash: questions.normalizedHash,
      text: questions.normalizedText,
      key: parts.key
    }).from(questions)
      .leftJoin(parts, and(eq(parts.questionId, questions.id), eq(parts.position, 0)))
      .where(and(eq(questions.section, section), ne(questions.status, "withdrawn")))
      .pipe(Effect.orDie)
    return rows.map((row): BankEntry => ({ id: row.id, hash: row.hash, trigrams: trigrams(row.text), key: row.key }))
  })

export type Linked = "created" | "merged" | "relinked" | "unchanged" | "skipped"

export interface QuestionOrigin {
  readonly section: string
  readonly questionType: string
  readonly model: string
  readonly promptVersion: string
}

const LinkReasons = Schema.Array(Schema.Struct({ code: Schema.String, detail: Schema.String }))
const decodeLinkReasons = Schema.decodeUnknownOption(Schema.fromJsonString(LinkReasons))
export const readLinkReasons = (json: string) =>
  Option.getOrElse(decodeLinkReasons(json), () => []) as ReadonlyArray<Reason>

// Near matches and identical text with another key, which stay until the
// Curator settles them.
export const RepeatCodes: ReadonlySet<ReasonCode> = new Set(["near-match", "same-text-other-key"])

// Problems that leave an item's text or figure in doubt.
const UnsureCodes: ReadonlySet<ReasonCode> = new Set(["structure", "render", "figure"])

// Opens a review item for a Question, or updates the open one.
export const holdForReview = (questionId: string, reasons: ReadonlyArray<Reason>, relatedQuestionId: string | null) =>
  Effect.gen(function*() {
    const db = yield* Db
    const now = yield* Clock.currentTimeMillis
    const [open] = yield* db.select({ id: reviewItems.id }).from(reviewItems)
      .where(and(eq(reviewItems.questionId, questionId), eq(reviewItems.status, "open")))
    if (open !== undefined) {
      yield* db.update(reviewItems).set({ reasons: JSON.stringify(reasons), relatedQuestionId })
        .where(eq(reviewItems.id, open.id))
      return
    }
    yield* db.insert(reviewItems).values({
      id: crypto.randomUUID(),
      questionId,
      reasons: JSON.stringify(reasons),
      relatedQuestionId,
      status: "open",
      createdAt: now
    })
  })

// Sources whose Book gives another key than the Question's. A key the
// Curator overrode settles them.
const sourceKeyReasons = (questionId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const [part] = yield* db.select({ key: parts.key, keyBasis: parts.keyBasis }).from(parts)
      .where(and(eq(parts.questionId, questionId), eq(parts.position, 0)))
    if (part === undefined || part.keyBasis === "override") return []
    const given = yield* db.select({
      title: books.title,
      set: sources.set,
      number: sources.number,
      bookKey: sources.bookKey
    }).from(sources).innerJoin(books, eq(books.id, sources.bookId))
      .where(and(eq(sources.questionId, questionId), isNotNull(sources.bookKey)))
      .orderBy(asc(sources.createdAt))
    return given.filter((source) => source.bookKey !== part.key).map((source): Reason => ({
      code: "source-key",
      detail: `${source.title}, ${source.set}, question ${source.number} gives the key ${source.bookKey}; this Question's key is ${
        part.key ?? "not known"
      }.`
    }))
  })

// Keeps a Question's reasons. When they or its key changed, it goes back to
// draft for the Publish Gate, and a changed key owes it new key-dependent
// content: its Approaches and wrong-option notes. Its tags, Difficulty
// estimate and solver runs stay. A withdrawn Question only keeps its reasons.
export const settle = (
  questionId: string,
  reasons: ReadonlyArray<Reason>,
  relatedQuestionId: string | null,
  keyChanged: boolean
) =>
  Effect.gen(function*() {
    const db = yield* Db
    const now = yield* Clock.currentTimeMillis
    const [question] = yield* db.select().from(questions).where(eq(questions.id, questionId))
    if (question === undefined) return
    const encoded = JSON.stringify(reasons)
    const changed = keyChanged || encoded !== question.linkReasons || relatedQuestionId !== question.relatedQuestionId
    if (!changed) return
    yield* db.update(questions)
      .set({
        linkReasons: encoded,
        relatedQuestionId,
        ...(question.status === "withdrawn" ? {} : { status: "draft" }),
        ...(keyChanged && question.enrichment === "done" ? { enrichment: "key-content" } : {}),
        updatedAt: now
      })
      .where(eq(questions.id, questionId))
  })

// Works out a Question's source keys again, as when another Book's item for
// it changed or left the map, or the Curator merged a Question into it.
export const recheckSources = (questionId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const [question] = yield* db.select({ linkReasons: questions.linkReasons, related: questions.relatedQuestionId })
      .from(questions).where(eq(questions.id, questionId))
    if (question === undefined) return
    const before = readLinkReasons(question.linkReasons)
    const reasons = [...before.filter((reason) => reason.code !== "source-key"), ...yield* sourceKeyReasons(questionId)]
    yield* settle(questionId, reasons, question.related, false)
  })

// Whether a Question named by the bank is still there to match against: the
// Curator may have merged or withdrawn it since the bank was read.
const stillInBank = (id: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const [row] = yield* db.select({ status: questions.status }).from(questions).where(eq(questions.id, id))
    return row !== undefined && row.status !== "withdrawn"
  })

export const linkCandidate = (
  input: {
    readonly bookId: string
    readonly set: string
    readonly mapVersion: number
    readonly candidate: Candidate
    readonly origin: QuestionOrigin
  },
  bank: Array<BankEntry>
): Effect.Effect<Linked, never, Db> =>
  Effect.gen(function*() {
    const db = yield* Db
    const { bookId, set, mapVersion, candidate, origin } = input
    const now = yield* Clock.currentTimeMillis
    return yield* db.transaction(() =>
      Effect.gen(function*() {
        const [source] = yield* db.select().from(sources)
          .where(and(eq(sources.bookId, bookId), eq(sources.page, candidate.page), eq(sources.number, candidate.number)))
        if (source !== undefined) {
          const changed = source.bookKey !== candidate.key || source.explanation !== candidate.explanation ||
            source.explanationAnswer !== candidate.explanationAnswer || source.bookLabel !== candidate.label
          yield* db.update(sources)
            .set({
              set,
              bookKey: candidate.key,
              explanation: candidate.explanation,
              explanationAnswer: candidate.explanationAnswer,
              bookLabel: candidate.label,
              mapVersion
            })
            .where(eq(sources.id, source.id))
          if (!changed) return "unchanged" as const
          // Another Book's item for the Question: only its key bears on it.
          if (source.merged) {
            if (source.bookKey !== candidate.key) yield* recheckSources(source.questionId)
            return "relinked" as const
          }
          // The Question's own item: its key and label follow the Book,
          // unless the Curator overrode the key, and its reasons are worked
          // out again, keeping the repeats the Curator has not settled.
          yield* db.update(questions).set({ bookLabel: candidate.label, updatedAt: now })
            .where(eq(questions.id, source.questionId))
          const [part] = yield* db.select().from(parts)
            .where(and(eq(parts.questionId, source.questionId), eq(parts.position, 0)))
          const keyChanged = part !== undefined && part.keyBasis !== "override" && part.key !== candidate.key
          if (keyChanged) {
            yield* db.update(parts).set({ key: candidate.key, keyBasis: candidate.key === null ? null : "book" })
              .where(eq(parts.id, part.id))
          }
          const [question] = yield* db.select({ linkReasons: questions.linkReasons, related: questions.relatedQuestionId })
            .from(questions).where(eq(questions.id, source.questionId))
          const repeats = readLinkReasons(question?.linkReasons ?? "[]").filter((reason) => RepeatCodes.has(reason.code))
          yield* settle(
            source.questionId,
            [...candidateProblems(candidate), ...repeats, ...yield* sourceKeyReasons(source.questionId)],
            question?.related ?? null,
            keyChanged
          )
          return "relinked" as const
        }

        const text = comparableText(candidate.stem, candidate.options)
        const hash = sha256(text)
        const pieces = trigrams(text)
        const problems = candidateProblems(candidate)
        // An item whose text may be wrong, or that needs a figure, is never
        // joined to another unseen: junk transcriptions look alike, and the
        // same words can ask about a different figure.
        const unsure = problems.some((reason) => UnsureCodes.has(reason.code))
        // Matches only Questions still in the bank.
        for (const entry of [...bank]) {
          if (!(yield* stillInBank(entry.id))) bank.splice(bank.indexOf(entry), 1)
        }
        const exact = bank.find((entry) => entry.hash === hash)

        const addSource = (questionId: string, merged: boolean) =>
          db.insert(sources).values({
            id: crypto.randomUUID(),
            questionId,
            bookId,
            set,
            number: candidate.number,
            page: candidate.page,
            bookKey: candidate.key,
            explanation: candidate.explanation,
            explanationAnswer: candidate.explanationAnswer,
            bookLabel: candidate.label,
            merged,
            mapVersion,
            createdAt: now
          })

        // The same Question again: another Source for it.
        if (exact !== undefined && !unsure && (candidate.key === null || exact.key === candidate.key)) {
          yield* addSource(exact.id, true)
          return "merged" as const
        }
        // The same Question, which had no key: it takes this Book's key and
        // goes back through the Publish Gate.
        if (exact !== undefined && !unsure && exact.key === null) {
          yield* addSource(exact.id, true)
          const [part] = yield* db.select().from(parts).where(and(eq(parts.questionId, exact.id), eq(parts.position, 0)))
          if (part !== undefined && part.keyBasis !== "override") {
            yield* db.update(parts).set({ key: candidate.key, keyBasis: "book" }).where(eq(parts.id, part.id))
          }
          const [question] = yield* db.select({ linkReasons: questions.linkReasons, related: questions.relatedQuestionId })
            .from(questions).where(eq(questions.id, exact.id))
          const kept = readLinkReasons(question?.linkReasons ?? "[]")
            .filter((reason) => reason.code !== "no-key" && reason.code !== "source-key")
          yield* settle(exact.id, [...kept, ...yield* sourceKeyReasons(exact.id)], question?.related ?? null, true)
          bank.splice(bank.indexOf(exact), 1, { ...exact, key: candidate.key })
          return "merged" as const
        }

        const reasons: Array<Reason> = [...problems]
        let related: string | null = null
        if (exact !== undefined) {
          reasons.push(
            exact.key === candidate.key
              ? {
                code: "near-match",
                detail: "It has the same words as another Question, but its text or figure is in doubt: check that it asks the same."
              }
              : {
                code: "same-text-other-key",
                detail: `Another Question has the same text with the key ${exact.key ?? "unknown"}; this one has ${
                  candidate.key ?? "none"
                }.`
              }
          )
          related = exact.id
        } else {
          let best: { readonly id: string; readonly score: number } | undefined
          for (const entry of bank) {
            const score = similarity(pieces, entry.trigrams)
            if (score >= NearMatch && (best === undefined || score > best.score)) best = { id: entry.id, score }
          }
          if (best !== undefined) {
            reasons.push({
              code: "near-match",
              detail: best.score > 0.999
                ? "It is another Question with different numbers: a Variant, or the same Question?"
                : `It is ${Math.round(best.score * 100)}% like another Question: a Variant, or the same Question?`
            })
            related = best.id
          }
        }

        const [taxonomy] = yield* db.select({ version: max(taxonomyVersions.version) }).from(taxonomyVersions)
        const questionId = crypto.randomUUID()
        const partId = crypto.randomUUID()
        yield* db.insert(questions).values({
          id: questionId,
          section: origin.section,
          questionType: origin.questionType,
          stem: candidate.stem,
          status: "draft",
          normalizedText: text,
          normalizedHash: hash,
          bookLabel: candidate.label,
          taxonomyVersion: taxonomy?.version ?? 1,
          model: origin.model,
          promptVersion: origin.promptVersion,
          linkReasons: JSON.stringify(reasons),
          relatedQuestionId: related,
          enrichment: "pending",
          createdAt: now,
          updatedAt: now
        })
        yield* db.insert(parts).values({
          id: partId,
          questionId,
          position: 0,
          kind: "single-choice",
          prompt: null,
          key: candidate.key,
          keyBasis: candidate.key === null ? null : "book"
        })
        if (candidate.options.length > 0) {
          yield* db.insert(options).values(candidate.options.map((option, position) => ({
            partId,
            position,
            label: option.label,
            text: option.text
          })))
        }
        yield* addSource(questionId, false)
        bank.push({ id: questionId, hash, trigrams: pieces, key: candidate.key })
        return "created" as const
      })
    ).pipe(Effect.orDie)
  })

export const recordSkip = (bookId: string, set: string, mapVersion: number, skip: Skip) =>
  Effect.gen(function*() {
    const db = yield* Db
    yield* db.insert(bookSkips)
      .values({ bookId, set, number: skip.number, page: skip.page, reason: skip.reason, mapVersion })
      .onConflictDoUpdate({
        target: [bookSkips.bookId, bookSkips.page, bookSkips.number],
        set: { set, reason: skip.reason, mapVersion }
      })
      .pipe(Effect.orDie)
    return "skipped" as const
  })

// A page extraction could not read, held for the Curator.
export const holdUnreadPage = (bookId: string, page: number, detail: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const now = yield* Clock.currentTimeMillis
    yield* db.insert(reviewItems).values({
      id: crypto.randomUUID(),
      questionId: null,
      bookId,
      page,
      reasons: JSON.stringify([{ code: "unread-page", detail }]),
      relatedQuestionId: null,
      status: "open",
      createdAt: now
    }).onConflictDoNothing().pipe(Effect.orDie)
  })

// Pages already held for the Curator, so the run does not hold them twice.
export const heldPages = (bookId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const rows = yield* db.select({ page: reviewItems.page }).from(reviewItems)
      .where(and(eq(reviewItems.bookId, bookId), isNull(reviewItems.questionId)))
      .pipe(Effect.orDie)
    return new Set(rows.flatMap((row) => (row.page === null ? [] : [row.page])))
  })

// After a Book Map version is linked: items it no longer produces have left
// the map. A Question left with no Source is withdrawn; one with Sources from
// other Books keeps them. Skips and unread pages the map no longer covers go
// too.
export const retireStale = (bookId: string, mapVersion: number, unreadPages: ReadonlySet<number>) =>
  Effect.gen(function*() {
    const db = yield* Db
    const now = yield* Clock.currentTimeMillis
    return yield* db.transaction(() =>
      Effect.gen(function*() {
        const stale = yield* db.select().from(sources)
          .where(and(eq(sources.bookId, bookId), lt(sources.mapVersion, mapVersion)))
        const touched = new Set(stale.map((source) => source.questionId))
        for (const source of stale) yield* db.delete(sources).where(eq(sources.id, source.id))
        for (const questionId of touched) {
          const remaining = yield* db.select().from(sources).where(eq(sources.questionId, questionId))
            .orderBy(asc(sources.createdAt))
          if (remaining.length === 0) {
            yield* db.update(questions).set({ status: "withdrawn", updatedAt: now }).where(eq(questions.id, questionId))
            yield* db.update(reviewItems).set({ status: "decided", decision: "withdrawn", decidedAt: now })
              .where(and(eq(reviewItems.questionId, questionId), eq(reviewItems.status, "open")))
            continue
          }
          if (remaining.every((source) => source.merged)) {
            yield* db.update(sources).set({ merged: false }).where(eq(sources.id, remaining[0]!.id))
          }
          yield* recheckSources(questionId)
        }
        yield* db.delete(bookSkips).where(and(eq(bookSkips.bookId, bookId), lt(bookSkips.mapVersion, mapVersion)))
        const pages = yield* db.select({ id: reviewItems.id, page: reviewItems.page }).from(reviewItems)
          .where(and(eq(reviewItems.bookId, bookId), isNull(reviewItems.questionId), eq(reviewItems.status, "open")))
        for (const item of pages) {
          if (item.page !== null && !unreadPages.has(item.page)) {
            yield* db.update(reviewItems).set({ status: "decided", decision: "dismissed", decidedAt: now })
              .where(eq(reviewItems.id, item.id))
          }
        }
        return stale.length
      })
    ).pipe(Effect.orDie)
  })

