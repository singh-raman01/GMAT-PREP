import { and, asc, eq, isNotNull, isNull, lt, max, ne, sql } from "drizzle-orm"
import { Clock, Effect, Option, Schema } from "effect"
import { sha256 } from "../access/tokens.ts"
import { Db } from "../db/Database.ts"
import { joinedKey } from "../../api/keys.ts"
import { normalizeText, renderProblem } from "../../api/richText.ts"
import {
  books,
  bookSkips,
  datasets,
  goldenQuestions,
  options,
  parts,
  questions,
  reviewItems,
  solverRuns,
  sources,
  stimuli,
  taxonomyVersions
} from "../db/schema.ts"
import { encodeColumns, encodeFigure, encodeRows, type FigureSource } from "../stimuli/stimuli.ts"
import {
  type Candidate,
  candidateProblems,
  comparableText,
  type ContentDraft,
  datasetOfDraft,
  isPassageRender,
  NearMatch,
  nearText,
  type Reason,
  type ReasonCode,
  similarity,
  type Skip,
  type StimulusDraft,
  type TableDraft,
  trigrams
} from "./linking.ts"

// Writing linked items into the Question Bank. Each item is written in one
// transaction and found again by its Book, the page it starts on and its
// number, so a run that stops part way, a Book Map fix or a renamed set
// writes each item once. A Question keeps the reasons linking found, which
// are worked out again whenever what the Book gives for it changes. A new
// Question, or one whose reasons or key changed, is a draft: enrichment and
// the Publish Gate decide whether it is published or held.

// A Question as compared with new items. A passage's Questions are compared
// only with Questions on the same passage, or on a passage nearly like it.
export interface BankEntry {
  readonly id: string
  readonly hash: string
  // Of its near-match text; see nearText.
  readonly trigrams: ReadonlySet<string>
  readonly key: string | null
  readonly stimulusId: string | null
}

// The Questions of a Section, other than withdrawn ones, for comparing.
export const loadBank = (section: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const rows = yield* db.select({
      id: questions.id,
      hash: questions.normalizedHash,
      questionType: questions.questionType,
      stem: questions.stem,
      text: questions.normalizedText,
      stimulusId: questions.stimulusId
    }).from(questions)
      .where(and(eq(questions.section, section), ne(questions.status, "withdrawn")))
      .pipe(Effect.orDie)
    const keyRows = yield* db.select({ questionId: parts.questionId, key: parts.key }).from(parts)
      .innerJoin(questions, eq(questions.id, parts.questionId))
      .where(and(eq(questions.section, section), ne(questions.status, "withdrawn")))
      .orderBy(asc(parts.position))
      .pipe(Effect.orDie)
    const keys = Map.groupBy(keyRows, (row) => row.questionId)
    return rows.map((row): BankEntry => ({
      id: row.id,
      hash: row.hash,
      trigrams: trigrams(row.questionType === "di.ds" ? nearText(row.questionType, row.stem, []) : row.text),
      key: joinedKey((keys.get(row.id) ?? []).map((part) => part.key)),
      stimulusId: row.stimulusId
    }))
  })

// A Question's Parts, with its key as Sources give one.
export const keyOf = (questionId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const rows = yield* db.select().from(parts).where(eq(parts.questionId, questionId)).orderBy(asc(parts.position))
    return {
      parts: rows,
      key: joinedKey(rows.map((part) => part.key)),
      // The Curator overrode a Part's key, which settles every question
      // about the key.
      overridden: rows.some((part) => part.keyBasis === "override")
    }
  })

const tableText = (table: TableDraft) =>
  [table.columns.map((column) => `${column.name} ${column.type} ${column.unit}`).join(" | "), ...table.rows.map((row) =>
    row.join(" | ")
  )].join("\n")

