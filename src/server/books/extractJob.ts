import { and, asc, count, eq, inArray, max, sql } from "drizzle-orm"
import { Clock, Effect, Schema } from "effect"
import { MapRange, type MapRole, type TypeGroup } from "../../api/Books.ts"
import { setKey } from "../../api/bookMapRules.ts"
import { Db } from "../db/Database.ts"
import { bookMaps, bookPages, books, pageReadings, questions, sources } from "../db/schema.ts"
import type { JobKind } from "../jobs/JobKind.ts"
import { queueJob } from "../jobs/JobStore.ts"
import { runGate } from "../review/gate.ts"
import { QuestionRefresh, RefreshCap } from "../review/refreshJob.ts"
import { assignReserve, assignUndecided } from "../review/reserve.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import {
  type BankEntry,
  heldPages,
  holdUnreadPage,
  type Linked,
  linkCandidate,
  loadBank,
  loadPassages,
  recordSkip,
  retireStale
} from "./bankWrites.ts"
import { renderChart } from "../charts/charts.ts"
import type { FigureSource } from "../stimuli/stimuli.ts"
import { BookFiles } from "./BookFiles.ts"
import { enrichQuestion } from "./enrichment.ts"
import { FigureFiles } from "./FigureFiles.ts"
import { drawBand } from "./figures.ts"
import { type Candidate, contents, datasetOfDraft, linkSet, type Reason } from "./linking.ts"
import { questionBand } from "./pdf.ts"
import { type PageReading, readPage, readsGroup, storedReading } from "./readings.ts"

// Extraction for one Book Map version: every page of the ranges it can read
// is read once in its role, one page a step, then each question set is
// linked into the Question Bank, one set a step. Pages read for an earlier
// version are not read again, and linking changes only the items whose key,
// explanation or label changed. Once the latest version is linked, items it
// no longer produces leave the Question Bank, and each draft Question is
// enriched and put through the Publish Gate, one a step. Last, the Book's
// share of the Mock Reserve is decided.

const Params = Schema.Struct({ bookId: Schema.String, title: Schema.String, mapVersion: Schema.Int })

const Checkpoint = Schema.Struct({
  stage: Schema.Literals(["read", "link", "enrich"]),
  // Sets linked so far, in the order of setsOf.
  setsLinked: Schema.Int
})

const decodeRanges = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(MapRange)))

interface PlannedRead {
  readonly page: number
  readonly role: MapRole
  readonly group: TypeGroup
}

// Answer keys first: they are short, and a model or key problem shows early.
const RoleOrder: Record<MapRole, number> = { "answer-key": 0, "difficulty-labels": 1, "explanations": 2, "questions": 3 }

export interface SetPlan {
  readonly name: string
  readonly ranges: ReadonlyArray<MapRange>
}

// The question sets extraction can read, by name, in page order.
export const setsOf = (ranges: ReadonlyArray<MapRange>): ReadonlyArray<SetPlan> => {
  const sets = new Map<string, { name: string; ranges: Array<MapRange> }>()
  for (const range of ranges) {
    if (!readsGroup(range.role, range.group)) continue
    const key = setKey(range.set)
    const entry = sets.get(key) ?? { name: range.set, ranges: [] }
    entry.ranges.push(range)
    sets.set(key, entry)
  }
  return [...sets.values()]
    .filter((set) => set.ranges.some((range) => range.role === "questions"))
    .toSorted((a, b) =>
      Math.min(...a.ranges.map((range) => range.firstPage)) - Math.min(...b.ranges.map((range) => range.firstPage))
    )
}

const pagesOf = (range: MapRange, pageCount: number) =>
  Array.from({ length: Math.max(0, Math.min(range.lastPage, pageCount) - range.firstPage + 1) }, (_, i) => range.firstPage + i)

const loadPlan = (params: typeof Params.Type) =>
  Effect.gen(function*() {
    const db = yield* Db
    const [book] = yield* db.select().from(books).where(eq(books.id, params.bookId)).pipe(Effect.orDie)
    const [map] = yield* db.select().from(bookMaps)
      .where(and(eq(bookMaps.bookId, params.bookId), eq(bookMaps.version, params.mapVersion)))
      .pipe(Effect.orDie)
    if (book === undefined || map === undefined) return undefined
    const pageCount = book.pageCount ?? 0
    const sets = setsOf(decodeRanges(map.ranges))
    const pages = yield* db.select({ number: bookPages.number, hasText: bookPages.hasText, route: bookPages.route })
      .from(bookPages).where(eq(bookPages.bookId, params.bookId)).pipe(Effect.orDie)
    const withText = new Set(pages.filter((page) => page.hasText).map((page) => page.number))
    const reads = new Map<string, PlannedRead>()
    const unread = new Map<number, string>()
    for (const set of sets) {
      for (const range of set.ranges) {
        for (const page of pagesOf(range, pageCount)) {
          if (!withText.has(page)) {
            const route = pages.find((each) => each.number === page)?.route
            unread.set(
              page,
              route === "image"
                ? `Page ${page} has no text layer. Reading pages as images is not built yet, so read it in the PDF.`
                : `Page ${page} has no text layer, and the extraction model cannot read images. Read it in the PDF.`
            )
            continue
          }
          reads.set(`${page}|${range.role}|${range.group}`, { page, role: range.role, group: range.group })
        }
      }
    }
    const plan = [...reads.values()].toSorted((a, b) => RoleOrder[a.role] - RoleOrder[b.role] || a.page - b.page)
    return { book, sets, plan, unread, pageCount }
  })

