import { asc, eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { bandOf } from "../../api/difficulty.ts"
import {
  Debrief,
  DebriefApproach,
  Named,
  type PartKind,
  PracticePart,
  PracticeQuestion,
  type Selection,
  TrapNoteView
} from "../../api/Practice.ts"
import { QuestionId } from "../../api/Review.ts"
import type { StimulusView } from "../../api/Stimulus.ts"
import type { TaxonomyView } from "../../api/Taxonomy.ts"
import { Db } from "../db/Database.ts"
import { approaches, books, difficulty, optionNotes, options, parts, questions, sources } from "../db/schema.ts"
import { stimulusViews } from "../stimuli/stimuli.ts"
import { currentDifficulty, isCorrect } from "./history.ts"

// A served Question's stored content, and the Debrief built from it. The
// Debrief makes no LLM call: everything in it was written at ingestion.

export interface StoredQuestion {
  readonly id: string
  readonly section: string
  readonly questionType: string
  // What it asks about: a passage, a table, a chart, a figure or tabs.
  readonly stimulus: StimulusView | null
  readonly stem: string
  readonly primarySkill: string | null
  readonly difficulty: number
  // Whether its Approaches and Trap Notes are written for its current key
  // and explanation; after a change they wait to be written again.
  readonly enrichment: string
  readonly parts: ReadonlyArray<{
    readonly position: number
    readonly kind: PartKind
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
    const rows = yield* db.select({ question: questions, difficulty: currentDifficulty })
      .from(questions)
      .leftJoin(difficulty, eq(difficulty.questionId, questions.id))
      .where(inArray(questions.id, wanted))
    const shown = yield* stimulusViews(rows.flatMap(({ question }) => (question.stimulusId === null ? [] : [question.stimulusId])))
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
        stimulus: question.stimulusId === null ? null : shown.get(question.stimulusId) ?? null,
        stem: question.stem,
        primarySkill: question.primarySkill,
        difficulty: Number(value),
        enrichment: question.enrichment,
        parts: partRows.filter((part) => part.questionId === question.id).map((part) => ({
          position: part.position,
          kind: part.kind as PartKind,
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

// The Question as a Learner sees it, with where a Book prints it: the place
// the set serves it at, else its first place in the Book the set follows,
// else its first Source.
export const practiceQuestion = (
  question: StoredQuestion,
  names: Names,
  bookId: string | null,
  place?: { readonly set: string; readonly number: number }
) => {
  const inBook = question.sources.filter((each) => each.bookId === bookId)
  const source = inBook.find((each) => place !== undefined && each.set === place.set && each.number === place.number) ??
    inBook[0] ?? question.sources[0]
  return new PracticeQuestion({
    id: QuestionId.make(question.id),
    section: names.named(question.section),
    questionType: names.named(question.questionType),
    stimulus: question.stimulus,
    stem: question.stem,
    parts: question.parts.map((part) =>
      new PracticePart({ position: part.position, kind: part.kind, prompt: part.prompt, options: part.options })
    ),
    source: source === undefined
      ? null
      : { bookTitle: source.bookTitle, set: source.set, number: source.number, page: source.page }
  })
}

// An Approach's answer: the option it reaches in each Part, in order,
// joined with commas, such as C for one Part or A,B for two; undefined
// while a Part has no key.
export const approachAnswer = (choices: ReadonlyArray<string | null>) =>
  choices.every((choice) => choice !== null) ? choices.join(",") : undefined

// The Trap Note for each wrong option picked, and the Approaches that reach
// the current key, fastest first. Trap Notes written before a key change are
// left out until they are written again.
export const debriefOf = (question: StoredQuestion, selection: Selection, names: Names) => {
  const keys = question.parts.map((part) => ({ position: part.position, key: part.key }))
  const trapNotes = question.enrichment !== "done" ? [] : question.parts.flatMap((part) => {
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
  // An Approach names the option it reaches in each Part, in order; one
  // written against a key since replaced is left out.
  const answer = approachAnswer(keys.map((key) => key.key))
  const valid = question.approaches.filter((approach) => answer !== undefined && approach.answer === answer)
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
