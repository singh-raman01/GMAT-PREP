import { and, asc, eq } from "drizzle-orm"
import { Clock, Effect } from "effect"
import type { TaxonomyView } from "../../api/Taxonomy.ts"
import { type Band, bandOf, labelDifficulty, tagProblems } from "../../api/taxonomyRules.ts"
import { holdForReview, readLinkReasons } from "../books/bankWrites.ts"
import { SolverRuns } from "../books/enrichment.ts"
import type { Reason } from "../books/linking.ts"
import { Db } from "../db/Database.ts"
import { approaches, optionNotes, options, parts, questions, reviewItems, solverRuns } from "../db/schema.ts"

// The Publish Gate: every check a Question must pass before Learners see it.
// A Question that passes is published; any other is held in the Review
// Queue with every reason. The key is never changed here.

export interface GateInput {
  readonly questionType: string
  // What extraction and linking found.
  readonly linkReasons: ReadonlyArray<Reason>
  // False when linking found the text or a figure in doubt, so the Question
  // was not enriched; its link reasons hold it.
  readonly enriched: boolean
  readonly key: string | null
  readonly optionLabels: ReadonlyArray<string>
  readonly primarySkill: string | null
  readonly secondarySkills: ReadonlyArray<string>
  readonly difficultyEstimate: number | null
  readonly bookLabel: Band | null
  readonly solverAnswers: ReadonlyArray<string>
  readonly approaches: ReadonlyArray<{ readonly strategy: string; readonly answer: string | null; readonly author: string }>
  readonly notes: ReadonlyArray<{ readonly label: string; readonly mistakeType: string; readonly trapPattern: string | null }>
}

const BandRank: Record<Band, number> = { easy: 0, medium: 1, hard: 2 }

const listed = (items: ReadonlyArray<string>) =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`

export const gateReasons = (taxonomy: TaxonomyView, input: GateInput): ReadonlyArray<Reason> => {
  const reasons: Array<Reason> = [...input.linkReasons]
  if (!input.enriched) return reasons

  for (const problem of tagProblems(taxonomy, {
    questionType: input.questionType,
    primarySkill: input.primarySkill,
    secondarySkills: input.secondarySkills,
    strategies: input.approaches.map((approach) => approach.strategy),
    options: input.notes
  })) {
    reasons.push({ code: "tags", detail: problem })
  }

  if (input.bookLabel !== null && input.difficultyEstimate !== null) {
    const estimated = bandOf(input.difficultyEstimate)
    if (Math.abs(BandRank[estimated] - BandRank[input.bookLabel]) >= 2) {
      reasons.push({
        code: "difficulty",
        detail: `The Book labels it ${input.bookLabel}, but the Difficulty estimate, ${
          input.difficultyEstimate.toFixed(1)
        }, is ${estimated}.`
      })
    }
  }

  // The rest checks work against the key; without one, linking's no-key
  // reason holds the Question.
  const key = input.key
  if (key === null) return reasons

  if (input.solverAnswers.length < SolverRuns) {
    reasons.push({
      code: "solver-disagreement",
      detail: `Only ${input.solverAnswers.length} of ${SolverRuns} independent solves gave a usable answer.`
    })
  } else if (input.solverAnswers.some((answer) => answer !== key)) {
    reasons.push({
      code: "solver-disagreement",
      detail: `Independent solves answered ${listed(input.solverAnswers)}; the key is ${key}.`
    })
  }

  const written = input.approaches.filter((approach) => approach.author === "llm")
  if (written.length === 0) {
    reasons.push({ code: "approach-misses-key", detail: "No Approach could be written for it." })
  }
  for (const approach of written) {
    if (approach.answer !== key) {
      reasons.push({
        code: "approach-misses-key",
        detail: `An Approach arrives at ${approach.answer ?? "no answer"}, not the key, ${key}, even after it was written again.`
      })
    }
  }

  const noted = input.notes.map((note) => note.label)
  const missing = input.optionLabels.filter((label) => label !== key && !noted.includes(label))
  if (missing.length > 0) {
    reasons.push({
      code: "option-notes",
      detail: `No note for the wrong ${missing.length === 1 ? "choice" : "choices"} ${listed(missing)}.`
    })
  }
  if (noted.includes(key)) {
    reasons.push({ code: "option-notes", detail: `A note treats the key, ${key}, as a wrong choice.` })
  }
  return reasons
}

// Everything the gate looks at for a Question, from the database.
export const gateInputOf = (questionId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const [question] = yield* db.select().from(questions).where(eq(questions.id, questionId))
    if (question === undefined) return undefined
    const [part] = yield* db.select().from(parts).where(and(eq(parts.questionId, questionId), eq(parts.position, 0)))
    const optionRows = part === undefined
      ? []
      : yield* db.select().from(options).where(eq(options.partId, part.id)).orderBy(asc(options.position))
    const solves = yield* db.select({ answer: solverRuns.answer }).from(solverRuns)
      .where(eq(solverRuns.questionId, questionId)).orderBy(asc(solverRuns.run))
    const routes = yield* db.select({ strategy: approaches.strategy, answer: approaches.answer, author: approaches.author })
      .from(approaches).where(eq(approaches.questionId, questionId)).orderBy(asc(approaches.position))
    const notes = part === undefined
      ? []
      : yield* db.select().from(optionNotes).where(eq(optionNotes.partId, part.id)).orderBy(asc(optionNotes.position))
    const input: GateInput = {
      questionType: question.questionType,
      linkReasons: readLinkReasons(question.linkReasons),
      enriched: question.enrichment !== "pending",
      key: part?.key ?? null,
      optionLabels: optionRows.map((option) => option.label),
      primarySkill: question.primarySkill,
      secondarySkills: JSON.parse(question.secondarySkills) as ReadonlyArray<string>,
      difficultyEstimate: question.difficultyEstimate,
      bookLabel: question.bookLabel as Band | null,
      solverAnswers: solves.map((solve) => solve.answer),
      approaches: routes,
      notes: notes.map((note) => ({
        label: optionRows[note.position]?.label ?? "?",
        mistakeType: note.mistakeType,
        trapPattern: note.trapPattern
      }))
    }
    return { question, input }
  })

// Runs the gate on a Question and records the outcome: published, or held
// with every reason. Its starting Difficulty is set here, from the Book
// Label, else the estimate. Withdrawn Questions are left alone.
export const runGate = (questionId: string, taxonomy: TaxonomyView) =>
  Effect.gen(function*() {
    const db = yield* Db
    const now = yield* Clock.currentTimeMillis
    const found = yield* gateInputOf(questionId)
    if (found === undefined || found.question.status === "withdrawn") return undefined
    const { question, input } = found
    const reasons = gateReasons(taxonomy, input)
    const seed = input.bookLabel !== null ? labelDifficulty[input.bookLabel] : input.difficultyEstimate
    const passed = reasons.length === 0
    yield* db.update(questions)
      .set({
        status: passed ? "published" : "held",
        difficultySeed: seed,
        difficultyBasis: input.bookLabel !== null ? "book-label" : input.difficultyEstimate !== null ? "estimate" : null,
        updatedAt: now
      })
      .where(eq(questions.id, questionId))
    if (passed) {
      yield* db.update(reviewItems).set({ status: "decided", decision: "published", decidedAt: now })
        .where(and(eq(reviewItems.questionId, questionId), eq(reviewItems.status, "open")))
    } else {
      yield* holdForReview(questionId, reasons, question.relatedQuestionId)
    }
    return passed ? "published" as const : "held" as const
  })
