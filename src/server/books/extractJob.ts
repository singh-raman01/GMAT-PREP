import { and, eq, max } from "drizzle-orm"
import { Clock, Effect, Schema } from "effect"
import { MapRange, type MapRole, type TypeGroup } from "../../api/Books.ts"
import { setKey } from "../../api/bookMapRules.ts"
import { Db } from "../db/Database.ts"
import { bookMaps, bookPages, books, pageReadings } from "../db/schema.ts"
import type { JobKind } from "../jobs/JobKind.ts"
import { heldPages, holdUnreadPage, type Linked, linkCandidate, loadBank, recordSkip } from "./bankWrites.ts"
import { linkSet } from "./linking.ts"
import { type PageReading, readPage, readsGroup, storedReading } from "./readings.ts"

// Extraction for one Book Map version: every page of the ranges it can read
// is read once in its role, one page a step, then each question set is
// linked into the Question Bank, one set a step. Pages read for an earlier
// version are not read again, and linking changes only the items whose key,
// explanation or label changed.

const Params = Schema.Struct({ bookId: Schema.String, title: Schema.String, mapVersion: Schema.Int })

const Checkpoint = Schema.Struct({
  stage: Schema.Literals(["read", "link"]),
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
      if (latest?.version === params.mapVersion) {
        yield* db.update(books).set({ status: "extracted", updatedAt: now })
          .where(and(eq(books.id, params.bookId), eq(books.status, "extracting")))
          .pipe(Effect.orDie)
      }
      return { _tag: "Finished", result: `Linked ${loaded.sets.length} question ${loaded.sets.length === 1 ? "set" : "sets"}.` } as const
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
    const [first] = yield* db.select({ model: pageReadings.model, promptVersion: pageReadings.promptVersion })
      .from(pageReadings)
      .where(and(eq(pageReadings.bookId, params.bookId), eq(pageReadings.role, "questions"), eq(pageReadings.group, "ps")))
      .limit(1)
      .pipe(Effect.orDie)
    const bank = yield* loadBank("quant")
    const counts: Record<Linked, number> = { created: 0, merged: 0, relinked: 0, unchanged: 0, skipped: 0 }
    for (const item of linked) {
      const outcome = item._tag === "Skip"
        ? yield* recordSkip(params.bookId, set.name, item)
        : yield* linkCandidate({
          bookId: params.bookId,
          set: set.name,
          candidate: item,
          origin: {
            section: "quant",
            questionType: "quant.ps",
            model: first?.model ?? "",
            promptVersion: first?.promptVersion ?? ""
          }
        }, bank)
      counts[outcome] += 1
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

export const BookExtraction: JobKind<typeof Params.Type, typeof Checkpoint.Type> = {
  kind: "book-extract",
  params: Params,
  checkpoint: Checkpoint,
  label: (params) => `Extracting ${params.title}`,
  start: () => ({ stage: "read", setsLinked: 0 }),
  stepsTotal: () => null,
  step: ({ jobId, params, checkpoint, stepsDone }) =>
    checkpoint.stage === "read" ? readStep(jobId, params, stepsDone) : linkStep(params, checkpoint.setsLinked, stepsDone)
}