// What a Stimulus is compared by, so the same passage, table or chart from
// two Books is one Stimulus. A figure kept as an image is its own, and one
// whose page could not be drawn is its item's own.
const contentHash = (content: ContentDraft, figure: FigureSource | undefined, item: string): string => {
  switch (content.kind) {
    case "passage":
      return sha256(normalizeText(content.body))
    case "table":
      return sha256(`table|${normalizeText(content.body)}|${tableText(content.table)}`)
    case "chart":
      return sha256(`chart|${normalizeText(content.body)}|${tableText(content.table)}|${JSON.stringify(content.spec)}`)
    case "figure":
      return figure === undefined
        ? sha256(`figure|item|${item}`)
        : sha256(`figure|${figure.bookId}|${figure.page}|${figure.top}|${figure.bottom}|${figure.file}`)
  }
}

const stimulusHash = (draft: StimulusDraft, figure: FigureSource | undefined, item: string) =>
  draft.kind === "tabs"
    ? sha256(`tabs|${draft.tabs.map((tab) => `${normalizeText(tab.title)}:${contentHash(tab, figure, item)}`).join("|")}`)
    : contentHash(draft, figure, item)

const insertContent = (
  content: ContentDraft,
  hash: string,
  now: number,
  figure: FigureSource | undefined,
  tab?: { readonly parentId: string; readonly position: number; readonly title: string }
) =>
  Effect.gen(function*() {
    const db = yield* Db
    let datasetId: string | null = null
    if (content.kind === "table" || content.kind === "chart") {
      datasetId = crypto.randomUUID()
      const dataset = datasetOfDraft(content.table)
      yield* db.insert(datasets).values({
        id: datasetId,
        columns: encodeColumns(dataset.columns),
        rows: encodeRows(dataset.rows),
        origin: "book",
        createdAt: now
      })
    }
    const id = crypto.randomUUID()
    yield* db.insert(stimuli).values({
      id,
      kind: content.kind,
      body: content.body,
      normalizedHash: hash,
      datasetId,
      chartSpec: content.kind === "chart" ? JSON.stringify(content.spec) : null,
      figure: content.kind === "figure" && figure !== undefined ? encodeFigure(figure) : null,
      parentId: tab?.parentId ?? null,
      position: tab?.position ?? null,
      title: tab?.title ?? null,
      createdAt: now
    })
    return id
  })

// A stored passage as compared with a new one.
export interface PassageEntry {
  readonly id: string
  readonly trigrams: ReadonlySet<string>
}

// Every stored passage, other than an MSR set's tabs, for finding one a new
// passage nearly copies.
export const loadPassages = Effect.gen(function*() {
  const db = yield* Db
  const rows = yield* db.select({ id: stimuli.id, body: stimuli.body }).from(stimuli)
    .where(and(eq(stimuli.kind, "passage"), isNull(stimuli.parentId)))
    .pipe(Effect.orDie)
  return rows.map((row): PassageEntry => ({ id: row.id, trigrams: trigrams(normalizeText(row.body)) }))
})

// The stored Stimulus with this content, or a new one. The same passage from
// two Books compares by its normalized text, and the text shown is one that
// renders: a stored passage that does not takes this reading's text when it
// does. shown is the Stimulus as Learners will see it, and repaired says the
// stored text was replaced.
const stimulusFor = (
  draft: StimulusDraft,
  now: number,
  figure: FigureSource | undefined,
  // The item it is for, by Book, page and number.
  item: string,
  passages: Array<PassageEntry>
) =>
  Effect.gen(function*() {
    const db = yield* Db
    const hash = stimulusHash(draft, figure, item)
    const [found] = yield* db.select({ id: stimuli.id, body: stimuli.body }).from(stimuli)
      .where(and(eq(stimuli.normalizedHash, hash), isNull(stimuli.parentId))).limit(1)
    if (found !== undefined) {
      if (draft.kind !== "passage") return { id: found.id, hash, shown: draft, repaired: false }
      const repaired = renderProblem(found.body) !== undefined && renderProblem(draft.body) === undefined
      if (repaired) yield* db.update(stimuli).set({ body: draft.body }).where(eq(stimuli.id, found.id))
      return { id: found.id, hash, shown: { ...draft, body: repaired ? draft.body : found.body }, repaired }
    }
    if (draft.kind !== "tabs") {
      const id = yield* insertContent(draft, hash, now, figure)
      if (draft.kind === "passage") passages.push({ id, trigrams: trigrams(normalizeText(draft.body)) })
      return { id, hash, shown: draft, repaired: false }
    }
    const id = crypto.randomUUID()
    yield* db.insert(stimuli).values({ id, kind: "tabs", body: "", normalizedHash: hash, createdAt: now })
    for (const [position, tab] of draft.tabs.entries()) {
      yield* insertContent(tab, contentHash(tab, figure, item), now, figure, { parentId: id, position, title: tab.title })
    }
    return { id, hash, shown: draft, repaired: false }
  })

