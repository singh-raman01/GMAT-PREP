import { and, asc, desc, eq, inArray } from "drizzle-orm"
import { Clock, Effect, Option, Schema } from "effect"
import { MapRange, type MapRole, type TypeGroup } from "../../api/Books.ts"
import { setKey } from "../../api/bookMapRules.ts"
import { GoldenReport } from "../../api/Golden.ts"
import { tagQuestion } from "../books/enrichment.ts"
import { type Candidate, linkSet } from "../books/linking.ts"
import { decodeReading, type PageReading, readPageAfresh, readsGroup, storedReading } from "../books/readings.ts"
import { Db } from "../db/Database.ts"
import { bookMaps, books, goldenQuestions, goldenRunReadings, goldenRuns, goldenRunTags, sources } from "../db/schema.ts"
import type { JobKind } from "../jobs/JobKind.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { type GoldenEntry, type GoldenItem, goldenReport, type GoldenTags } from "./goldenReport.ts"
import { PartKind } from "../../api/Practice.ts"
import { draftText } from "../stimuli/stimulusText.ts"

// Checks the golden set against the current prompts and models: the pages
// its Questions came from are read again, one a step, with their set's answer
// key and explanations, and each Question is tagged again, one a step.
// Nothing is stored in the Book's own readings. Last, the report.

const Params = Schema.Struct({
  runId: Schema.String,
  // The golden Questions when the check started; absent from checks queued
  // before the field was added, which take the set as it is.
  questionIds: Schema.optional(Schema.Array(Schema.String))
})

const Checkpoint = Schema.Struct({
  stage: Schema.Literals(["read", "tag", "report"]),
  // The next read or Question to tag.
  index: Schema.Int
})

const Option_ = Schema.Struct({ label: Schema.String, text: Schema.String })

export const GoldenExpected = Schema.Struct({
  questionType: Schema.String,
  // What it asks about, written out under its label; see stimulusText.ts.
  stimulus: Schema.optional(Schema.NullOr(Schema.String)),
  // An approval from before Stimuli of other kinds: an RC passage alone.
  passage: Schema.optional(Schema.NullOr(Schema.String)),
  stem: Schema.String,
  // The first Part's options; parts gives every Part.
  options: Schema.Array(Option_),
  parts: Schema.optional(Schema.Array(Schema.Struct({
    kind: PartKind,
    prompt: Schema.NullOr(Schema.String),
    options: Schema.Array(Option_)
  }))),
  // Each Part's key, joined.
  key: Schema.NullOr(Schema.String),
  primarySkill: Schema.String,
  secondarySkills: Schema.Array(Schema.String)
})
type GoldenExpected = typeof GoldenExpected.Type

// What an approval expects, however old it is.
const expectedStimulus = (expected: GoldenExpected) =>
  expected.stimulus ?? (expected.passage === undefined || expected.passage === null ? null : `The passage:\n${expected.passage}`)

const expectedParts = (expected: GoldenExpected) =>
  expected.parts ?? [{ kind: "single-choice" as const, prompt: null, options: expected.options }]
const decodeExpected = Schema.decodeUnknownSync(Schema.fromJsonString(GoldenExpected))
const decodeRanges = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(MapRange)))
export const encodeReport = Schema.encodeSync(Schema.fromJsonString(GoldenReport))
export const decodeReport = Schema.decodeUnknownOption(Schema.fromJsonString(GoldenReport))