const readStep = (jobId: string, params: typeof Params.Type, stepsDone: number) =>
  Effect.gen(function*() {
    const db = yield* Db
    const loaded = yield* loadPlan(params)
    if (loaded === undefined) return { _tag: "Finished", result: "The Book or its Book Map was removed." } as const
    const held = yield* heldPages(params.bookId)
    for (const [page, detail] of loaded.unread) {
      if (!held.has(page)) yield* holdUnreadPage(params.bookId, page, detail)
    }
    const done = yield* db.select({ page: pageReadings.page, role: pageReadings.role, group: pageReadings.group })
      .from(pageReadings).where(eq(pageReadings.bookId, params.bookId)).pipe(Effect.orDie)
    const read = new Set(done.map((row) => `${row.page}|${row.role}|${row.group}`))
    const left = loaded.plan.filter((entry) => !read.has(`${entry.page}|${entry.role}|${entry.group}`))
    const stepsTotal = stepsDone + left.length + loaded.sets.length + 1
    const next = left[0]
    if (next === undefined) {
      return {
        _tag: "Continue",
        checkpoint: { stage: "link", setsLinked: 0 },
        stepsTotal,
        note: "All pages read; linking each question to its key and explanation"
      } as const
    }
    yield* readPage({ jobId, bookId: params.bookId, page: next.page, role: next.role, group: next.group })
    return {
      _tag: "Continue",
      checkpoint: { stage: "read", setsLinked: 0 },
      stepsTotal,
      note: `Read page ${next.page} (${left.length - 1} left to read)`
    } as const
  })

const readingsOf = (bookId: string, set: { readonly ranges: ReadonlyArray<MapRange> }, role: MapRole, pageCount: number) =>
  Effect.gen(function*() {
    const found: Array<{ readonly page: number; readonly reading: PageReading }> = []
    for (const range of set.ranges.filter((each) => each.role === role)) {
      for (const page of pagesOf(range, pageCount)) {
        const reading = yield* storedReading(bookId, page, role, range.group)
        if (reading._tag === "Some") found.push({ page, reading: reading.value })
      }
    }
    return found.toSorted((a, b) => a.page - b.page)
  })

// Before an item is linked: each chart it draws must draw, and a figure its
// text does not hold is kept as the band of its page it sits in (ADR 0006).
// A page that cannot be drawn leaves the figure without an image; the
// Question is held for its figure either way.
const prepare = (bookId: string, candidate: Candidate, pdf: Effect.Effect<Uint8Array>) =>
  Effect.gen(function*() {
    const checks: Array<Reason> = []
    for (const content of contents(candidate.stimulus)) {
      if (content.kind !== "chart") continue
      const failed = yield* renderChart(content.spec, datasetOfDraft(content.table)).pipe(
        Effect.as(undefined),
        Effect.catchTag("ChartRenderFailed", (error) => Effect.succeed(error.detail))
      )
      if (failed !== undefined) checks.push({ code: "render", detail: `The chart does not draw: ${failed}` })
    }
    if (candidate.stimulus?.kind !== "figure") return { checks }
    const bytes = yield* pdf
    const band = yield* questionBand(bytes, candidate.page, candidate.number).pipe(
      Effect.orElseSucceed(() => ({ top: 0, bottom: 1 }))
    )
    const drawn = yield* Effect.result(drawBand(bytes, candidate.page, band))
    if (drawn._tag === "Failure") return { checks }
    const file = yield* (yield* FigureFiles).keep(drawn.success)
    const figure: FigureSource = { bookId, page: candidate.page, top: band.top, bottom: band.bottom, file }
    return { checks, figure }
  })

