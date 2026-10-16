import { and, asc, eq, inArray } from "drizzle-orm"
import { Clock, Effect } from "effect"
import type { TaxonomyView } from "../../api/Taxonomy.ts"
import { bandOf, type DifficultyBand, labelDifficulty } from "../../api/difficulty.ts"
import { joinedKey, partKeys } from "../../api/keys.ts"
import { tagProblems } from "../../api/taxonomyRules.ts"
import { holdForReview, readLinkReasons, UnsureCodes } from "../books/bankWrites.ts"
import { ApproachSeconds, shownTextProblem, SolverRuns } from "../books/enrichment.ts"
import { NoPassage, type Reason } from "../books/linking.ts"
import { Db } from "../db/Database.ts"
import {
  approaches,
  optionNotes,
  options,
  parts,
  questions,
  reviewItems,
  solverRuns,
  statementPredicates
} from "../db/schema.ts"

// The Publish Gate: every check a Question must pass before Learners see it.
// A Question that passes is published; any other is held in the Review
// Queue with every reason. The key is never changed here.

export interface GateInput {
  readonly questionType: string
  // Whether it has a Stimulus, such as the passage an RC Question asks about.
  readonly hasStimulus: boolean
  // What extraction and linking found.
  readonly linkReasons: ReadonlyArray<Reason>
  // False when linking found the text or a figure in doubt, so the Question
  // was not enriched; its link reasons hold it.
  readonly enriched: boolean
  // Each Part's key, joined, such as C or A,B,A; null while a Part has none.
  readonly key: string | null
  // Each Part's options, in order, and its key when known; a Part given
  // without a key takes the joined key's.
  readonly parts: ReadonlyArray<{ readonly labels: ReadonlyArray<string>; readonly key?: string | null }>
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
    // The Part it is for, by position.
    readonly part: number
    readonly label: string
    readonly mistakeType: string
    readonly trapPattern: string | null
    readonly trapNote: string
  }>
  // A Generated Question's Parts, by position, that are inferences from
  // text, which code cannot check.
  readonly inferenceParts?: ReadonlyArray<number>
}

const BandRank: Record<DifficultyBand, number> = { easy: 0, medium: 1, hard: 2 }

const listed = (items: ReadonlyArray<string>) => {
  // Answers such as A,B,A are set apart with semicolons.
  const between = items.some((item) => item.includes(",")) ? "; " : ", "
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(between)} and ${items.at(-1)}`
}

export const gateReasons = (taxonomy: TaxonomyView, input: GateInput): ReadonlyArray<Reason> => {
  const reasons: Array<Reason> = [...input.linkReasons]
  // Learners could not answer it without its passage.
  if (
    input.questionType.startsWith("verbal.rc-") && !input.hasStimulus &&
    !reasons.some((reason) => reason.detail === NoPassage.detail)
  ) {
    reasons.push(NoPassage)
  }
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

  // The rest checks work against the key. Every Part needs one before a
  // Learner can answer right, whatever settled the reasons about the key, as
  // a Key Override of one Part of several does.
  const key = input.key
  if (key === null) {
    if (!reasons.some((reason) => reason.code === "no-key" || reason.code === "key-conflict")) {
      const keys = partKeys(key, input.parts.length)
      const missing = input.parts.flatMap((part, index) => ((part.key ?? keys[index]) === null ? [String(index + 1)] : []))
      reasons.push({
        code: "no-key",
        detail: input.parts.length === 1
          ? "It has no key."
          : `${missing.length === 1 ? "Part" : "Parts"} ${listed(missing)} ${missing.length === 1 ? "has" : "have"} no key yet.`
      })
    }
    return reasons
  }

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

  // A generated inference from text stands on its three solves agreeing with
  // its key, and on the Curator, who publishes it once they have checked it.
  const partKeyList = partKeys(key, input.parts.length)
  for (const part of input.inferenceParts ?? []) {
    const answers = input.solverAnswers.map((answer) => partKeys(answer, input.parts.length)[part] ?? "none")
    const own = partKeyList[part] ?? "none"
    reasons.push(
      answers.length >= SolverRuns && answers.every((answer) => answer === own)
        ? {
          code: "inference",
          detail: `Part ${part + 1} is an inference from the text that code cannot check; its three solves agree with its key, ${own}. Publish it once you have checked it.`
        }
        : {
          code: "inference-unconfirmed",
          detail: `Part ${part + 1} is an inference from the text that code cannot check, and its solves answered ${
            answers.length === 0 ? "nothing" : listed(answers)
          }; its key is ${own}.`
        }
    )
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

  // Every wrong option of every Part has its note, and no note is for a key.
  const keys = partKeys(key, input.parts.length)
  const several = input.parts.length > 1
  const named = (part: number, label: string) => (several ? `${label} in Part ${part + 1}` : label)
  const missing = input.parts.flatMap((part, index) =>
    part.labels.filter((label) =>
      label !== keys[index] && !input.notes.some((note) => note.part === index && note.label === label)
    ).map((label) => named(index, label))
  )
  if (missing.length > 0) {
    reasons.push({
      code: "option-notes",
      detail: `No note for the wrong ${missing.length === 1 ? "choice" : "choices"} ${listed(missing)}.`
    })
  }
  for (const note of input.notes) {
    if (note.label === keys[note.part]) {
      reasons.push({
        code: "option-notes",
        detail: `A note treats the key${several ? ` of Part ${note.part + 1}` : ""}, ${note.label}, as a wrong choice.`
      })
    }
    const problem = shownTextProblem(note.trapNote)
    if (problem !== undefined) {
      reasons.push({
        code: "teaching-text",
        detail: `The note for ${named(note.part, note.label)} cannot be shown: ${problem}.`
      })
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
    const partRows = yield* db.select().from(parts).where(eq(parts.questionId, questionId)).orderBy(asc(parts.position))
    const partIds = partRows.map((part) => part.id)
    const optionRows = partIds.length === 0
      ? []
      : yield* db.select().from(options).where(inArray(options.partId, partIds)).orderBy(asc(options.position))
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
    const notes = partIds.length === 0
      ? []
      : yield* db.select().from(optionNotes).where(inArray(optionNotes.partId, partIds)).orderBy(asc(optionNotes.position))
    const labelsOf = (partId: string) => optionRows.filter((option) => option.partId === partId).map((option) => option.label)
    const inferences = partIds.length === 0 ? [] : yield* db.select({ partId: statementPredicates.partId })
      .from(statementPredicates)
      .where(and(inArray(statementPredicates.partId, partIds), eq(statementPredicates.kind, "inference")))
    const input: GateInput = {
      questionType: question.questionType,
      hasStimulus: question.stimulusId !== null,
      linkReasons: readLinkReasons(question.linkReasons),
      enriched: question.enrichment !== "pending",
      key: joinedKey(partRows.map((part) => part.key)),
      parts: partRows.map((part) => ({ labels: labelsOf(part.id), key: part.key })),
      primarySkill: question.primarySkill,
      secondarySkills: JSON.parse(question.secondarySkills) as ReadonlyArray<string>,
      difficultyEstimate: question.difficultyEstimate,
      bookLabel: question.bookLabel as DifficultyBand | null,
      solverAnswers: solves.map((solve) => solve.answer),
      approaches: routes,
      notes: notes.map((note) => ({
        part: partIds.indexOf(note.partId),
        label: labelsOf(note.partId)[note.position] ?? "?",
        mistakeType: note.mistakeType,
        trapPattern: note.trapPattern,
        trapNote: note.trapNote
      })),
      inferenceParts: inferences.map((row) => partIds.indexOf(row.partId)).toSorted((a, b) => a - b)
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
