import { Clock, Effect } from "effect"
import { Db } from "../../src/server/db/Database.ts"
import type { Dataset } from "../../src/api/dataset.ts"
import {
  approaches,
  books,
  datasets,
  optionNotes,
  options,
  parts,
  questions,
  sources,
  stimuli
} from "../../src/server/db/schema.ts"
import { encodeColumns, encodeFigure, encodeRows } from "../../src/server/stimuli/stimuli.ts"

// A Question Bank as ingestion leaves it, written straight to the database
// so Practice Set tests can choose what each Question carries.

export interface SeedApproach {
  readonly strategy: string
  readonly expectedSeconds: number
  readonly answer?: string
  readonly author?: "book" | "llm"
  readonly validWhen?: string
}

export interface SeedQuestion {
  readonly number: number
  readonly set?: string
  // Defaults to the number, one item a page.
  readonly page?: number
  readonly questionType?: string
  readonly primarySkill?: string | null
  readonly secondarySkills?: ReadonlyArray<string>
  readonly seed?: number
  readonly status?: "draft" | "held" | "published" | "withdrawn"
  readonly reserve?: boolean
  readonly key?: string
  readonly approaches?: ReadonlyArray<SeedApproach>
  // The passage it asks about; items with the same text share one Stimulus.
  readonly passage?: string
  // Or another Stimulus; items with the same share key share it.
  readonly stimulus?: SeedStimulus & { readonly share?: string }
  // Parts other than one of five options keyed by key.
  readonly parts?: ReadonlyArray<SeedPart>
}

export type SeedContent =
  | { readonly kind: "passage"; readonly body: string }
  | { readonly kind: "table"; readonly body?: string; readonly dataset: Dataset }
  | { readonly kind: "chart"; readonly body?: string; readonly dataset: Dataset; readonly spec: unknown }
  | { readonly kind: "figure"; readonly body?: string; readonly file: string }

export type SeedStimulus =
  | SeedContent
  | { readonly kind: "tabs"; readonly tabs: ReadonlyArray<SeedContent & { readonly title: string }> }

export interface SeedPart {
  readonly kind: "single-choice" | "two-choice" | "dropdown" | "column-choice"
  readonly prompt: string | null
  readonly options: ReadonlyArray<string>
  // The right option's label: A for the first option, B for the second, and
  // on through the alphabet.
  readonly key: string
}

// A Dataset from rows of printed cells, each parsed for its column.
export const datasetOf = (
  columns: Dataset["columns"],
  rows: ReadonlyArray<ReadonlyArray<string>>,
  values: (column: number, text: string) => number | string | null
): Dataset => ({
  columns,
  rows: rows.map((row) => row.map((text, index) => ({ text, value: values(index, text) })))
})

export const PsSkill = "quant.algebra.linear-equations"
export const OtherPsSkill = "quant.word-problems.percents"
export const Labels = ["A", "B", "C", "D", "E"] as const

const sectionOf = (questionType: string) => questionType.slice(0, questionType.indexOf("."))