const linkStep = (params: typeof Params.Type, setsLinked: number, stepsDone: number) =>
  Effect.gen(function*() {
    const db = yield* Db
    const loaded = yield* loadPlan(params)
    if (loaded === undefined) return { _tag: "Finished", result: "The Book or its Book Map was removed." } as const
    const set = loaded.sets[setsLinked]
    if (set === undefined) {
      const now = yield* Clock.currentTimeMillis
      // A run for an older Book Map leaves the Book to the newer run.
      const [latest] = yield* db.select({ version: max(bookMaps.version) }).from(bookMaps)
        .where(eq(bookMaps.bookId, params.bookId)).pipe(Effect.orDie)
      const linked = `Linked ${loaded.sets.length} question ${loaded.sets.length === 1 ? "set" : "sets"}`
      if (latest?.version !== params.mapVersion) return { _tag: "Finished", result: `${linked}.` } as const
      const retired = yield* db.transaction(() =>
        Effect.gen(function*() {
          const { retired, sentBack } = yield* retireStale(params.bookId, params.mapVersion, new Set(loaded.unread.keys()))
          if (sentBack.length > 0) {
            yield* queueJob(
              QuestionRefresh,
              { questionIds: sentBack, reason: `Checking Questions ${params.title} no longer gives` },
              RefreshCap
            )
          }
          return retired
        })
      ).pipe(Effect.orDie)
      const drafts = yield* draftsOf(params.bookId)
      return {
        _tag: "Continue",
        checkpoint: { stage: "enrich", setsLinked },
        stepsTotal: stepsDone + drafts.length + 1,
        note: retired === 0
          ? `${linked}; checking each Question`
          : `${linked}; ${retired} ${retired === 1 ? "item has" : "items have"} left the Book Map; checking each Question`
      } as const
    }
    const questionReadings = yield* readingsOf(params.bookId, set, "questions", loaded.pageCount)
    const answerReadings = yield* readingsOf(params.bookId, set, "answer-key", loaded.pageCount)
    const explanationReadings = yield* readingsOf(params.bookId, set, "explanations", loaded.pageCount)
    const labelReadings = yield* readingsOf(params.bookId, set, "difficulty-labels", loaded.pageCount)
    const linked = linkSet({
      questions: questionReadings,
      answers: answerReadings.map((each) => each.reading),
      explanations: explanationReadings.map((each) => each.reading),
      labels: labelReadings.map((each) => each.reading)
    })
    // Each Question keeps the model and prompt that read its own page.
    const groups = [...new Set(set.ranges.filter((range) => range.role === "questions").map((range) => range.group))]
    const readers = new Map(
      (yield* db.select({ page: pageReadings.page, model: pageReadings.model, promptVersion: pageReadings.promptVersion })
        .from(pageReadings)
        .where(and(
          eq(pageReadings.bookId, params.bookId),
          eq(pageReadings.role, "questions"),
          inArray(pageReadings.group, groups)
        ))
        .pipe(Effect.orDie)).map((row) => [row.page, row] as const)
    )
    // Each Section's Questions, compared with the new ones of that Section.
    const banks = new Map<string, Array<BankEntry>>()
    const bankFor = (section: string) =>
      Effect.gen(function*() {
        const loaded = banks.get(section) ?? (yield* loadBank(section))
        banks.set(section, loaded)
        return loaded
      })
    const passages = yield* loadPassages
    // The Book's file, read once and only when a figure needs drawing.
    const files = yield* BookFiles
    const pdf = yield* Effect.cached(files.read(loaded.book.fileHash))
    const counts: Record<Linked, number> = { created: 0, merged: 0, relinked: 0, unchanged: 0, skipped: 0 }
    // Questions of other Books a repaired passage sent back to the Publish
    // Gate, which this run does not check.
    const sentBack = new Set<string>()
    for (const item of linked) {
      const reader = readers.get(item.page)
      if (item._tag === "Skip") {
        counts[yield* recordSkip(params.bookId, set.name, params.mapVersion, item)] += 1
        continue
      }
      const prepared = yield* prepare(params.bookId, item, pdf)
      const outcome = yield* linkCandidate({
        bookId: params.bookId,
        set: set.name,
        mapVersion: params.mapVersion,
        candidate: item,
        origin: { model: reader?.model ?? "", promptVersion: reader?.promptVersion ?? "" },
        checks: prepared.checks,
        ...(prepared.figure === undefined ? {} : { figure: prepared.figure })
      }, yield* bankFor(item.section), passages)
      counts[outcome.linked] += 1
      for (const id of outcome.sentBack) sentBack.add(id)
    }
    // Those that took a Source in the Book meanwhile are this run's to check.
    const inBook = sentBack.size === 0 ? [] : yield* db.selectDistinct({ id: sources.questionId }).from(sources)
      .where(and(eq(sources.bookId, params.bookId), inArray(sources.questionId, [...sentBack]))).pipe(Effect.orDie)
    const unchecked = [...sentBack].filter((id) => !inBook.some((row) => row.id === id))
    if (unchecked.length > 0) {
      yield* queueJob(
        QuestionRefresh,
        { questionIds: unchecked, reason: `Checking Questions whose passage ${params.title} gave a readable text` },
        RefreshCap
      ).pipe(Effect.orDie)
    }
    const summary = [
      counts.created > 0 ? `${counts.created} new` : undefined,
      counts.merged > 0 ? `${counts.merged} already in the Question Bank` : undefined,
      counts.relinked > 0 ? `${counts.relinked} relinked` : undefined,
      counts.skipped > 0 ? `${counts.skipped} skipped` : undefined
    ].filter((part) => part !== undefined)
    return {
      _tag: "Continue",
      checkpoint: { stage: "link", setsLinked: setsLinked + 1 },
      stepsTotal: stepsDone + (loaded.sets.length - setsLinked) + 1,
      note: `Linked ${set.name}${summary.length === 0 ? "" : `: ${summary.join(", ")}`}`
    } as const
  })