// Stored passages a passage nearly copies, the closest first, as another
// edition's or a rescan's reading of it with a word changed would.
const nearPassages = (stimulusId: string, body: string, passages: ReadonlyArray<PassageEntry>) => {
  const pieces = trigrams(normalizeText(body))
  return passages.filter((entry) => entry.id !== stimulusId)
    .map((entry) => ({ id: entry.id, score: similarity(pieces, entry.trigrams) }))
    .filter((entry) => entry.score >= NearMatch)
    .toSorted((a, b) => b.score - a.score)
}

// After a passage's stored text was repaired, its Questions held only because
// it did not render go back to the Publish Gate. Returns those with no
// Source in the Book, which its run will not check.
const passageRepaired = (stimulusId: string, bookId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const held = yield* db.select({ id: questions.id, linkReasons: questions.linkReasons, related: questions.relatedQuestionId })
      .from(questions).where(and(eq(questions.stimulusId, stimulusId), ne(questions.status, "withdrawn")))
    const sentBack: Array<string> = []
    for (const question of held) {
      const reasons = readLinkReasons(question.linkReasons)
      if (!reasons.some(isPassageRender)) continue
      yield* settle(question.id, reasons.filter((reason) => !isPassageRender(reason)), question.related, { regate: true })
      const [inBook] = yield* db.select({ id: sources.id }).from(sources)
        .where(and(eq(sources.questionId, question.id), eq(sources.bookId, bookId))).limit(1)
      if (inBook === undefined) sentBack.push(question.id)
    }
    return sentBack
  })

export type Linked = "created" | "merged" | "relinked" | "unchanged" | "skipped"

// The model and prompt that read the Question's page.
export interface QuestionOrigin {
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

// Reasons about the key, which a Key Override settles.
export const KeyCodes: ReadonlySet<string> = new Set<ReasonCode>(["no-key", "key-conflict", "source-key"])

// Problems that leave an item's text or figure in doubt.
export const UnsureCodes: ReadonlySet<string> = new Set<ReasonCode>(["structure", "render", "figure"])

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
    const own = yield* keyOf(questionId)
    if (own.parts.length === 0 || own.overridden) return []
    const part = { key: own.key }
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

// The explanation a Question's Approaches are written with: its own
// Source's, else the oldest other Source's that has one. With it, the answer
// it reaches: the one it states, else its own Book's key for the item. One
// that states none is not taken to reach a key from elsewhere, such as a Key
// Override.
export const explanationOf = (questionId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const given = yield* db.select({
      explanation: sources.explanation,
      answer: sources.explanationAnswer,
      bookKey: sources.bookKey
    }).from(sources).where(eq(sources.questionId, questionId))
      .orderBy(asc(sources.merged), asc(sources.createdAt), asc(sql`${sources}.rowid`))
    const explained = given.find((source) => source.explanation !== null)
    return {
      explanation: explained?.explanation ?? null,
      reaches: explained === undefined ? null : explained.answer ?? explained.bookKey
    }
  })

type Explanation = Effect.Success<ReturnType<typeof explanationOf>>

const sameExplanation = (a: Explanation, b: Explanation) => a.explanation === b.explanation && a.reaches === b.reaches

// What changed about a Question besides its reasons: its key or the Book's
// explanation, which its Approaches and wrong-option notes are written
// against, or something else the Publish Gate reads, such as its Book Label.
export interface Changes {
  readonly content?: boolean
  readonly regate?: boolean
}

