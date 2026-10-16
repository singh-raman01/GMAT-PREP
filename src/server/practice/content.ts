import { asc, eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { bandOf } from "../../api/difficulty.ts"
import {
  Debrief,
  DebriefApproach,
  Named,
  PracticePart,
  PracticeQuestion,
  type Selection,
  TrapNoteView
} from "../../api/Practice.ts"
import { QuestionId } from "../../api/Review.ts"
import type { TaxonomyView } from "../../api/Taxonomy.ts"
import { Db } from "../db/Database.ts"
import { approaches, books, difficulty, optionNotes, options, parts, questions, sources } from "../db/schema.ts"
import { currentDifficulty, isCorrect } from "./history.ts"

// A served Question's stored content, and the Debrief built from it. The
// Debrief makes no LLM call: everything in it was written at ingestion.

export interface StoredQuestion {
  readonly id: string
  readonly section: string
  readonly questionType: string
  readonly stem: string
  readonly primarySkill: string | null
  readonly difficulty: number
  readonly parts: ReadonlyArray<{
    readonly position: number
    readonly prompt: string | null
    readonly key: string | null
    readonly options: ReadonlyArray<{ readonly label: string; readonly text: string }>
    // Each wrong option's note, by the option's position.
    readonly notes: ReadonlyMap<number, { readonly trapNote: string; readonly mistakeType: string; readonly trapPattern: string | null }>
  }>
  readonly approaches: ReadonlyArray<{
    readonly strategy: string
    readonly steps: string
    readonly expectedSeconds: number
    readonly validWhen: string
    readonly author: string
    readonly answer: string | null
  }>
  readonly sources: ReadonlyArray<{
    readonly bookId: string
    readonly bookTitle: string
    readonly set: string
    readonly number: number
    readonly page: number
  }>
}

export const storedQuestions = (ids: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const found = new Map<string, StoredQuestion>()
    if (ids.length === 0) return found
    const db = yield* Db
    const wanted = [...new Set(ids)]
    const rows = yield* db.select({ question: questions, difficulty: currentDifficulty }).from(questions)
      .leftJoin(difficulty, eq(difficulty.questionId, questions.id))
      .where(inArray(questions.id, wanted))
    const partRows = yield* db.select().from(parts).where(inArray(parts.questionId, wanted)).orderBy(asc(parts.position))
    const partIds = partRows.map((part) => part.id)
    const optionRows = partIds.length === 0
      ? []
      : yield* db.select().from(options).where(inArray(options.partId, partIds)).orderBy(asc(options.position))
    const noteRows = partIds.length === 0
      ? []
      : yield* db.select().from(optionNotes).where(inArray(optionNotes.partId, partIds))
    const approachRows = yield* db.select().from(approaches).where(inArray(approaches.questionId, wanted))
      .orderBy(asc(approaches.position))
    const sourceRows = yield* db.select({
      questionId: sources.questionId,
      bookId: sources.bookId,
      bookTitle: books.title,
      set: sources.set,
      number: sources.number,
      page: sources.page
    }).from(sources).innerJoin(books, eq(books.id, sources.bookId))
      .where(inArray(sources.questionId, wanted))
      .orderBy(asc(sources.createdAt))
    for (const { question, difficulty: value } of rows) {
      found.set(question.id, {
        id: question.id,
        section: question.section,
        questionType: question.questionType,
        stem: question.stem,
        primarySkill: question.primarySkill,
        difficulty: Number(value),
        parts: partRows.filter((part) => part.questionId === question.id).map((part) => ({
          position: part.position,
          prompt: part.prompt,
          key: part.key,
          options: optionRows.filter((option) => option.partId === part.id).map((option) => ({
            label: option.label,
            text: option.text
          })),
          notes: new Map(noteRows.filter((note) => note.partId === part.id).map((note) => [note.position, note] as const))
        })),
        approaches: approachRows.filter((approach) => approach.questionId === question.id),
        sources: sourceRows.filter((source) => source.questionId === question.id)
      })
    }
    return found
  })

// Taxonomy ids to names; an id the Taxonomy lacks is shown as it is.
export interface Names {
  readonly named: (id: string) => Named
}

export const namesOf = (taxonomy: TaxonomyView): Names => {
  const names = new Map<string, string>()
  for (const mistakeType of taxonomy.mistakeTypes) names.set(mistakeType.id, mistakeType.name)
  for (const section of taxonomy.sections) {
    names.set(section.id, section.name)
    for (const questionType of section.questionTypes) names.set(questionType.id, questionType.name)
    for (const topic of section.topics) for (const skill of topic.skills) names.set(skill.id, skill.name)
    for (const trap of section.trapPatterns) names.set(trap.id, trap.name)
    for (const strategy of section.strategies) names.set(strategy.id, strategy.name)
  }
  return { named: (id) => new Named({ id, name: names.get(id) ?? id }) }
}

// The Question as a Learner sees it, with where a Book prints it: in the
// Book the set follows, else its first Source.
export const practiceQuestion = (question: StoredQuestion, names: Names, bookId: string | null) => {
  const source = question.sources.find((each) => each.bookId === bookId) ?? question.sources[0]
  return new PracticeQuestion({
    id: QuestionId.make(question.id),
    section: names.named(question.section),
    questionType: names.named(question.questionType),
    stem: question.stem,
    parts: question.parts.map((part) =>
      new PracticePart({ position: part.position, prompt: part.prompt, options: part.options })
    ),
    source: source === undefined
      ? null
      : { bookTitle: source.bookTitle, set: source.set, number: source.number, page: source.page }
  })
}

// The Trap Note for each wrong option picked, and the Approaches that reach
// the current key, fastest first.
export const debriefOf = (question: StoredQuestion, selection: Selection, names: Names) => {
  const keys = question.parts.map((part) => ({ position: part.position, key: part.key }))
  const trapNotes = question.parts.flatMap((part) => {
    const picked = selection.find((each) => each.part === part.position)?.choice
    if (picked === undefined || picked === part.key) return []
    const position = part.options.findIndex((option) => option.label === picked)
    const note = part.notes.get(position)
    if (note === undefined) return []
    return [
      new TrapNoteView({
        part: part.position,
        label: picked,
        note: note.trapNote,
        mistakeType: names.named(note.mistakeType),
        trapPattern: note.trapPattern === null ? null : names.named(note.trapPattern)
      })
    ]
  })
  // An Approach names one option, so it is checked against a single Part's
  // key; one written against a key since replaced is left out.
  const singleKey = keys.length === 1 ? keys[0]!.key : undefined
  const valid = question.approaches.filter((approach) => singleKey === undefined || approach.answer === singleKey)
  return new Debrief({
    correct: isCorrect(selection, keys),
    keys: keys.map((key) => ({ part: key.position, key: key.key })),
    trapNotes,
    approaches: valid
      .map((approach, index) => ({ approach, index }))
      .toSorted((a, b) => a.approach.expectedSeconds - b.approach.expectedSeconds || a.index - b.index)
      .map(({ approach }) =>
        new DebriefApproach({
          strategy: names.named(approach.strategy),
          steps: approach.steps,
          expectedSeconds: approach.expectedSeconds,
          validWhen: approach.validWhen,
          fromBook: approach.author === "book"
        })
      ),
    skill: question.primarySkill === null ? null : names.named(question.primarySkill),
    difficulty: question.difficulty,
    band: bandOf(question.difficulty)
  })
}
