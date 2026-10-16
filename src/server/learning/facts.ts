import { asc, eq, inArray, sql } from "drizzle-orm"
import { Effect } from "effect"
import { groupOf } from "../../api/blueprint.ts"
import { MissedPartView, MistakesView, type Named } from "../../api/Practice.ts"
import { QuestionId } from "../../api/Review.ts"
import { targetSecondsFor } from "../../api/targetTimes.ts"
import { Db } from "../db/Database.ts"
import { mistakeLabels, questions, responses, servedQuestions } from "../db/schema.ts"
import type { Names, StoredQuestion } from "../practice/content.ts"
import { storedQuestions } from "../practice/content.ts"
import { readSelection } from "../practice/history.ts"
import { type MissedPart, missesOf, type QuestionFact, type ResponseFact } from "./misses.ts"

// The facts the Error Log rules read, from the database, and the views of a
// miss's wrong Parts.

export const responseFact = (row: typeof responses.$inferSelect): ResponseFact => ({
  id: row.id,
  sessionId: row.sessionId,
  questionId: row.questionId,
  kind: row.kind,
  seq: row.seq,
  selection: readSelection(row.selection),
  timeSpentMs: row.timeSpentMs,
  guessed: row.guessed,
  at: row.createdAt
})

// Each Question with its Parts, its Target Time and, for an RC passage's or
// MSR set's Question, the Stimulus it is timed with.
export const questionFacts = (
  stored: ReadonlyMap<string, StoredQuestion>,
  stimulusOf: ReadonlyMap<string, string | null>,
  overrides: Readonly<Record<string, number>>
): Array<QuestionFact> =>
  [...stored.values()].map((question) => ({
    id: question.id,
    unit: groupOf(question.questionType)?.units === true ? stimulusOf.get(question.id) ?? null : null,
    targetMs: targetSecondsFor(question.questionType, overrides) * 1000,
    parts: question.parts.map((part) => ({
      position: part.position,
      key: part.key,
      labels: part.options.map((option) => option.label),
      notes: part.notes
    }))
  }))

export const stimuliOf = (ids: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    if (ids.length === 0) return new Map<string, string | null>()
    const db = yield* Db
    const rows = yield* db.select({ id: questions.id, stimulusId: questions.stimulusId }).from(questions)
      .where(inArray(questions.id, [...ids]))
    return new Map(rows.map((row) => [row.id, row.stimulusId] as const))
  })

// The Learner's latest Mistake Type for each Response and Part, keyed
// "response:part".
export const labelsOf = (where: ReturnType<typeof eq>) =>
  Effect.gen(function*() {
    const db = yield* Db
    const rows = yield* db.select().from(mistakeLabels).where(where)
      .orderBy(asc(mistakeLabels.createdAt), asc(sql`${mistakeLabels}.rowid`))
    return new Map(rows.map((label) => [`${label.responseId}:${label.part}`, label.mistakeType] as const))
  })

export const missedPartView = (
  part: MissedPart,
  label: string | undefined,
  question: StoredQuestion,
  names: Names
) => {
  const mistakeType = label ?? part.mistakeType
  return new MissedPartView({
    part: part.part,
    prompt: question.parts.length > 1 ? question.parts.find((each) => each.position === part.part)?.prompt ?? null : null,
    picked: part.picked,
    mistakeType: mistakeType === null ? null : names.named(mistakeType),
    byLearner: label !== undefined,
    trapPattern: part.trapPattern === null ? null : names.named(part.trapPattern)
  })
}

// The Mistake Types of a wrong answer, for its Debrief: the miss the
// Session's final Response to the Question makes, with the Learner's labels.
// Undefined when that answer is not wrong. The caller knows the Session
// shows how it went.
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
    const ids = [...new Set(given.map((response) => response.questionId))]
    const served = yield* db.select({
      sessionId: servedQuestions.sessionId,
      questionId: servedQuestions.questionId,
      servedElapsedMs: servedQuestions.servedElapsedMs
    }).from(servedQuestions).where(eq(servedQuestions.sessionId, session.id))
    const stored = yield* storedQuestions(ids)
    const misses = missesOf({
      sessions: [{ id: session.id, kind: session.kind, limitMs: session.timed ? session.timeLimitMs : null, shown: true }],
      responses: given.map(responseFact),
      served,
      questions: questionFacts(stored, yield* stimuliOf(ids), context.overrides)
    })
    const miss = misses.find((each) => each.questionId === questionId && each.reasons.includes("wrong"))
    if (miss === undefined) return null
    const labels = yield* labelsOf(eq(mistakeLabels.responseId, miss.responseId))
    const question = stored.get(questionId)!
    return new MistakesView({
      questionId: QuestionId.make(context.resolve(questionId)),
      responseId: miss.responseId,
      parts: miss.parts.map((part) => missedPartView(part, labels.get(`${miss.responseId}:${part.part}`), question, context.names)),
      choices: context.choices
    })
  })
