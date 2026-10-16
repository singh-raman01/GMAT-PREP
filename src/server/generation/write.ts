import { max } from "drizzle-orm"
import { Clock, Effect } from "effect"
import type { Dataset } from "../../api/dataset.ts"
import { normalizeText } from "../../api/richText.ts"
import { sha256 } from "../access/tokens.ts"
import { comparableText, type ContentDraft, type Reason, type StimulusDraft } from "../books/linking.ts"
import { Db } from "../db/Database.ts"
import { datasets, options, parts, questions, statementPredicates, stimuli, taxonomyVersions } from "../db/schema.ts"
import { encodeColumns, encodeRows } from "../stimuli/stimuli.ts"
import { draftText } from "../stimuli/stimulusText.ts"
import type { SecondReadings } from "./generate.ts"
import { disagreements, type DraftItem } from "./items.ts"
import { describeValue, evaluate, type Predicate } from "./predicates.ts"

// Writes a generated item into the Question Bank: its Stimulus and Datasets,
// and each Question as a draft for enrichment and the Publish Gate, its Parts
// keyed by code and each Part's predicates kept beside it.

export interface ItemToWrite {
  readonly batchId: string
  readonly itemNumber: number
  readonly item: DraftItem
  readonly generator: { readonly model: string; readonly promptVersion: string }
  readonly seconds: SecondReadings
  // Problems found before writing, such as a chart that does not draw.
  readonly checks: ReadonlyArray<Reason>
}

const insertContent = (
  content: ContentDraft,
  dataset: Dataset | null,
  hash: string,
  now: number,
  tab?: { readonly parentId: string; readonly position: number; readonly title: string }
) =>
  Effect.gen(function*() {
    const db = yield* Db
    let datasetId: string | null = null
    if (dataset !== null && (content.kind === "table" || content.kind === "chart")) {
      datasetId = crypto.randomUUID()
      yield* db.insert(datasets).values({
        id: datasetId,
        columns: encodeColumns(dataset.columns),
        rows: encodeRows(dataset.rows),
        origin: "generator",
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
      figure: null,
      parentId: tab?.parentId ?? null,
      position: tab?.position ?? null,
      title: tab?.title ?? null,
      createdAt: now
    })
    return { id, datasetId }
  })

// The Stimulus and the ids of the Datasets its predicates read, by place.
const insertStimulus = (stimulus: StimulusDraft, data: ReadonlyArray<Dataset | null>, now: number) =>
  Effect.gen(function*() {
    const db = yield* Db
    const hash = sha256(`generated|${normalizeText(draftText(stimulus).text)}`)
    if (stimulus.kind !== "tabs") {
      const written = yield* insertContent(stimulus, data[0] ?? null, hash, now)
      return { id: written.id, hash, datasetIds: [written.datasetId] }
    }
    const id = crypto.randomUUID()
    yield* db.insert(stimuli).values({ id, kind: "tabs", body: "", normalizedHash: hash, createdAt: now })
    const datasetIds: Array<string | null> = []
    for (const [position, tab] of stimulus.tabs.entries()) {
      const written = yield* insertContent(tab, data[position] ?? null, sha256(`${hash}|${position}`), now, {
        parentId: id,
        position,
        title: tab.title
      })
      datasetIds.push(written.datasetId)
    }
    return { id, hash, datasetIds }
  })

const encodePredicate = (predicate: Predicate | null) => (predicate === null ? null : JSON.stringify(predicate))

export const writeItem = (input: ItemToWrite) =>
  Effect.gen(function*() {
    const db = yield* Db
    const now = yield* Clock.currentTimeMillis
    const { item } = input
    const [taxonomy] = yield* db.select({ version: max(taxonomyVersions.version) }).from(taxonomyVersions)
    const stimulus = yield* insertStimulus(item.stimulus, item.datasets, now)
    const ids: Array<string> = []
    for (const [index, question] of item.questions.entries()) {
      const seconds = input.seconds.predicates[index] ?? []
      const titles = item.stimulus.kind === "tabs" ? item.stimulus.tabs.map((tab) => tab.title) : []
      const reasons = [...input.checks, ...disagreements(question, item.datasets, seconds, titles)]
      const text = comparableText(question.stem, question.parts)
      const questionId = crypto.randomUUID()
      ids.push(questionId)
      yield* db.insert(questions).values({
        id: questionId,
        section: "di",
        questionType: item.questionType,
        stimulusId: stimulus.id,
        stem: question.stem,
        status: "draft",
        normalizedText: text,
        normalizedHash: sha256(`${stimulus.hash}|${text}`),
        bookLabel: null,
        taxonomyVersion: taxonomy?.version ?? 1,
        model: input.generator.model,
        promptVersion: input.generator.promptVersion,
        linkReasons: JSON.stringify(reasons),
        batchId: input.batchId,
        batchItem: input.itemNumber,
        createdAt: now,
        updatedAt: now
      })
      for (const [position, part] of question.parts.entries()) {
        const partId = crypto.randomUUID()
        yield* db.insert(parts).values({
          id: partId,
          questionId,
          position,
          kind: part.kind,
          prompt: part.prompt,
          key: part.key,
          keyBasis: part.statement.kind === "computed" ? "computed" : "generator"
        })
        yield* db.insert(options).values(part.options.map((option, place) => ({
          partId,
          position: place,
          label: option.label,
          text: option.text
        })))
        if (part.statement.kind === "inference") {
          yield* db.insert(statementPredicates).values({
            partId,
            kind: "inference",
            datasetId: null,
            predicate: null,
            second: null,
            result: null,
            secondResult: null,
            approximate: false,
            model: input.generator.model,
            promptVersion: input.generator.promptVersion,
            createdAt: now
          })
          continue
        }
        const dataset = item.datasets[part.statement.dataset] ?? null
        const second = seconds[position] ?? null
        // The second predicate runs on the tab its reading chose.
        const secondData = second === null ? null : item.datasets[second.dataset ?? part.statement.dataset] ?? null
        const again = second === null || secondData === null || part.kind === "column-choice"
          ? undefined
          : evaluate(second.predicate, secondData)
        yield* db.insert(statementPredicates).values({
          partId,
          kind: "computed",
          datasetId: stimulus.datasetIds[part.statement.dataset] ?? null,
          predicate: encodePredicate(part.statement.predicate),
          second: encodePredicate(second?.predicate ?? null),
          result: dataset === null ? null : part.kind === "column-choice" ? null : describeValue(part.statement.result, dataset),
          secondResult: again === undefined || secondData === null
            ? null
            : "problem" in again
            ? again.problem
            : describeValue(again.value, secondData),
          approximate: part.statement.approximate,
          model: input.seconds.model,
          promptVersion: input.seconds.promptVersion,
          createdAt: now
        })
      }
    }
    return ids
  })
