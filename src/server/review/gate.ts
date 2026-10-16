import { and, asc, eq } from "drizzle-orm"
import { Clock, Effect } from "effect"
import type { TaxonomyView } from "../../api/Taxonomy.ts"
import { bandOf, type DifficultyBand, labelDifficulty } from "../../api/difficulty.ts"
import { tagProblems } from "../../api/taxonomyRules.ts"
import { holdForReview, readLinkReasons, UnsureCodes } from "../books/bankWrites.ts"
import { ApproachSeconds, shownTextProblem, SolverRuns } from "../books/enrichment.ts"
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
  readonly bookLabel: DifficultyBand | null
  readonly solverAnswers: ReadonlyArray<string>
  readonly approaches: ReadonlyArray<{
    readonly strategy: string
    readonly answer: string | null
    readonly author: string
    readonly steps: string
    readonly validWhen: string
    readonly expectedSeconds: number
  }>
  readonly notes: ReadonlyArray<{
    readonly label: string
    readonly mistakeType: string
    readonly trapPattern: string | null
    readonly trapNote: string
  }>
}

const BandRank: Record<DifficultyBand, number> = { easy: 0, medium: 1, hard: 2 }

const listed = (items: ReadonlyArray<string>) =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`

export const gateReasons = (taxonomy: TaxonomyView, input: GateInput): ReadonlyArray<Reason> => {
  const reasons: Array<Reason> = [...input.linkReasons]
  if (!input.enriched) {
    // Text in doubt is not enriched on purpose, and its reasons hold it.
    if (!reasons.some((reason) => UnsureCodes.has(reason.code))) {
      reasons.push({ code: "not-enriched", detail: "It has no tags, solves or Approaches yet." })
    }
    return reasons
  }

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

  if (!input.approaches.some((approach) => approach.author === "llm")) {
    reasons.push({ code: "approach-misses-key", detail: "No Approach could be written for it." })
  }
  for (const approach of input.approaches) {
    const which = approach.author === "book" ? "The book's explanation" : "An Approach"
    if (approach.answer !== key) {
      reasons.push({
        code: "approach-misses-key",
        detail: approach.author === "book"
          ? `The book's explanation reaches ${approach.answer ?? "no stated answer"}, not the key, ${key}.`
          : `An Approach arrives at ${approach.answer ?? "no answer"}, not the key, ${key}, even after it was written again.`
      })
    }
    for (const [what, text] of [["steps", approach.steps], ["note on when it is valid", approach.validWhen]] as const) {
      const problem = shownTextProblem(text)
      if (problem !== undefined) reasons.push({ code: "teaching-text", detail: `${which}'s ${what} cannot be shown: ${problem}.` })
    }
    if (approach.expectedSeconds < ApproachSeconds.minimum || approach.expectedSeconds > ApproachSeconds.maximum) {
      reasons.push({ code: "teaching-text", detail: `${which} expects ${approach.expectedSeconds} seconds.` })
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
  for (const note of input.notes) {
    const problem = shownTextProblem(note.trapNote)
    if (problem !== undefined) {
      reasons.push({ code: "teaching-text", detail: `The note for ${note.label} cannot be shown: ${problem}.` })
    }
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
    const routes = yield* db.select({
      strategy: approaches.strategy,
      answer: approaches.answer,
      author: approaches.author,
      steps: approaches.steps,
      validWhen: approaches.validWhen,
      expectedSeconds: approaches.expectedSeconds
    }).from(approaches).where(eq(approaches.questionId, questionId)).orderBy(asc(approaches.position))
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
      bookLabel: question.bookLabel as DifficultyBand | null,
      solverAnswers: solves.map((solve) => solve.answer),
      approaches: routes,
      notes: notes.map((note) => ({
        label: optionRows[note.position]?.label ?? "?",
        mistakeType: note.mistakeType,
        trapPattern: note.trapPattern,
        trapNote: note.trapNote
      }))
    }
    return { question, input }
  })

// Runs the gate on a Question and records the outcome: published, or held
// with every reason. Its starting Difficulty is set here, from the Book
// Label, else the estimate. Withdrawn Questions are left alone. It reads and
// writes in one transaction, so a change the Curator commits meanwhile is
// either seen or waits for it.
export const runGate = (questionId: string, taxonomy: TaxonomyView) =>
  Effect.gen(function*() {
    const db = yield* Db
    return yield* db.transaction(() => gateOnce(questionId, taxonomy))
  })

const gateOnce = (questionId: string, taxonomy: TaxonomyView) =>
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
