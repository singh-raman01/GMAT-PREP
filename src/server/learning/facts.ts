import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm"
import { Effect } from "effect"
import { groupOf } from "../../api/blueprint.ts"
import { MissedPartView, MistakesView, type Named, type Selection } from "../../api/Practice.ts"
import { QuestionId } from "../../api/Review.ts"
import { targetSecondsFor } from "../../api/targetTimes.ts"
import { Db } from "../db/Database.ts"
import {
  bankVersion,
  books,
  difficulty,
  mistakeLabels,
  optionNotes,
  options,
  parts,
  questions,
  responses,
  servedQuestions,
  sources
} from "../db/schema.ts"
import type { Names } from "../practice/content.ts"
import { currentDifficulty } from "../practice/history.ts"
import { type MissedPart, missesOf, type QuestionFact, type ResponseFact } from "./misses.ts"

// The facts the Error Log rules read, from the database, and the views of a
// miss's wrong Parts.

export const responseFact = (
  row: Pick<
    typeof responses.$inferSelect,
    "id" | "sessionId" | "questionId" | "kind" | "seq" | "selection" | "timeSpentMs" | "guessed" | "createdAt"
  >
): ResponseFact => ({
  id: row.id,
  sessionId: row.sessionId,
  questionId: row.questionId,
  kind: row.kind,
  seq: row.seq,
  // Checked when it was written; a history of many reads it without the
  // Schema's cost.
  selection: JSON.parse(row.selection) as Selection,
  timeSpentMs: row.timeSpentMs,
  guessed: row.guessed,
  at: row.createdAt
})

// What the Error Log needs of each Question answered: no Stimuli, option
// texts or Approaches, which only an open entry shows.
export interface QuestionSummary {
  readonly id: string
  readonly section: string
  readonly questionType: string
  readonly primarySkill: string | null
  readonly secondarySkills: ReadonlyArray<string>
  readonly difficulty: number
  readonly stem: string
  readonly status: string
  readonly enrichment: string
  readonly stimulusId: string | null
  readonly parts: ReadonlyArray<{
    readonly position: number
    readonly prompt: string | null
    readonly key: string | null
    // Each wrong option's note, by the option's label.
    readonly notes: ReadonlyMap<string, { readonly mistakeType: string; readonly trapPattern: string | null }>
  }>
  readonly books: ReadonlyArray<
    { readonly id: string; readonly title: string; readonly edition: string; readonly createdAt: number }
  >
}

// Reads ids a few hundred at a time, within SQLite's limit on parameters.
export const inChunks = <A, E, R>(ids: ReadonlyArray<string>, read: (chunk: Array<string>) => Effect.Effect<ReadonlyArray<A>, E, R>) =>
  Effect.gen(function*() {
    const found: Array<A> = []
    for (let start = 0; start < ids.length; start += 500) found.push(...(yield* read(ids.slice(start, start + 500))))
    return found
  })