// Keeps a Question's reasons. When anything the Publish Gate reads changed,
// it goes back to draft for the gate, and a changed key or explanation owes
// it new Approaches and wrong-option notes. Its tags, Difficulty estimate and
// solver runs stay. A withdrawn Question only keeps its reasons.
export const settle = (
  questionId: string,
  reasons: ReadonlyArray<Reason>,
  relatedQuestionId: string | null,
  changes: Changes = {}
) =>
  Effect.gen(function*() {
    const db = yield* Db
    const now = yield* Clock.currentTimeMillis
    const [question] = yield* db.select().from(questions).where(eq(questions.id, questionId))
    if (question === undefined) return
    const encoded = JSON.stringify(reasons)
    const changed = changes.content === true || changes.regate === true || encoded !== question.linkReasons ||
      relatedQuestionId !== question.relatedQuestionId
    if (!changed) return
    yield* db.update(questions)
      .set({
        linkReasons: encoded,
        relatedQuestionId,
        ...(question.status === "withdrawn" ? {} : { status: "draft" }),
        ...(changes.content === true && question.enrichment === "done" ? { enrichment: "key-content" } : {}),
        updatedAt: now
      })
      .where(eq(questions.id, questionId))
  })

// Works out a Question's source keys again, as when another Book's item for
// it changed or left the map, or the Curator merged a Question into it.
export const recheckSources = (questionId: string, changes: Changes = {}) =>
  Effect.gen(function*() {
    const db = yield* Db
    const [question] = yield* db.select({ linkReasons: questions.linkReasons, related: questions.relatedQuestionId })
      .from(questions).where(eq(questions.id, questionId))
    if (question === undefined) return
    const before = readLinkReasons(question.linkReasons)
    const reasons = [...before.filter((reason) => reason.code !== "source-key"), ...yield* sourceKeyReasons(questionId)]
    yield* settle(questionId, reasons, question.related, changes)
  })

// Whether a Question named by the bank is still there to match against: the
// Curator may have merged or withdrawn it since the bank was read.
const stillInBank = (id: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const [row] = yield* db.select({ status: questions.status }).from(questions).where(eq(questions.id, id))
    return row !== undefined && row.status !== "withdrawn"
  })

// Moves a Question to another Stimulus, or to none: its hash follows the
// Stimulus, its Mock Reserve decision is made again with its new passage's,
// and its tags, solves, Approaches and notes are done again, since they read
// the passage. Returns its new hash.
export const moveQuestion = (questionId: string, stimulus: { readonly id: string; readonly hash: string } | null) =>
  Effect.gen(function*() {
    const db = yield* Db
    const [question] = yield* db.select({ text: questions.normalizedText, enrichment: questions.enrichment })
      .from(questions).where(eq(questions.id, questionId))
    if (question === undefined) return undefined
    const hash = sha256(stimulus === null ? question.text : `${stimulus.hash}|${question.text}`)
    yield* db.update(questions).set({
      stimulusId: stimulus?.id ?? null,
      normalizedHash: hash,
      reserve: null,
      reserveDecidedAt: null,
      releasedAt: null,
      taggedAt: null,
      ...(question.enrichment === "done" ? { enrichment: "key-content" } : {})
    }).where(eq(questions.id, questionId))
    yield* db.delete(solverRuns).where(eq(solverRuns.questionId, questionId))
    return hash
  })

// A Source leaves its Question, as when its Book's item turns out to ask
// about another passage: one of the Question's other Sources becomes its
// own when none is, its source keys are worked out again, and its Approaches
// are written again if the explanation they used left. A golden-set approval
// of the item goes with it.
const leaveQuestion = (source: typeof sources.$inferSelect) =>
  Effect.gen(function*() {
    const db = yield* Db
    const questionId = source.questionId
    const explainedBefore = yield* explanationOf(questionId)
    yield* db.delete(sources).where(eq(sources.id, source.id))
    const remaining = yield* db.select().from(sources).where(eq(sources.questionId, questionId))
      .orderBy(asc(sources.createdAt), asc(sql`${sources}.rowid`))
    if (remaining.length > 0 && remaining.every((each) => each.merged)) {
      yield* db.update(sources).set({ merged: false }).where(eq(sources.id, remaining[0]!.id))
    }
    yield* recheckSources(questionId, { content: !sameExplanation(explainedBefore, yield* explanationOf(questionId)) })
    yield* db.delete(goldenQuestions)
      .where(and(eq(goldenQuestions.questionId, questionId), eq(goldenQuestions.bookId, source.bookId)))
  })