// Adds a Book and its items; returns the Book's id and each item's
// Question id by number.
export const seedBook = (title: string, items: ReadonlyArray<SeedQuestion>) =>
  Effect.gen(function*() {
    const db = yield* Db
    const now = yield* Clock.currentTimeMillis
    const bookId = crypto.randomUUID()
    yield* db.insert(books).values({
      id: bookId,
      title,
      edition: "",
      official: true,
      fileHash: crypto.randomUUID(),
      fileSize: 1,
      status: "extracted",
      createdAt: now,
      updatedAt: now
    })
    const ids = new Map<number, string>()
    const passages = new Map<string, string>()
    const shared = new Map<string, string>()
    const insertContent = (content: SeedContent, extra: { parentId?: string; position?: number; title?: string } = {}) =>
      Effect.gen(function*() {
        const id = crypto.randomUUID()
        let datasetId: string | null = null
        if (content.kind === "table" || content.kind === "chart") {
          datasetId = crypto.randomUUID()
          yield* db.insert(datasets).values({
            id: datasetId,
            columns: encodeColumns(content.dataset.columns),
            rows: encodeRows(content.dataset.rows),
            origin: "book",
            createdAt: now
          })
        }
        yield* db.insert(stimuli).values({
          id,
          kind: content.kind,
          body: content.body ?? "",
          normalizedHash: crypto.randomUUID(),
          datasetId,
          chartSpec: content.kind === "chart" ? JSON.stringify(content.spec) : null,
          figure: content.kind === "figure"
            ? encodeFigure({ bookId, page: 1, top: 0, bottom: 1, file: content.file })
            : null,
          parentId: extra.parentId ?? null,
          position: extra.position ?? null,
          title: extra.title ?? null,
          createdAt: now
        })
        return id
      })
    for (const item of items) {
      const questionId = crypto.randomUUID()
      let stimulusId: string | null = null
      if (item.passage !== undefined) {
        stimulusId = passages.get(item.passage) ?? crypto.randomUUID()
        if (!passages.has(item.passage)) {
          yield* db.insert(stimuli).values({
            id: stimulusId,
            kind: "passage",
            body: item.passage,
            normalizedHash: crypto.randomUUID(),
            createdAt: now
          })
          passages.set(item.passage, stimulusId)
        }
      }
      const stimulus = item.stimulus
      if (stimulus !== undefined) {
        const known = stimulus.share === undefined ? undefined : shared.get(stimulus.share)
        if (known !== undefined) stimulusId = known
        else if (stimulus.kind === "tabs") {
          stimulusId = crypto.randomUUID()
          yield* db.insert(stimuli).values({
            id: stimulusId,
            kind: "tabs",
            body: "",
            normalizedHash: crypto.randomUUID(),
            createdAt: now
          })
          for (const [position, tab] of stimulus.tabs.entries()) {
            yield* insertContent(tab, { parentId: stimulusId, position, title: tab.title })
          }
        } else stimulusId = yield* insertContent(stimulus)
        if (stimulus.share !== undefined) shared.set(stimulus.share, stimulusId)
      }
      const questionType = item.questionType ?? "quant.ps"
      const key = item.key ?? "C"
      const stem = `${title} item ${item.number}: what is \\(x\\)?`
      yield* db.insert(questions).values({
        id: questionId,
        section: sectionOf(questionType),
        questionType,
        stem,
        status: item.status ?? "published",
        normalizedText: stem.toLowerCase(),
        normalizedHash: crypto.randomUUID(),
        taxonomyVersion: 1,
        model: "seed",
        promptVersion: "seed",
        primarySkill: item.primarySkill === undefined ? PsSkill : item.primarySkill,
        secondarySkills: JSON.stringify(item.secondarySkills ?? []),
        difficultyEstimate: item.seed ?? 0,
        difficultySeed: item.seed ?? 0,
        difficultyBasis: "estimate",
        enrichment: "done",
        reserve: item.reserve ?? false,
        reserveDecidedAt: now,
        stimulusId,
        createdAt: now,
        updatedAt: now
      })
      const seeded: ReadonlyArray<SeedPart> = item.parts ??
        [{ kind: "single-choice", prompt: null, options: Labels.map((_, index) => `\\(${index + 1}\\)`), key }]
      for (const [partPosition, part] of seeded.entries()) {
        const partId = crypto.randomUUID()
        yield* db.insert(parts).values({
          id: partId,
          questionId,
          position: partPosition,
          kind: part.kind,
          prompt: part.prompt,
          key: part.key,
          keyBasis: "book"
        })
        for (const [position, text] of part.options.entries()) {
          const label = String.fromCharCode(65 + position)
          yield* db.insert(options).values({ partId, position, label, text })
          if (label !== part.key) {
            yield* db.insert(optionNotes).values({
              partId,
              position,
              trapNote: `${label} tempts by answering a different quantity.`,
              mistakeType: position % 2 === 0 ? "trap" : "calculation-slip",
              trapPattern: position % 2 === 0 ? "quant.trap.wrong-quantity" : null,
              model: "seed",
              promptVersion: "seed",
              createdAt: now
            })
          }
        }
      }
      const routes = item.approaches ?? [
        { strategy: "quant.strategy.solve-directly", expectedSeconds: 90, author: "book" as const },
        { strategy: "quant.strategy.work-backward", expectedSeconds: 60 }
      ]
      for (const [position, route] of routes.entries()) {
        yield* db.insert(approaches).values({
          id: crypto.randomUUID(),
          questionId,
          position,
          strategy: route.strategy,
          steps: `Route ${position + 1} for item ${item.number}.`,
          expectedSeconds: route.expectedSeconds,
          validWhen: route.validWhen ?? "When the options are numbers.",
          author: route.author ?? "llm",
          answer: route.answer ?? seeded.map((part) => part.key).join(","),
          model: "seed",
          promptVersion: "seed",
          createdAt: now
        })
      }
      yield* db.insert(sources).values({
        id: crypto.randomUUID(),
        questionId,
        bookId,
        set: item.set ?? "Problem Solving",
        number: item.number,
        page: item.page ?? item.number,
        bookKey: key,
        explanation: "Route 1.",
        explanationAnswer: key,
        merged: false,
        mapVersion: 1,
        createdAt: now
      })
      ids.set(item.number, questionId)
    }
    return { bookId, ids }
  }).pipe(Effect.orDie)

// Items numbered from 1 to n with the same settings.
export const numbered = (n: number, settings: Omit<SeedQuestion, "number"> = {}, from = 1): Array<SeedQuestion> =>
  Array.from({ length: n }, (_, i) => ({ ...settings, number: from + i }))
