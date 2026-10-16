import { and, eq, isNull, max, ne } from "drizzle-orm"
import { Clock, Effect } from "effect"
import { sha256 } from "../access/tokens.ts"
import { Db } from "../db/Database.ts"
import { bookSkips, options, parts, questions, reviewItems, sources, taxonomyVersions } from "../db/schema.ts"
import {
  type Candidate,
  candidateProblems,
  comparableText,
  NearMatch,
  type Reason,
  similarity,
  type Skip,
  trigrams
} from "./linking.ts"

// Writing linked items into the Question Bank. Each item is written in one
// transaction and found again by its Book, set and number, so a run that
// stops part way, or a Book Map fix, writes each item once.

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

const encodeReasons = (reasons: ReadonlyArray<Reason>) => JSON.stringify(reasons)

export interface QuestionOrigin {
  readonly section: string
  readonly questionType: string
  readonly model: string
  readonly promptVersion: string
}

// Opens a review item for a Question, or updates the open one.
const holdForReview = (questionId: string, reasons: ReadonlyArray<Reason>, relatedQuestionId: string | null) =>
  Effect.gen(function*() {
    const db = yield* Db
    const now = yield* Clock.currentTimeMillis
    const [open] = yield* db.select({ id: reviewItems.id }).from(reviewItems)
      .where(and(eq(reviewItems.questionId, questionId), eq(reviewItems.status, "open")))
    if (open !== undefined) {
      yield* db.update(reviewItems).set({ reasons: encodeReasons(reasons), relatedQuestionId })
        .where(eq(reviewItems.id, open.id))
      return
    }
    yield* db.insert(reviewItems).values({
      id: crypto.randomUUID(),
      questionId,
      reasons: encodeReasons(reasons),
      relatedQuestionId,
      status: "open",
      createdAt: now
    })
  })

export const linkCandidate = (
  input: {
    readonly bookId: string
    readonly set: string
    readonly candidate: Candidate
    readonly origin: QuestionOrigin
  },
  bank: Array<BankEntry>
): Effect.Effect<Linked, never, Db> =>
  Effect.gen(function*() {
    const db = yield* Db
    const { bookId, set, candidate, origin } = input
    const now = yield* Clock.currentTimeMillis
    return yield* db.transaction(() =>
      Effect.gen(function*() {
        const [source] = yield* db.select().from(sources)
          .where(and(eq(sources.bookId, bookId), eq(sources.set, set), eq(sources.number, candidate.number)))
        if (source !== undefined) {
          const changed = source.bookKey !== candidate.key || source.explanation !== candidate.explanation ||
            source.bookLabel !== candidate.label
          if (!changed) return "unchanged" as const
          yield* db.update(sources)
            .set({ bookKey: candidate.key, explanation: candidate.explanation, bookLabel: candidate.label })
            .where(eq(sources.id, source.id))
          if (source.merged) return "relinked" as const
          // The item is the Question's own source: its key and label follow
          // the Book, unless the Curator overrode the key.
          yield* db.update(questions).set({ bookLabel: candidate.label, updatedAt: now })
            .where(eq(questions.id, source.questionId))
          const [part] = yield* db.select().from(parts)
            .where(and(eq(parts.questionId, source.questionId), eq(parts.position, 0)))
          if (part !== undefined && part.keyBasis !== "override" && part.key !== candidate.key) {
            yield* db.update(parts).set({ key: candidate.key, keyBasis: candidate.key === null ? null : "book" })
              .where(eq(parts.id, part.id))
            const [question] = yield* db.select({ status: questions.status }).from(questions)
              .where(eq(questions.id, source.questionId))
            if (question?.status !== "withdrawn") {
              yield* db.update(questions).set({ status: "held", updatedAt: now }).where(eq(questions.id, source.questionId))
              yield* holdForReview(source.questionId, [
                ...candidateProblems(candidate),
                {
                  code: "key-changed",
                  detail: `A Book Map fix changed its key from ${part.key ?? "none"} to ${candidate.key ?? "none"}.`
                }
              ], null)
            }
          }
          return "relinked" as const
        }

        const text = comparableText(candidate.stem, candidate.options)
        const hash = sha256(text)
        const pieces = trigrams(text)
        const exact = bank.find((entry) => entry.hash === hash)
        // The same Question again: another Source for it.
        if (exact !== undefined && (candidate.key === null || exact.key === candidate.key)) {
          yield* db.insert(sources).values({
            id: crypto.randomUUID(),
            questionId: exact.id,
            bookId,
            set,
            number: candidate.number,
            page: candidate.page,
            bookKey: candidate.key,
            explanation: candidate.explanation,
            bookLabel: candidate.label,
            merged: true,
            createdAt: now
          })
          return "merged" as const
        }

        const reasons: Array<Reason> = [...candidateProblems(candidate)]
        let related: string | null = null
        if (exact !== undefined) {
          reasons.push({
            code: "same-text-other-key",
            detail: `Another Question has the same text with the key ${exact.key ?? "unknown"}; this one has ${candidate.key}.`
          })
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
          status: "held",
          normalizedText: text,
          normalizedHash: hash,
          bookLabel: candidate.label,
          taxonomyVersion: taxonomy?.version ?? 1,
          model: origin.model,
          promptVersion: origin.promptVersion,
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
        yield* db.insert(sources).values({
          id: crypto.randomUUID(),
          questionId,
          bookId,
          set,
          number: candidate.number,
          page: candidate.page,
          bookKey: candidate.key,
          explanation: candidate.explanation,
          bookLabel: candidate.label,
          merged: false,
          createdAt: now
        })
        yield* holdForReview(questionId, reasons, related)
        bank.push({ id: questionId, hash, trigrams: pieces, key: candidate.key })
        return "created" as const
      })
    ).pipe(Effect.orDie)
  })

export const recordSkip = (bookId: string, set: string, skip: Skip) =>
  Effect.gen(function*() {
    const db = yield* Db
    yield* db.insert(bookSkips).values({ bookId, set, number: skip.number, page: skip.page, reason: skip.reason })
      .onConflictDoNothing()
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
      reasons: encodeReasons([{ code: "unread-page", detail }]),
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