// Draft Questions with a Source in the Book, oldest first: the Book's new
// Questions, and those its re-linking sent back to the Publish Gate. One the
// run sent back that has no Source left in the Book gets a refresh job of
// its own.
const draftsOf = (bookId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const rows = yield* db.selectDistinct({ id: questions.id, createdAt: questions.createdAt, at: sql`${questions}.rowid` })
      .from(questions)
      .innerJoin(sources, and(eq(sources.questionId, questions.id), eq(sources.bookId, bookId)))
      .where(eq(questions.status, "draft"))
      .orderBy(asc(questions.createdAt), asc(sql`${questions}.rowid`))
      .pipe(Effect.orDie)
    return rows.map((row) => row.id)
  })

const enrichStep = (jobId: string, params: typeof Params.Type, setsLinked: number, stepsDone: number) =>
  Effect.gen(function*() {
    const db = yield* Db
    const drafts = yield* draftsOf(params.bookId)
    const next = drafts[0]
    if (next === undefined) {
      const joined = yield* assignReserve(params.bookId).pipe(Effect.orDie)
      const now = yield* Clock.currentTimeMillis
      yield* db.update(books).set({ status: "extracted", updatedAt: now })
        .where(and(eq(books.id, params.bookId), eq(books.status, "extracting")))
        .pipe(Effect.orDie)
      // Questions of other Books this run published.
      yield* assignUndecided.pipe(Effect.orDie)
      // The Book's own Questions, not those it only added a Source to.
      const own = yield* db.select({ status: questions.status, n: count() }).from(questions)
        .innerJoin(
          sources,
          and(eq(sources.questionId, questions.id), eq(sources.bookId, params.bookId), eq(sources.merged, false))
        )
        .where(inArray(questions.status, ["published", "held"]))
        .groupBy(questions.status)
        .pipe(Effect.orDie)
      const of = (status: string) => own.find((row) => row.status === status)?.n ?? 0
      return {
        _tag: "Finished",
        result: `${of("published")} Questions published, ${of("held")} held in the Review Queue; ${joined} joined the Mock Reserve.`
      } as const
    }
    const taxonomy = (yield* Taxonomy).view
    yield* enrichQuestion(jobId, taxonomy, next)
    const outcome = yield* runGate(next, taxonomy).pipe(Effect.orDie)
    return {
      _tag: "Continue",
      checkpoint: { stage: "enrich", setsLinked },
      stepsTotal: stepsDone + drafts.length + 1,
      note: `Checked a Question: ${outcome === "published" ? "published" : "held for review"} (${drafts.length - 1} left)`
    } as const
  })

export const BookExtraction: JobKind<typeof Params.Type, typeof Checkpoint.Type> = {
  kind: "book-extract",
  params: Params,
  checkpoint: Checkpoint,
  label: (params) => `Extracting ${params.title}`,
  start: () => ({ stage: "read", setsLinked: 0 }),
  stepsTotal: () => null,
  // A run that ends early still decides the Reserve for what it published,
  // so those Questions do not wait out of Practice Sets.
  stopped: (params) => assignReserve(params.bookId).pipe(Effect.orDie, Effect.asVoid),
  step: ({ jobId, params, checkpoint, stepsDone }) =>
    checkpoint.stage === "read"
      ? readStep(jobId, params, stepsDone)
      : checkpoint.stage === "link"
      ? linkStep(params, checkpoint.setsLinked, stepsDone)
      : enrichStep(jobId, params, checkpoint.setsLinked, stepsDone)
}
