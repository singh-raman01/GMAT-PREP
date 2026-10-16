import { and, desc, eq, isNotNull, isNull, lt } from "drizzle-orm"
import { Clock, Effect, Schema } from "effect"
import { MapRange } from "../../api/Books.ts"
import { Db } from "../db/Database.ts"
import { bookMapProposals, bookPages, books } from "../db/schema.ts"
import type { JobKind } from "../jobs/JobKind.ts"
import { assembleMap } from "./bookMap.ts"
import { readSurvey, SurveyPromptVersion, surveyPages } from "./survey.ts"

// The full run, for now: the Book Map model reads every page with text that
// the sample did not, ten at a time, and code joins the pages into the
// proposed Book Map, which waits for the Curator.

export const PagesPerBatch = 10

const Params = Schema.Struct({
  bookId: Schema.String,
  title: Schema.String,
  // Batches of pages to read when the run started, for its progress.
  batches: Schema.Int
})

const Checkpoint = Schema.Struct({ batchesDone: Schema.Int })

export const encodeRanges = Schema.encodeSync(Schema.fromJsonString(Schema.Array(MapRange)))

const surveyStep = (jobId: string, params: typeof Params.Type, batchesDone: number) =>
  Effect.gen(function*() {
    const db = yield* Db
    const next = yield* db.select({ number: bookPages.number, text: bookPages.text }).from(bookPages)
      .where(and(eq(bookPages.bookId, params.bookId), eq(bookPages.hasText, true), isNull(bookPages.survey)))
      .orderBy(bookPages.number)
      .limit(PagesPerBatch)
      .pipe(Effect.orDie)
    const [first, ...rest] = next
    if (first === undefined) return yield* proposeStep(params.bookId)

    // The chapter of the nearest surveyed page before the batch keeps chapter
    // names the same from one batch to the next.
    const [before] = yield* db.select({ survey: bookPages.survey }).from(bookPages)
      .where(and(eq(bookPages.bookId, params.bookId), lt(bookPages.number, first.number), isNotNull(bookPages.survey)))
      .orderBy(desc(bookPages.number))
      .limit(1)
      .pipe(Effect.orDie)
    const surveyed = yield* surveyPages({
      jobId,
      pages: [first, ...rest],
      chapterBefore: readSurvey(before?.survey ?? null)?.chapter ?? null
    })
    for (const [number, survey] of surveyed.surveys) {
      yield* db.update(bookPages).set({ survey: JSON.stringify(survey) })
        .where(and(eq(bookPages.bookId, params.bookId), eq(bookPages.number, number)))
        .pipe(Effect.orDie)
    }
    const last = next.at(-1)!.number
    return {
      _tag: "Continue",
      checkpoint: { batchesDone: batchesDone + 1 },
      stepsTotal: Math.max(params.batches, batchesDone + 1) + 1,
      note: first.number === last ? `Read page ${last}` : `Read pages ${first.number} to ${last}`
    } as const
  })

const proposeStep = (bookId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const pages = yield* db.select({ number: bookPages.number, survey: bookPages.survey }).from(bookPages)
      .where(eq(bookPages.bookId, bookId))
      .orderBy(bookPages.number)
      .pipe(Effect.orDie)
    const surveyed = pages.map((page) => ({ number: page.number, survey: readSurvey(page.survey) }))
    const ranges = assembleMap(surveyed).map((range) => new MapRange(range))
    const models = [...new Set(surveyed.flatMap((page) => (page.survey === null ? [] : [page.survey.model])))]
    const now = yield* Clock.currentTimeMillis
    yield* db.insert(bookMapProposals).values({
      id: crypto.randomUUID(),
      bookId,
      ranges: encodeRanges(ranges),
      model: models.join(", "),
      promptVersion: SurveyPromptVersion,
      createdAt: now
    }).pipe(Effect.orDie)
    // A map the Curator confirmed by hand meanwhile stays confirmed.
    yield* db.update(books).set({ status: "map-proposed", updatedAt: now })
      .where(and(eq(books.id, bookId), eq(books.status, "mapping")))
      .pipe(Effect.orDie)
    const sets = new Set(ranges.map((range) => range.set)).size
    return {
      _tag: "Finished",
      result: ranges.length === 0
        ? "Proposed an empty Book Map: no page looked like questions, keys or explanations."
        : `Proposed a Book Map of ${ranges.length} ${ranges.length === 1 ? "range" : "ranges"} in ${sets} ${
          sets === 1 ? "set" : "sets"
        }.`
    } as const
  })

export const BookMapping: JobKind<typeof Params.Type, typeof Checkpoint.Type> = {
  kind: "book-map",
  params: Params,
  checkpoint: Checkpoint,
  label: (params) => `Book Map for ${params.title}`,
  start: () => ({ batchesDone: 0 }),
  stepsTotal: (params) => params.batches + 1,
  step: ({ jobId, params, checkpoint }) => surveyStep(jobId, params, checkpoint.batchesDone)
}