// The golden Questions the check covers, at their own items in their Book
// as it has them now, in book order. Another Source the Question has in that
// Book is another item, not the one approved.
const goldenRows = (questionIds: ReadonlyArray<string> | undefined) =>
  Effect.gen(function*() {
    const db = yield* Db
    const rows = yield* db.select({
      questionId: goldenQuestions.questionId,
      expected: goldenQuestions.expected,
      bookId: sources.bookId,
      set: sources.set,
      page: sources.page,
      number: sources.number,
      explanation: sources.explanation
    }).from(goldenQuestions)
      .innerJoin(
        sources,
        and(
          eq(sources.questionId, goldenQuestions.questionId),
          eq(sources.bookId, goldenQuestions.bookId),
          eq(sources.merged, false)
        )
      )
      .where(questionIds === undefined ? undefined : inArray(goldenQuestions.questionId, [...questionIds]))
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

// How many pages before its question a passage or an MSR set may start,
// when the Book's own readings do not say.
const PassageReach = 3

// Whether a page's reading names the question in a passage or an MSR set's
// source.
const names = (reading: PageReading, number: number) =>
  reading.role !== "questions"
    ? false
    : reading.group === "rc"
    ? reading.value.passages.some((passage) => passage.text.trim() !== "" && passage.questions.includes(number))
    : reading.group === "msr"
    ? reading.value.sources.some((source) => source.questions.includes(number))
    : reading.group === "ir"
    ? reading.value.msr.sources.some((source) => source.questions.includes(number))
    : false

// The page where what a golden Question asks about starts, as the Book's own
// readings give it: an RC passage, or the first of an MSR set's sources.
// Going back from the Question's page within its set's ranges, it is the
// first of the nearest run of pages that name the Question.
const stimulusPage = (
  bookId: string,
  row: { readonly page: number; readonly number: number },
  ranges: ReadonlyArray<MapRange>
) =>
  Effect.gen(function*() {
    const pages = ranges.flatMap((range) =>
      Array.from({ length: Math.max(0, Math.min(range.lastPage, row.page) - range.firstPage + 1) }, (_, i) => ({
        page: range.firstPage + i,
        group: range.group
      }))
    ).toSorted((a, b) => b.page - a.page)
    let start: number | undefined
    for (const { page, group } of pages) {
      const reading = yield* storedReading(bookId, page, "questions", group)
      const naming = Option.isSome(reading) && names(reading.value, row.number)
      if (naming) start = page
      else if (start !== undefined) break
    }
    return start
  })

// The pages to read again: each golden Question's own page, the pages from
// where its passage or sources start, and every page of its set's answer key and
// explanations. Only its own set's pages are read, so another set's
// numbers never mix in; questionPages holds each set's question pages.
const plan = (questionIds: ReadonlyArray<string> | undefined) => Effect.gen(function*() {
  const rows = yield* goldenRows(questionIds)
  const bookId = rows[0]?.bookId
  const questionPages = new Map<string, Map<number, TypeGroup>>()
  if (bookId === undefined) return { bookId: undefined, reads: [] as ReadonlyArray<PlannedRead>, rows, questionPages }
  const { ranges, pageCount } = yield* latestRanges(bookId)
  const reads = new Map<string, PlannedRead>()
  const add = (read: PlannedRead) => {
    if (readsGroup(read.role, read.group)) reads.set(`${read.page}|${read.role}|${read.group}`, read)
  }
  for (const row of rows) {
    const set = setKey(row.set)
    const mine = ranges.filter((range) => setKey(range.set) === set)
    const asked = mine.filter((range) => range.role === "questions")
    const own = asked.find((range) => range.firstPage <= row.page && row.page <= range.lastPage)
    if (own === undefined) continue
    const pages = questionPages.get(set) ?? new Map<number, TypeGroup>()
    questionPages.set(set, pages)
    const question = (page: number) => {
      const range = asked.find((each) => each.firstPage <= page && page <= each.lastPage)
      if (range === undefined || !readsGroup("questions", range.group)) return
      add({ page, role: "questions", group: range.group })
      pages.set(page, range.group)
    }
    question(row.page)
    // A passage or an MSR set's sources start on its question's page or
    // before it.
    if (own.group === "rc" || own.group === "msr" || own.group === "ir") {
      const from = (yield* stimulusPage(bookId, row, asked)) ?? row.page - PassageReach
      for (let page = Math.max(1, from); page < row.page; page++) question(page)
    }
    for (const range of mine.filter((each) => each.role === "answer-key" || each.role === "explanations")) {
      for (let page = range.firstPage; page <= Math.min(range.lastPage, pageCount); page++) {
        add({ page, role: range.role, group: range.group })
      }
    }
  }
  return {
    bookId,
    reads: [...reads.values()].toSorted((a, b) => RoleOrder[a.role] - RoleOrder[b.role] || a.page - b.page),
    rows,
    questionPages
  }
})

const readStep = (jobId: string, params: typeof Params.Type, index: number) =>
  Effect.gen(function*() {
    const db = yield* Db
    const runId = params.runId
    const planned = yield* plan(params.questionIds)
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

const tagStep = (jobId: string, params: typeof Params.Type, index: number) =>
  Effect.gen(function*() {
    const db = yield* Db
    const runId = params.runId
    const rows = yield* goldenRows(params.questionIds)
    const row = rows[index]
    if (row === undefined) {
      return { _tag: "Continue", checkpoint: { stage: "report", index: 0 }, stepsTotal: null, note: "Comparing" } as const
    }
    const taxonomy = (yield* Taxonomy).view
    // Tagged with the input production tagging has, the Book's explanation
    // included.
    const stimulus = expectedStimulus(row.expected)
    const split = stimulus?.indexOf(":\n") ?? -1
    const tagged = yield* tagQuestion(jobId, taxonomy, {
      questionType: row.expected.questionType,
      stimulus: stimulus === null
        ? null
        : { label: stimulus.slice(0, Math.max(0, split)), text: stimulus.slice(split + 2) },
      stem: row.expected.stem,
      parts: expectedParts(row.expected),
      key: row.expected.key,
      explanation: row.explanation
    }).pipe(
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

const reportStep = (params: typeof Params.Type) =>
  Effect.gen(function*() {
    const db = yield* Db
    const runId = params.runId
    const planned = yield* plan(params.questionIds)
    const stored = yield* db.select().from(goldenRunReadings).where(eq(goldenRunReadings.runId, runId)).pipe(Effect.orDie)
    const taxonomy = (yield* Taxonomy).view
    const fresh = (page: number, role: MapRole, group: TypeGroup): ReadonlyArray<PageReading> =>
      stored.filter((row) => row.page === page && row.role === role && row.group === group).flatMap((row) =>
        Option.toArray(decodeReading(row.role as MapRole, row.group as TypeGroup, row.items, taxonomy))
      )
    const { ranges, pageCount } = planned.bookId === undefined ? { ranges: [], pageCount: 0 } : yield* latestRanges(planned.bookId)
    const pagesOf = (set: string, role: MapRole) =>
      ranges.filter((range) => setKey(range.set) === set && range.role === role).flatMap((range) =>
        Array.from(
          { length: Math.max(0, Math.min(range.lastPage, pageCount) - range.firstPage + 1) },
          (_, i) => [range.firstPage + i, range.group] as const
        )
      )
    // Each set linked again from the fresh readings of its own pages.
    const linked = new Map<string, ReadonlyArray<Candidate>>()
    for (const [set, pages] of planned.questionPages) {
      const items = linkSet({
        questions: [...pages].toSorted(([a], [b]) => a - b).flatMap(([page, group]) =>
          fresh(page, "questions", group).map((reading) => ({ page, reading }))
        ),
        answers: pagesOf(set, "answer-key").flatMap(([page, group]) => fresh(page, "answer-key", group)),
        explanations: pagesOf(set, "explanations").flatMap(([page, group]) => fresh(page, "explanations", group)),
        labels: []
      })
      linked.set(set, items.filter((item): item is Candidate => item._tag === "Candidate"))
    }
    const tags = yield* db.select().from(goldenRunTags).where(eq(goldenRunTags.runId, runId)).pipe(Effect.orDie)
    const entries = planned.rows.map((row): GoldenEntry => {
      const found = linked.get(setKey(row.set))?.find((item) => item.number === row.number && item.page === row.page)
      const tagged = tags.find((each) => each.questionId === row.questionId)
      const quoted = found?.stimulus === null || found === undefined ? null : draftText(found.stimulus)
      const item: GoldenItem | null = found === undefined
        ? null
        : {
          stimulus: quoted === null ? null : `${quoted.label}:\n${quoted.text}`,
          stem: found.stem,
          parts: found.parts.map((part) => ({ prompt: part.prompt, options: part.options })),
          key: found.key
        }
      const again: GoldenTags | null = tagged === undefined || tagged.primarySkill === null
        ? null
        : {
          // A Question not found again is reported as such; its type is not
          // held against tag agreement too.
          questionType: found?.questionType ?? row.expected.questionType,
          primarySkill: tagged.primarySkill,
          secondarySkills: JSON.parse(tagged.secondarySkills) as ReadonlyArray<string>
        }
      return {
        questionId: row.questionId,
        set: row.set,
        number: row.number,
        expected: {
          ...row.expected,
          stimulus: expectedStimulus(row.expected),
          parts: expectedParts(row.expected).map((part) => ({ prompt: part.prompt, options: part.options }))
        },
        item,
        tags: again
      }
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
      ? readStep(jobId, params, checkpoint.index)
      : checkpoint.stage === "tag"
      ? tagStep(jobId, params, checkpoint.index)
      : reportStep(params)
}