// Each Question's summary, with the Difficulty seed it falls back on.
export const readSummaries = (ids: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const db = yield* Db
    const wanted = [...new Set(ids)]
    const rows = yield* inChunks(wanted, (chunk) =>
      db.select({
        id: questions.id,
        section: questions.section,
        questionType: questions.questionType,
        primarySkill: questions.primarySkill,
        secondarySkills: questions.secondarySkills,
        difficulty: currentDifficulty,
        seed: questions.difficultySeed,
        stem: questions.stem,
        status: questions.status,
        enrichment: questions.enrichment,
        stimulusId: questions.stimulusId
      }).from(questions).leftJoin(difficulty, eq(difficulty.questionId, questions.id)).where(inArray(questions.id, chunk))
    )
    const partRows = yield* inChunks(wanted, (chunk) =>
      db.select({ id: parts.id, questionId: parts.questionId, position: parts.position, prompt: parts.prompt, key: parts.key })
        .from(parts).where(inArray(parts.questionId, chunk)).orderBy(asc(parts.position))
    )
    const partIds = partRows.map((part) => part.id)
    const noteRows = yield* inChunks(partIds, (chunk) =>
      db.select({
        partId: optionNotes.partId,
        label: options.label,
        mistakeType: optionNotes.mistakeType,
        trapPattern: optionNotes.trapPattern
      }).from(optionNotes)
        .innerJoin(options, and(eq(options.partId, optionNotes.partId), eq(options.position, optionNotes.position)))
        .where(inArray(optionNotes.partId, chunk))
    )
    const bookRows = yield* inChunks(wanted, (chunk) =>
      db.select({
        questionId: sources.questionId,
        id: books.id,
        title: books.title,
        edition: books.edition,
        createdAt: books.createdAt
      })
        .from(sources).innerJoin(books, eq(books.id, sources.bookId)).where(inArray(sources.questionId, chunk))
        .orderBy(asc(sources.createdAt))
    )
    const partsOf = Map.groupBy(partRows, (part) => part.questionId)
    const notesOf = Map.groupBy(noteRows, (note) => note.partId)
    const booksOf = Map.groupBy(bookRows, (book) => book.questionId)
    return new Map(rows.map((row) => [row.id, {
      seed: row.seed ?? 0,
      summary: {
      id: row.id,
      section: row.section,
      questionType: row.questionType,
      primarySkill: row.primarySkill,
      secondarySkills: JSON.parse(row.secondarySkills) as ReadonlyArray<string>,
      difficulty: Number(row.difficulty),
      stem: row.stem,
      status: row.status,
      enrichment: row.enrichment,
      stimulusId: row.stimulusId,
      parts: (partsOf.get(row.id) ?? []).map((part) => ({
        position: part.position,
        prompt: part.prompt,
        key: part.key,
        notes: new Map((notesOf.get(part.id) ?? []).map((note) => [note.label, note] as const))
      })),
      books: [...new Map((booksOf.get(row.id) ?? []).map((book) => [book.id, book] as const)).values()]
    } satisfies QuestionSummary
    }] as const)) as ReadonlyMap<string, { readonly summary: QuestionSummary; readonly seed: number }>
  })

export const questionSummaries = (ids: ReadonlyArray<string>) =>
  readSummaries(ids).pipe(
    Effect.map((read) => new Map([...read].map(([id, each]) => [id, each.summary] as const)) as ReadonlyMap<string, QuestionSummary>)
  )

// Question summaries kept between reads (decision 127). All but the current
// Difficulty come from the Question Bank's tables, so they are kept until the
// bank's version moves, which triggers do on every write to those tables, in
// this process or the worker's; the Difficulty moves with each Rated Response
// and is read again every time. Each read works on the map for the version it
// read before its rows: what it reads is never older than that version, and
// never goes into a newer version's map that another read put in place
// meanwhile. `read` is the rows' reader, which tests replace.
export const makeSummaryReader = (read: typeof readSummaries = readSummaries) => {
  type Kept = { readonly version: number; readonly summaries: Map<string, { readonly summary: QuestionSummary; readonly seed: number }> }
  let kept: Kept = { version: -1, summaries: new Map() }
  return (ids: ReadonlyArray<string>) =>
    Effect.gen(function*() {
      const db = yield* Db
      const [row] = yield* db.select({ version: bankVersion.version }).from(bankVersion).where(eq(bankVersion.id, 1))
      const version = row?.version ?? -1
      let mine = kept
      if (version !== mine.version) {
        mine = { version, summaries: new Map() }
        if (version > kept.version) kept = mine
      }
      const wanted = [...new Set(ids)]
      const missing = wanted.filter((id) => !mine.summaries.has(id))
      if (missing.length > 0) for (const [id, each] of yield* read(missing)) mine.summaries.set(id, each)
      const rated = yield* inChunks(wanted, (chunk) =>
        db.select({ questionId: difficulty.questionId, value: difficulty.value }).from(difficulty).where(inArray(difficulty.questionId, chunk))
      )
      const current = new Map(rated.map((each) => [each.questionId, each.value] as const))
      const found = new Map<string, QuestionSummary>()
      for (const id of wanted) {
        const each = mine.summaries.get(id)
        if (each === undefined) continue
        const value = current.get(id)
        found.set(id, { ...each.summary, difficulty: value ?? each.seed })
      }
      return found as ReadonlyMap<string, QuestionSummary>
    })
}

