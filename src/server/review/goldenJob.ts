import { and, asc, desc, eq } from "drizzle-orm"
import { Clock, Effect, Option, Schema } from "effect"
import { MapRange, type MapRole, type TypeGroup } from "../../api/Books.ts"
import { setKey } from "../../api/bookMapRules.ts"
import { GoldenReport } from "../../api/Golden.ts"
import { tagQuestion } from "../books/enrichment.ts"
import { type Candidate, linkSet } from "../books/linking.ts"
import { decodeReading, type PageReading, readPageAfresh, readsGroup } from "../books/readings.ts"
import { Db } from "../db/Database.ts"
import { bookMaps, books, goldenQuestions, goldenRunReadings, goldenRuns, goldenRunTags, sources } from "../db/schema.ts"
import type { JobKind } from "../jobs/JobKind.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { type GoldenEntry, type GoldenItem, goldenReport, type GoldenTags } from "./goldenReport.ts"

// Checks the golden set against the current prompts and models: the pages
// its Questions came from are read again, one a step, with their set's answer
// key and explanations, and each Question is tagged again, one a step.
// Nothing is stored in the Book's own readings. Last, the report.

const Params = Schema.Struct({ runId: Schema.String })

const Checkpoint = Schema.Struct({
  stage: Schema.Literals(["read", "tag", "report"]),
  // The next read or Question to tag.
  index: Schema.Int
})

export const GoldenExpected = Schema.Struct({
  questionType: Schema.String,
  stem: Schema.String,
  options: Schema.Array(Schema.Struct({ label: Schema.String, text: Schema.String })),
  key: Schema.NullOr(Schema.String),
  primarySkill: Schema.String,
  secondarySkills: Schema.Array(Schema.String)
})
const decodeExpected = Schema.decodeUnknownSync(Schema.fromJsonString(GoldenExpected))
const decodeRanges = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(MapRange)))
export const encodeReport = Schema.encodeSync(Schema.fromJsonString(GoldenReport))
export const decodeReport = Schema.decodeUnknownOption(Schema.fromJsonString(GoldenReport))

// The golden Questions, where their Book now has them, in book order.
const goldenRows = Effect.gen(function*() {
  const db = yield* Db
  const rows = yield* db.select({
    questionId: goldenQuestions.questionId,
    expected: goldenQuestions.expected,
    bookId: sources.bookId,
    set: sources.set,
    page: sources.page,
    number: sources.number
  }).from(goldenQuestions)
    .innerJoin(sources, and(eq(sources.questionId, goldenQuestions.questionId), eq(sources.bookId, goldenQuestions.bookId)))
    .orderBy(asc(sources.page), asc(sources.number))
    .pipe(Effect.orDie)
  return rows.map((row) => ({ ...row, expected: decodeExpected(row.expected) }))
})

interface PlannedRead {
  readonly page: number
  readonly role: MapRole
  readonly group: TypeGroup
}

const RoleOrder: Record<MapRole, number> = { "answer-key": 0, "explanations": 1, "questions": 2, "difficulty-labels": 3 }

// The ranges of the Book's latest confirmed Book Map.
const latestRanges = (bookId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const [map] = yield* db.select().from(bookMaps).where(eq(bookMaps.bookId, bookId))
      .orderBy(desc(bookMaps.version)).limit(1).pipe(Effect.orDie)
    const [book] = yield* db.select({ pageCount: books.pageCount }).from(books).where(eq(books.id, bookId))
      .pipe(Effect.orDie)
    return { ranges: map === undefined ? [] : decodeRanges(map.ranges), pageCount: book?.pageCount ?? 0 }
  })

// The pages to read again: each golden Question's own page, and every page
// of its set's answer key and explanations.
const plan = Effect.gen(function*() {
  const rows = yield* goldenRows
  const bookId = rows[0]?.bookId
  if (bookId === undefined) return { bookId: undefined, reads: [] as ReadonlyArray<PlannedRead>, rows }
  const { ranges, pageCount } = yield* latestRanges(bookId)
  const reads = new Map<string, PlannedRead>()
  const add = (read: PlannedRead) => {
    if (readsGroup(read.role, read.group)) reads.set(`${read.page}|${read.role}|${read.group}`, read)
  }
  for (const row of rows) {
    const mine = ranges.filter((range) => setKey(range.set) === setKey(row.set))
    const own = mine.find((range) => range.role === "questions" && range.firstPage <= row.page && row.page <= range.lastPage)
    if (own !== undefined) add({ page: row.page, role: "questions", group: own.group })
    for (const range of mine.filter((each) => each.role === "answer-key" || each.role === "explanations")) {
      for (let page = range.firstPage; page <= Math.min(range.lastPage, pageCount); page++) {
        add({ page, role: range.role, group: range.group })
      }
    }
  }
  return {
    bookId,
    reads: [...reads.values()].toSorted((a, b) => RoleOrder[a.role] - RoleOrder[b.role] || a.page - b.page),
    rows
  }
})