// The repeat a Question is of, among the Questions about its Stimulus: the
// same words, else the most alike at least NearMatch.
export const repeatOf = (questionId: string, hash: string, pieces: ReadonlySet<string>, stimulusId: string | null, bank: ReadonlyArray<BankEntry>) => {
  const twin = bank.find((entry) => entry.hash === hash && entry.id !== questionId)
  if (twin !== undefined) {
    return {
      related: twin.id,
      reason: {
        code: "near-match",
        detail: "It has the same words as another Question about the same passage: the same Question, or a Variant?"
      } satisfies Reason
    }
  }
  const best = bank.filter((entry) => entry.id !== questionId && entry.stimulusId === stimulusId)
    .map((entry) => ({ id: entry.id, score: similarity(pieces, entry.trigrams) }))
    .filter((entry) => entry.score >= NearMatch)
    .toSorted((a, b) => b.score - a.score)[0]
  return best === undefined ? undefined : {
    related: best.id,
    reason: {
      code: "near-match",
      detail: `It is ${Math.round(best.score * 100)}% like another Question: a Variant, or the same Question?`
    } satisfies Reason
  }
}

// What linking an item did, and the Questions it sent back to the Publish
// Gate that have no Source in the Book, which its run will not check.
export interface LinkOutcome {
  readonly linked: Linked
  readonly sentBack: ReadonlyArray<string>
}

const percent = (score: number) => `${Math.round(score * 100)}%`