// A Question as the rules read it: its Parts, its Target Time and, for an RC
// passage's or MSR set's Question, the Stimulus it is timed with. Option
// notes count only once written for the current key (enrichment done), as
// the Debrief shows them.
export const questionFactOf = (
  question: Pick<QuestionSummary, "id" | "questionType" | "stimulusId" | "enrichment" | "parts">,
  overrides: Readonly<Record<string, number>>
): QuestionFact => ({
  id: question.id,
  unit: groupOf(question.questionType)?.units === true ? question.stimulusId : null,
  targetMs: targetSecondsFor(question.questionType, overrides) * 1000,
  parts: question.parts.map((part) => ({
    position: part.position,
    key: part.key,
    notes: question.enrichment === "done" ? part.notes : new Map()
  }))
})

// The Learner's latest Mistake Type for each Response and Part, keyed
// "response:part".
export const labelsOf = (where: SQL) =>
  Effect.gen(function*() {
    const db = yield* Db
    // The latest written stands, whatever the clock said.
    const rows = yield* db.select().from(mistakeLabels).where(where).orderBy(asc(sql`${mistakeLabels}.rowid`))
    return new Map(rows.map((label) => [`${label.responseId}:${label.part}`, label.mistakeType] as const))
  })

export const missedPartView = (
  part: MissedPart,
  label: string | undefined,
  question: { readonly parts: ReadonlyArray<{ readonly position: number; readonly prompt: string | null }> },
  names: Names
) => {
  const mistakeType = label ?? part.mistakeType
  return new MissedPartView({
    part: part.part,
    prompt: question.parts.length > 1 ? question.parts.find((each) => each.position === part.part)?.prompt ?? null : null,
    picked: part.picked,
    mistakeType: mistakeType === null ? null : names.named(mistakeType),
    basis: label === undefined ? part.basis : "learner",
    trapPattern: part.trapPattern === null ? null : names.named(part.trapPattern)
  })
}

// The Mistake Types of a wrong answer, for its Debrief: the miss the
// Session's final Response to the Question makes, with the Learner's labels.
// Null when that answer is not wrong. The caller knows the Session shows how
// it went. Only the Session's own Questions are read, without their content.
export const sessionMistakes = (
  session: { readonly id: string; readonly kind: string; readonly timed: boolean; readonly timeLimitMs: number | null },
  questionId: string,
  context: {
    readonly overrides: Readonly<Record<string, number>>
    readonly names: Names
    readonly choices: ReadonlyArray<Named>
    readonly resolve: (id: string) => string
  }
) =>
  Effect.gen(function*() {
    const db = yield* Db
    const given = yield* db.select().from(responses).where(eq(responses.sessionId, session.id))
    if (!given.some((response) => response.questionId === questionId)) return null
    const ids = [...new Set(given.flatMap((response) => [response.questionId, context.resolve(response.questionId)]))]
    const served = yield* db.select({
      sessionId: servedQuestions.sessionId,
      questionId: servedQuestions.questionId,
      servedElapsedMs: servedQuestions.servedElapsedMs
    }).from(servedQuestions).where(eq(servedQuestions.sessionId, session.id))
    const summaries = yield* questionSummaries(ids)
    const misses = missesOf({
      sessions: [{ id: session.id, kind: session.kind, limitMs: session.timed ? session.timeLimitMs : null, shown: true }],
      responses: given.map(responseFact),
      served,
      questions: new Map([...summaries].map(([id, question]) => [id, questionFactOf(question, context.overrides)] as const)),
      resolve: context.resolve
    })
    const entry = context.resolve(questionId)
    const miss = misses.find((each) => each.questionId === entry && each.reasons.includes("wrong"))
    const question = summaries.get(entry)
    if (miss === undefined || question === undefined) return null
    const labels = yield* labelsOf(eq(mistakeLabels.responseId, miss.responseId))
    return new MistakesView({
      questionId: QuestionId.make(entry),
      responseId: miss.responseId,
      parts: miss.parts.map((part) => missedPartView(part, labels.get(`${miss.responseId}:${part.part}`), question, context.names)),
      choices: context.choices
    })
  })
