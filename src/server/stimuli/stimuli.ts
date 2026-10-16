import { asc, eq, inArray } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { CellValue, type Dataset, DatasetColumn } from "../../api/dataset.ts"
import { StimulusTab, StimulusView, stimulusImagePath } from "../../api/Stimulus.ts"
import { Db } from "../db/Database.ts"
import { datasets, stimuli } from "../db/schema.ts"

// Reading Stimuli and their Datasets as the screens show them.

const decodeColumns = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(DatasetColumn)))
const decodeRows = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Array(CellValue))))
export const encodeColumns = Schema.encodeSync(Schema.fromJsonString(Schema.Array(DatasetColumn)))
export const encodeRows = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Array(CellValue))))

// Where a figure kept as an image comes from, and its file.
export const FigureSource = Schema.Struct({
  bookId: Schema.String,
  page: Schema.Int,
  top: Schema.Finite,
  bottom: Schema.Finite,
  // The image file's hash; see FigureFiles.
  file: Schema.String
})
export type FigureSource = typeof FigureSource.Type
export const decodeFigure = Schema.decodeUnknownSync(Schema.fromJsonString(FigureSource))
export const encodeFigure = Schema.encodeSync(Schema.fromJsonString(FigureSource))

export const datasetOf = (row: typeof datasets.$inferSelect): Dataset => ({
  columns: decodeColumns(row.columns),
  rows: decodeRows(row.rows)
})

export const datasetsById = (ids: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const wanted = [...new Set(ids)]
    if (wanted.length === 0) return new Map<string, Dataset>()
    const db = yield* Db
    const rows = yield* db.select().from(datasets).where(inArray(datasets.id, wanted))
    return new Map(rows.map((row) => [row.id, datasetOf(row)] as const))
  })

type StimulusRow = typeof stimuli.$inferSelect

const contentOf = (row: StimulusRow, sets: ReadonlyMap<string, Dataset>) => ({
  body: row.body,
  dataset: row.datasetId === null ? null : sets.get(row.datasetId) ?? null,
  // A figure has an image only once its page band was drawn.
  image: row.kind === "chart" || (row.kind === "figure" && row.figure !== null) ? stimulusImagePath(row.id) : null
})

// Each Stimulus with its tabs, by id.
export const stimulusViews = (ids: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const wanted = [...new Set(ids)]
    if (wanted.length === 0) return new Map<string, StimulusView>()
    const db = yield* Db
    const own = yield* db.select().from(stimuli).where(inArray(stimuli.id, wanted))
    const tabs = yield* db.select().from(stimuli).where(inArray(stimuli.parentId, wanted)).orderBy(asc(stimuli.position))
    const sets = yield* datasetsById([...own, ...tabs].flatMap((row) => (row.datasetId === null ? [] : [row.datasetId])))
    return new Map(own.map((row) => [
      row.id,
      new StimulusView({
        id: row.id,
        kind: row.kind as StimulusView["kind"],
        ...contentOf(row, sets),
        tabs: tabs.filter((tab) => tab.parentId === row.id).map((tab) =>
          new StimulusTab({ title: tab.title ?? "", kind: tab.kind as StimulusTab["kind"], ...contentOf(tab, sets) })
        )
      })
    ] as const))
  })

// One Stimulus as stored, with its Dataset, for drawing its image.
export const storedStimulus = (id: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const [row] = yield* db.select().from(stimuli).where(eq(stimuli.id, id))
    if (row === undefined) return undefined
    const sets = yield* datasetsById(row.datasetId === null ? [] : [row.datasetId])
    return { row, dataset: row.datasetId === null ? null : sets.get(row.datasetId) ?? null }
  })