export const linkCandidate = (
  input: {
    readonly bookId: string
    readonly set: string
    readonly mapVersion: number
    readonly candidate: Candidate
    readonly origin: QuestionOrigin
    // For an item that needs a figure: the band of its page, kept as an image.
    readonly figure?: FigureSource
    // Problems found before linking, such as a chart that does not draw.
    readonly checks?: ReadonlyArray<Reason>
  },
  bank: Array<BankEntry>,
  passages: Array<PassageEntry>
): Effect.Effect<LinkOutcome, never, Db> =>
  Effect.gen(function*() {
    const db = yield* Db
    const { bookId, set, mapVersion, candidate, origin } = input
    const now = yield* Clock.currentTimeMillis
    return yield* db.transaction(() =>
      Effect.gen(function*() {
        // What it asks about, as Learners will see it. A Question about a
        // passage, table or chart is the same Question only about the same
        // one.
        const stimulus = candidate.stimulus === null
          ? null
          : yield* stimulusFor(candidate.stimulus, now, input.figure, `${bookId}|${candidate.page}|${candidate.number}`, passages)
        const repaired = stimulus?.repaired === true ? yield* passageRepaired(stimulus.id, bookId) : []
        const problems = [...candidateProblems(candidate, stimulus?.shown ?? null), ...(input.checks ?? [])]
        const text = comparableText(candidate.stem, candidate.parts)
        const hash = sha256(stimulus === null ? text : `${stimulus.hash}|${text}`)

        const [found] = yield* db.select().from(sources)
          .where(and(eq(sources.bookId, bookId), eq(sources.page, candidate.page), eq(sources.number, candidate.number)))
        const sentBack = [...repaired]
        const done = (linked: Linked): LinkOutcome => ({ linked, sentBack })
        // Whether the item's reading takes a Question it already has to
        // another Stimulus. A passage that nearly copies the Question's
        // passage leaves it there: the same passage printed again, as the
        // Curator says when using the other passage.
        const movesFrom = (current: string | null) =>
          current !== (stimulus?.id ?? null) &&
          !(current !== null && stimulus !== null && stimulus.shown.kind === "passage" &&
            nearPassages(stimulus.id, stimulus.shown.body, passages).some((each) => each.id === current))
        // A Book Map fix can find another Stimulus for the Question's own
        // item. Other items that share the Question keep it about its
        // Stimulus, and this one becomes a Question of its own.
        let source = found
        if (found !== undefined && !found.merged) {
          const [question] = yield* db.select({ stimulusId: questions.stimulusId }).from(questions)
            .where(eq(questions.id, found.questionId))
          const [other] = yield* db.select({ id: sources.id }).from(sources)
            .where(and(eq(sources.questionId, found.questionId), ne(sources.id, found.id))).limit(1)
          if (question !== undefined && movesFrom(question.stimulusId) && other !== undefined) {
            yield* leaveQuestion(found)
            const [left] = yield* db.select({ status: questions.status }).from(questions).where(eq(questions.id, found.questionId))
            const [inBook] = yield* db.select({ id: sources.id }).from(sources)
              .where(and(eq(sources.questionId, found.questionId), eq(sources.bookId, bookId))).limit(1)
            if (left?.status === "draft" && inBook === undefined) sentBack.push(found.questionId)
            source = undefined
          }
        }
        if (source !== undefined) {
          const [question] = yield* db.select({
            stimulusId: questions.stimulusId,
            linkReasons: questions.linkReasons,
            related: questions.relatedQuestionId
          }).from(questions).where(eq(questions.id, source.questionId))
          // A Book Map fix can find what the Question's own item asks about,
          // or another one.
          const stimulusChanged = !source.merged && question !== undefined && movesFrom(question.stimulusId)
          const changed = source.bookKey !== candidate.key || source.explanation !== candidate.explanation ||
            source.explanationAnswer !== candidate.explanationAnswer || source.bookLabel !== candidate.label ||
            stimulusChanged
          const explainedBefore = changed ? yield* explanationOf(source.questionId) : undefined
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
          if (!changed) return done("unchanged")
          // Whether the explanation the Approaches are written with, or the
          // answer it reaches, changed: this item's may not be the one used.
          const explanationChanged = !sameExplanation(explainedBefore!, yield* explanationOf(source.questionId))
          // Another Book's item for the Question: its key bears on it, and its
          // explanation may be the one the Question's Approaches use.
          if (source.merged) {
            if (source.bookKey !== candidate.key) yield* recheckSources(source.questionId)
            if (explanationChanged) {
              const [after] = yield* db.select({ linkReasons: questions.linkReasons, related: questions.relatedQuestionId })
                .from(questions).where(eq(questions.id, source.questionId))
              if (after !== undefined) {
                yield* settle(source.questionId, readLinkReasons(after.linkReasons), after.related, { content: true })
              }
            }
            return done("relinked")
          }
          // The Question's own item: its key and label follow the Book,
          // unless the Curator overrode the key, what it asks about follows
          // the readings, and its reasons are worked out again, keeping the
          // repeats the Curator has not settled. A Question moved to another
          // Stimulus is compared with that one's Questions instead.
          yield* db.update(questions).set({ bookLabel: candidate.label, updatedAt: now })
            .where(eq(questions.id, source.questionId))
          let repeats = readLinkReasons(question?.linkReasons ?? "[]").filter((reason) => RepeatCodes.has(reason.code))
          let related = question?.related ?? null
          if (stimulusChanged) {
            const moved = (yield* moveQuestion(source.questionId, stimulus))!
            const pieces = trigrams(nearText(candidate.questionType, candidate.stem, candidate.parts))
            const entry = bank.find((each) => each.id === source.questionId)
            if (entry !== undefined) {
              bank.splice(bank.indexOf(entry), 1, { ...entry, hash: moved, trigrams: pieces, stimulusId: stimulus?.id ?? null })
            }
            const repeat = repeatOf(source.questionId, moved, pieces, stimulus?.id ?? null, bank)
            repeats = repeat === undefined ? [] : [repeat.reason]
            related = repeat?.related ?? null
          }
          const own = yield* keyOf(source.questionId)
          let keyChanged = false
          for (const part of own.parts) {
            const key = candidate.parts[part.position]?.key ?? null
            if (part.keyBasis === "override" || part.key === key) continue
            keyChanged = true
            yield* db.update(parts).set({ key, keyBasis: key === null ? null : "book" }).where(eq(parts.id, part.id))
          }
          // A key the Curator overrode settles every question about the key.
          const kept = problems.filter((reason) => !own.overridden || !KeyCodes.has(reason.code))
          yield* settle(
            source.questionId,
            [...kept, ...repeats, ...yield* sourceKeyReasons(source.questionId)],
            related,
            {
              // The Approaches quote what it asks about.
              content: keyChanged || explanationChanged || stimulusChanged,
              regate: source.bookLabel !== candidate.label || stimulusChanged
            }
          )
          return done("relinked")
        }

        const pieces = trigrams(nearText(candidate.questionType, candidate.stem, candidate.parts))
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

        // The same Question again: another Source for it. Its explanation
        // becomes the one the Approaches use when the Question had none.
        if (exact !== undefined && !unsure && (candidate.key === null || exact.key === candidate.key)) {
          const explainedBefore = yield* explanationOf(exact.id)
          yield* addSource(exact.id, true)
          if (!sameExplanation(explainedBefore, yield* explanationOf(exact.id))) {
            const [question] = yield* db.select({ linkReasons: questions.linkReasons, related: questions.relatedQuestionId })
              .from(questions).where(eq(questions.id, exact.id))
            if (question !== undefined) {
              yield* settle(exact.id, readLinkReasons(question.linkReasons), question.related, { content: true })
            }
          }
          return done("merged")
        }
        // The same Question, which had no key: it takes this Book's key and
        // goes back through the Publish Gate.
        if (exact !== undefined && !unsure && exact.key === null) {
          yield* addSource(exact.id, true)
          for (const part of (yield* keyOf(exact.id)).parts) {
            if (part.keyBasis === "override") continue
            const key = candidate.parts[part.position]?.key ?? null
            yield* db.update(parts).set({ key, keyBasis: key === null ? null : "book" }).where(eq(parts.id, part.id))
          }
          const [question] = yield* db.select({ linkReasons: questions.linkReasons, related: questions.relatedQuestionId })
            .from(questions).where(eq(questions.id, exact.id))
          const kept = readLinkReasons(question?.linkReasons ?? "[]")
            .filter((reason) => reason.code !== "no-key" && reason.code !== "source-key")
          yield* settle(exact.id, [...kept, ...yield* sourceKeyReasons(exact.id)], question?.related ?? null, { content: true })
          bank.splice(bank.indexOf(exact), 1, { ...exact, key: candidate.key })
          return done("merged")
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
          // Questions about the same Stimulus, or about a stored passage this
          // one nearly copies, each with how alike the passages are.
          const near = stimulus === null || stimulus.shown.kind !== "passage"
            ? []
            : nearPassages(stimulus.id, stimulus.shown.body, passages)
          const about = new Map<string | null, number>([
            [stimulus?.id ?? null, 1],
            ...near.map((each) => [each.id, each.score] as const)
          ])
          let best: { readonly id: string; readonly score: number; readonly passage: number } | undefined
          for (const entry of bank) {
            const passage = about.get(entry.stimulusId)
            if (passage === undefined) continue
            const score = similarity(pieces, entry.trigrams)
            if (score >= NearMatch && (best === undefined || score > best.score)) best = { id: entry.id, score, passage }
          }
          if (best !== undefined) {
            reasons.push({
              code: "near-match",
              detail: best.passage < 1
                ? `It is ${best.score > 0.999 ? "worded like" : `${percent(best.score)} like`} another Question, whose passage is ${
                  percent(best.passage)
                } like its own: a Variant, or the same Question?`
                : best.score > 0.999
                ? "It is another Question with different numbers: a Variant, or the same Question?"
                : `It is ${percent(best.score)} like another Question: a Variant, or the same Question?`
            })
            related = best.id
          } else {
            // No Question like it, but its passage nearly copies one that
            // Questions in the Question Bank ask about: the Curator says
            // whether it is the same passage.
            const closest = near.find((each) => bank.some((entry) => entry.stimulusId === each.id))
            const other = closest === undefined ? undefined : bank.filter((entry) => entry.stimulusId === closest.id)
              .map((entry) => ({ id: entry.id, score: similarity(pieces, entry.trigrams) }))
              .toSorted((a, b) => b.score - a.score)[0]
            if (closest !== undefined && other !== undefined) {
              reasons.push({
                code: "near-match",
                detail: `Its passage is ${percent(closest.score)} like the passage of another Question: the same passage, or another?`
              })
              related = other.id
            }
          }
        }

        const [taxonomy] = yield* db.select({ version: max(taxonomyVersions.version) }).from(taxonomyVersions)
        const questionId = crypto.randomUUID()
        yield* db.insert(questions).values({
          id: questionId,
          section: candidate.section,
          questionType: candidate.questionType,
          stimulusId: stimulus?.id ?? null,
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
        for (const [position, part] of candidate.parts.entries()) {
          const partId = crypto.randomUUID()
          yield* db.insert(parts).values({
            id: partId,
            questionId,
            position,
            kind: part.kind,
            prompt: part.prompt,
            key: part.key,
            keyBasis: part.key === null ? null : "book"
          })
          if (part.options.length > 0) {
            yield* db.insert(options).values(part.options.map((option, at) => ({
              partId,
              position: at,
              label: option.label,
              text: option.text
            })))
          }
        }
        yield* addSource(questionId, false)
        bank.push({ id: questionId, hash, trigrams: pieces, key: candidate.key, stimulusId: stimulus?.id ?? null })
        return done("created")
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
// other Books keeps them, and its Approaches are written again if the
// explanation they used left. Skips and unread pages the map no longer covers
// go too. Returns how many items left, and the Questions sent back to draft
// that have no Source left in the Book, which its run will not check.
export const retireStale = (bookId: string, mapVersion: number, unreadPages: ReadonlySet<number>) =>
  Effect.gen(function*() {
    const db = yield* Db
    const now = yield* Clock.currentTimeMillis
    return yield* db.transaction(() =>
      Effect.gen(function*() {
        const stale = yield* db.select().from(sources)
          .where(and(eq(sources.bookId, bookId), lt(sources.mapVersion, mapVersion)))
        const touched = [...new Set(stale.map((source) => source.questionId))]
        const explainedBefore = new Map<string, Explanation>()
        for (const questionId of touched) explainedBefore.set(questionId, yield* explanationOf(questionId))
        for (const source of stale) yield* db.delete(sources).where(eq(sources.id, source.id))
        const sentBack: Array<string> = []
        for (const questionId of touched) {
          const remaining = yield* db.select().from(sources).where(eq(sources.questionId, questionId))
            .orderBy(asc(sources.createdAt), asc(sql`${sources}.rowid`))
          if (remaining.length === 0) {
            yield* db.update(questions).set({ status: "withdrawn", updatedAt: now }).where(eq(questions.id, questionId))
            yield* db.update(reviewItems).set({ status: "decided", decision: "withdrawn", decidedAt: now })
              .where(and(eq(reviewItems.questionId, questionId), eq(reviewItems.status, "open")))
          } else {
            if (remaining.every((source) => source.merged)) {
              yield* db.update(sources).set({ merged: false }).where(eq(sources.id, remaining[0]!.id))
            }
            const content = !sameExplanation(explainedBefore.get(questionId)!, yield* explanationOf(questionId))
            yield* recheckSources(questionId, { content })
            const [after] = yield* db.select({ status: questions.status }).from(questions)
              .where(eq(questions.id, questionId))
            if (after?.status === "draft" && !remaining.some((source) => source.bookId === bookId)) {
              sentBack.push(questionId)
            }
          }
          // A golden-set approval is of the Question's own item in its Book;
          // it goes when that item does.
          const [golden] = yield* db.select({ bookId: goldenQuestions.bookId }).from(goldenQuestions)
            .where(eq(goldenQuestions.questionId, questionId))
          if (golden !== undefined) {
            const [own] = yield* db.select({ id: sources.id }).from(sources)
              .where(and(eq(sources.questionId, questionId), eq(sources.bookId, golden.bookId), eq(sources.merged, false)))
            if (own === undefined) yield* db.delete(goldenQuestions).where(eq(goldenQuestions.questionId, questionId))
          }
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
        return { retired: stale.length, sentBack }
      })
    ).pipe(Effect.orDie)
  })