const readStep = (jobId: string, runId: string, index: number) =>
  Effect.gen(function*() {
    const db = yield* Db
    const planned = yield* plan
    const read = planned.reads[index]
    if (read === undefined || planned.bookId === undefined) {
      return {
        _tag: "Continue",
        checkpoint: { stage: "tag", index: 0 },
        stepsTotal: planned.reads.length + planned.rows.length + 1,
        note: "Tagging the golden Questions again"
      } as const
    }
    const fresh = yield* readPageAfresh({ jobId, bookId: planned.bookId, ...read })
    yield* db.insert(goldenRunReadings).values({ runId, page: read.page, role: read.role, group: read.group, items: fresh.items })
      .onConflictDoNothing().pipe(Effect.orDie)
    return {
      _tag: "Continue",
      checkpoint: { stage: "read", index: index + 1 },
      stepsTotal: planned.reads.length + planned.rows.length + 1,
      note: `Read page ${read.page} again (${planned.reads.length - index - 1} left)`
    } as const
  })

const tagStep = (jobId: string, runId: string, index: number) =>
  Effect.gen(function*() {
    const db = yield* Db
    const rows = yield* goldenRows
    const row = rows[index]
    if (row === undefined) {
      return { _tag: "Continue", checkpoint: { stage: "report", index: 0 }, stepsTotal: null, note: "Comparing" } as const
    }
    const taxonomy = (yield* Taxonomy).view
    const tagged = yield* tagQuestion(jobId, taxonomy, { ...row.expected, explanation: null }).pipe(
      Effect.catchTag("LlmInvalidReply", () => Effect.succeed(undefined))
    )
    yield* db.insert(goldenRunTags).values({
      runId,
      questionId: row.questionId,
      primarySkill: tagged?.value.primarySkill ?? null,
      secondarySkills: JSON.stringify(tagged?.value.secondarySkills ?? [])
    }).onConflictDoNothing().pipe(Effect.orDie)
    return {
      _tag: "Continue",
      checkpoint: { stage: "tag", index: index + 1 },
      stepsTotal: null,
      note: `Tagged ${index + 1} of ${rows.length} again`
    } as const
  })

const reportStep = (runId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const planned = yield* plan
    const stored = yield* db.select().from(goldenRunReadings).where(eq(goldenRunReadings.runId, runId)).pipe(Effect.orDie)
    const fresh = (page: number, role: MapRole): ReadonlyArray<PageReading> =>
      stored.filter((row) => row.page === page && row.role === role).flatMap((row) =>
        Option.toArray(decodeReading(row.role as MapRole, row.group as TypeGroup, row.items))
      )
    const { ranges, pageCount } = planned.bookId === undefined ? { ranges: [], pageCount: 0 } : yield* latestRanges(planned.bookId)
    const pagesOf = (set: string, role: MapRole) =>
      ranges.filter((range) => setKey(range.set) === setKey(set) && range.role === role).flatMap((range) =>
        Array.from({ length: Math.max(0, Math.min(range.lastPage, pageCount) - range.firstPage + 1) }, (_, i) => range.firstPage + i)
      )
    // Each set linked again from the fresh readings.
    const linked = new Map<string, ReadonlyArray<Candidate>>()
    for (const set of new Set(planned.rows.map((row) => setKey(row.set)))) {
      const pages = [...new Set(planned.rows.filter((row) => setKey(row.set) === set).map((row) => row.page))].toSorted((a, b) => a - b)
      const items = linkSet({
        questions: pages.flatMap((page) => fresh(page, "questions").map((reading) => ({ page, reading }))),
        answers: pagesOf(set, "answer-key").flatMap((page) => fresh(page, "answer-key")),
        explanations: pagesOf(set, "explanations").flatMap((page) => fresh(page, "explanations")),
        labels: []
      })
      linked.set(set, items.filter((item): item is Candidate => item._tag === "Candidate"))
    }
    const tags = yield* db.select().from(goldenRunTags).where(eq(goldenRunTags.runId, runId)).pipe(Effect.orDie)
    const entries = planned.rows.map((row): GoldenEntry => {
      const found = linked.get(setKey(row.set))?.find((item) => item.number === row.number && item.page === row.page)
      const tagged = tags.find((each) => each.questionId === row.questionId)
      const item: GoldenItem | null = found === undefined
        ? null
        : { stem: found.stem, options: found.options, key: found.key }
      const again: GoldenTags | null = tagged === undefined || tagged.primarySkill === null
        ? null
        : { primarySkill: tagged.primarySkill, secondarySkills: JSON.parse(tagged.secondarySkills) as ReadonlyArray<string> }
      return { questionId: row.questionId, set: row.set, number: row.number, expected: row.expected, item, tags: again }
    })
    const now = yield* Clock.currentTimeMillis
    const report = goldenReport(entries, now)
    yield* db.update(goldenRuns)
      .set({ report: encodeReport(report), finishedAt: now })
      .where(eq(goldenRuns.id, runId))
      .pipe(Effect.orDie)
    return {
      _tag: "Finished",
      result: `Golden set of ${report.items}: text exact on ${report.textExact}, Parts on ${report.partsExact}, keys on ${report.keysExact}; tags agree on ${
        Math.round(report.tagAgreement * 100)
      }%. ${report.passed ? "Passed." : "Failed."}`
    } as const
  })

export const GoldenCheck: JobKind<typeof Params.Type, typeof Checkpoint.Type> = {
  kind: "golden-check",
  params: Params,
  checkpoint: Checkpoint,
  label: () => "Checking the golden set",
  start: () => ({ stage: "read", index: 0 }),
  stepsTotal: () => null,
  step: ({ jobId, params, checkpoint }) =>
    checkpoint.stage === "read"
      ? readStep(jobId, params.runId, checkpoint.index)
      : checkpoint.stage === "tag"
      ? tagStep(jobId, params.runId, checkpoint.index)
      : reportStep(params.runId)
}
