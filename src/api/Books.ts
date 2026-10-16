import { Effect, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { CuratorSession } from "./Curator.ts"
import { JobView, LlmNotConfigured, SpendCap } from "./Jobs.ts"

// Books the Curator adds, and the Book Map that says where in each Book its
// questions, answer keys, explanations and difficulty labels are.

export const BookId = Schema.String.pipe(Schema.brand("BookId"))
export type BookId = typeof BookId.Type

// added: the file is stored; the worker reads its pages and runs the cost
//   preview.
// unreadable: the file could not be read; the note says why.
// previewed: the cost preview waits for the Curator to start the full run.
// mapping: the Book Map model reads the pages to propose a Book Map.
// map-proposed: the proposal waits for the Curator to correct and confirm it.
// mapped: a Book Map version is confirmed.
// extracting: Questions are being extracted for the latest Book Map version.
// extracted: they are in the Review Queue.
export const BookStatus = Schema.Literals([
  "added",
  "unreadable",
  "previewed",
  "mapping",
  "map-proposed",
  "mapped",
  "extracting",
  "extracted"
])
export type BookStatus = typeof BookStatus.Type

export const BookTitle = Schema.String.check(
  Schema.makeFilter((title: string) => title.trim().length >= 1 && title.trim().length <= 200, {
    description: "a title of 1 to 200 characters"
  })
)

export const BookEdition = Schema.String.check(
  Schema.makeFilter((edition: string) => edition.trim().length <= 100, {
    description: "an edition of at most 100 characters"
  })
)

// The groups of Question Types a Book Map range can hold. Each belongs to one
// Section, except mixed, whose Questions are sorted one at a time when they
// are extracted. ir is the older Integrated Reasoning, which maps onto MSR,
// TA, GI and TPA; sc, Sentence Correction, is a Retired item.
export const TypeGroups = ["ps", "ds", "msr", "ta", "gi", "tpa", "ir", "cr", "rc", "sc", "mixed"] as const
export const TypeGroup = Schema.Literals(TypeGroups)
export type TypeGroup = typeof TypeGroup.Type

export const TypeGroupLabels: Record<TypeGroup, string> = {
  ps: "Problem Solving",
  ds: "Data Sufficiency",
  msr: "Multi-Source Reasoning",
  ta: "Table Analysis",
  gi: "Graphics Interpretation",
  tpa: "Two-Part Analysis",
  ir: "Integrated Reasoning (older books)",
  cr: "Critical Reasoning",
  rc: "Reading Comprehension",
  sc: "Sentence Correction (retired)",
  mixed: "Mixed"
}

// The groups whose questions extraction reads so far. Sentence Correction is
// a Retired item, so its questions are only counted; the other Data Insights
// groups wait for a later version, and so do mixed pages of questions.
export const ExtractedGroups: ReadonlySet<TypeGroup> = new Set(["ps", "cr", "rc", "ds"])

export const TypeGroupSections: Record<TypeGroup, "quant" | "verbal" | "di" | null> = {
  ps: "quant",
  ds: "di",
  msr: "di",
  ta: "di",
  gi: "di",
  tpa: "di",
  ir: "di",
  cr: "verbal",
  rc: "verbal",
  sc: "verbal",
  mixed: null
}

export const MapRoles = ["questions", "answer-key", "explanations", "difficulty-labels"] as const
export const MapRole = Schema.Literals(MapRoles)
export type MapRole = typeof MapRole.Type

export const MapRoleLabels: Record<MapRole, string> = {
  "questions": "Questions",
  "answer-key": "Answer key",
  "explanations": "Explanations",
  "difficulty-labels": "Difficulty labels"
}

// How a page is read: from its text layer, as an image by a model that reads
// images, or by the Curator in the Review Queue.
export const PageRoute = Schema.Literals(["text", "image", "review"])
export type PageRoute = typeof PageRoute.Type

// One step of the full run in the cost preview: what it took on the sample,
// and what it would take on the pages the full run still reads.
export class CostStep extends Schema.Class<CostStep>("gmat-prep/api/CostStep")({
  // Such as "Book Map", "Extraction" or "Enrichment".
  name: Schema.String,
  // What the step's counts count: pages, or for enrichment, Questions.
  unit: Schema.Literals(["page", "question"]).pipe(Schema.withDecodingDefaultKey(Effect.succeed("page" as const))),
  sampledPages: Schema.Int,
  sampleTokens: Schema.Int,
  sampleCost: Schema.Number,
  projectedPages: Schema.Int,
  projectedTokens: Schema.Int,
  projectedCost: Schema.Number,
  // False when the sample could not try the step, as when Settings had no
  // models for it: its projection is then unknown, not zero.
  costed: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true)))
}) {}

export class CostPreview extends Schema.Class<CostPreview>("gmat-prep/api/CostPreview")({
  // The model that surveyed the sample.
  model: Schema.String,
  sampledPages: Schema.Array(Schema.Int),
  // Totals over the steps.
  sampleTokens: Schema.Int,
  sampleCost: Schema.Number,
  // The pages the Book Map model reads in the full run: every page with
  // text, the sampled ones again among their neighbours.
  projectedPages: Schema.Int,
  projectedTokens: Schema.Int,
  projectedCost: Schema.Number,
  steps: Schema.Array(CostStep).pipe(Schema.withDecodingDefaultKey(Effect.succeed([])))
}) {}

// What happened to every item extracted from a Book.
export class BookReport extends Schema.Class<BookReport>("gmat-prep/api/BookReport")({
  // Items that became Questions or joined one, and what became of them.
  extracted: Schema.Int,
  // Joined a Question already in the Question Bank as another Source.
  merged: Schema.Int,
  // Waiting in the Review Queue, and still being enriched and checked.
  held: Schema.Int,
  checking: Schema.Int,
  published: Schema.Int,
  withdrawn: Schema.Int,
  // Retired items, which never become Questions.
  skippedGeometry: Schema.Int,
  skippedSentenceCorrection: Schema.Int,
  // A second item with a number its set already has, which keys and
  // explanations cannot tell apart: usually a set that should be two.
  skippedRepeatedNumbers: Schema.Int,
  // Pages extraction could not read, waiting in the Review Queue.
  unreadPages: Schema.Array(Schema.Int)
}) {}

export class BookView extends Schema.Class<BookView>("gmat-prep/api/BookView")({
  id: BookId,
  title: Schema.String,
  edition: Schema.String,
  official: Schema.Boolean,
  // The file's SHA-256, which identifies it.
  fileHash: Schema.String,
  fileSize: Schema.Int,
  status: BookStatus,
  // Why the Book is unreadable.
  note: Schema.NullOr(Schema.String),
  pageCount: Schema.NullOr(Schema.Int),
  textPages: Schema.NullOr(Schema.Int),
  // Pages with no text layer.
  scannedPages: Schema.Array(Schema.Int),
  // How those pages will be read; null when there are none.
  scannedRoute: Schema.NullOr(PageRoute),
  preview: Schema.NullOr(CostPreview),
  // The latest confirmed Book Map version.
  mapVersion: Schema.NullOr(Schema.Int),
  // The spend cap of the full run, which its jobs share; null before it starts.
  runCap: Schema.NullOr(Schema.Number),
  // What the full run's jobs have spent, across restarts.
  runSpent: Schema.Number,
  report: Schema.NullOr(BookReport),
  // The job working on the Book: reading it, proposing its Book Map or
  // extracting its Questions.
  job: Schema.NullOr(JobView),
  createdAt: Schema.Number
}) {}

const PageNumber = Schema.Int.check(
  Schema.makeFilter((page: number) => page >= 1 && page <= 100_000, { description: "a page number from 1" })
)

// Ranges with the same set name belong together: questions, their answer
// key, their explanations and their difficulty labels.
export const MaxSetName = 100

export const SetName = Schema.String.check(
  Schema.makeFilter((name: string) => name.trim().length >= 1 && name.trim().length <= MaxSetName, {
    description: `a set name of 1 to ${MaxSetName} characters`
  })
)

const RangeFields = {
  role: MapRole,
  firstPage: PageNumber,
  lastPage: PageNumber,
  set: SetName,
  group: TypeGroup
}

export class MapRange extends Schema.Class<MapRange>("gmat-prep/api/MapRange")(RangeFields) {}

export const MapRangeInput = Schema.Struct(RangeFields)
export type MapRangeInput = typeof MapRangeInput.Type

export const MaxMapRanges = 500

export class MapProposal extends Schema.Class<MapProposal>("gmat-prep/api/MapProposal")({
  ranges: Schema.Array(MapRange),
  model: Schema.String,
  promptVersion: Schema.String,
  createdAt: Schema.Number
}) {}

export class ConfirmedMap extends Schema.Class<ConfirmedMap>("gmat-prep/api/ConfirmedMap")({
  version: Schema.Int,
  ranges: Schema.Array(MapRange),
  confirmedAt: Schema.Number
}) {}

export class BookDetail extends Schema.Class<BookDetail>("gmat-prep/api/BookDetail")({
  book: BookView,
  // The Book Map model's latest proposal.
  proposal: Schema.NullOr(MapProposal),
  // The latest confirmed version.
  confirmed: Schema.NullOr(ConfirmedMap)
}) {}

export class BookNotFound extends Schema.TaggedError<BookNotFound>()(
  "BookNotFound",
  {},
  { httpApiStatus: 404 }
) {}

// The Book's status does not allow the action, such as starting its full
// run twice.
export class BookNotReady extends Schema.TaggedError<BookNotReady>()(
  "BookNotReady",
  { status: BookStatus },
  { httpApiStatus: 409 }
) {}

// Confirming a Book Map starts extraction, which needs a spend cap: the full
// run's, or one given with the map when the Curator mapped the Book by hand.
export class RunCapNeeded extends Schema.TaggedError<RunCapNeeded>()(
  "RunCapNeeded",
  {},
  { httpApiStatus: 409 }
) {}

// Starting the full run again: its cap covers the whole run, so it must be
// above what the run already spent.
export class RunCapTooLow extends Schema.TaggedError<RunCapTooLow>()(
  "RunCapTooLow",
  { spent: Schema.Number },
  { httpApiStatus: 422 }
) {}

// A Book Map that cannot be right, with every problem found.
export class BookMapInvalid extends Schema.TaggedError<BookMapInvalid>()(
  "BookMapInvalid",
  { problems: Schema.Array(Schema.String) },
  { httpApiStatus: 422 }
) {}

const bookParams = { params: { id: BookId } }

export class BooksApi extends HttpApiGroup.make("books")
  .add(
    HttpApiEndpoint.get("list", "/books", {
      success: Schema.Array(BookView)
    }),
    HttpApiEndpoint.get("get", "/books/:id", {
      ...bookParams,
      success: BookDetail,
      error: BookNotFound
    }),
    // Reads the file again, for a Book whose reading was cancelled or failed,
    // or whose cost preview could not cost a step.
    HttpApiEndpoint.post("readAgain", "/books/:id/read", {
      ...bookParams,
      success: BookView,
      error: [BookNotFound, BookNotReady]
    }),
    // After the cost preview: the Curator starts the full run with its cap,
    // or starts it again after cancelling it, with a cap for the whole run.
    HttpApiEndpoint.post("start", "/books/:id/start", {
      ...bookParams,
      payload: Schema.Struct({ spendCap: SpendCap }),
      success: BookView,
      error: [BookNotFound, BookNotReady, LlmNotConfigured, RunCapTooLow]
    }),
    // Each confirmation makes a new Book Map version and starts extraction
    // for it. spendCap sets the run's cap when the full run never started,
    // or raises it when the run has spent it.
    HttpApiEndpoint.put("confirmMap", "/books/:id/map", {
      ...bookParams,
      payload: Schema.Struct({
        ranges: Schema.Array(MapRangeInput).check(Schema.isMaxLength(MaxMapRanges)),
        spendCap: Schema.optional(SpendCap)
      }),
      success: BookDetail,
      error: [BookNotFound, BookNotReady, BookMapInvalid, RunCapNeeded]
    })
  )
  .middleware(CuratorSession)
  .prefix("/api/curator")
{}

// Adding a Book is a plain HTTP upload, outside the typed API, so the file
// streams to disk instead of into memory: POST the PDF as the body
// (Content-Type: application/pdf) with title, edition and official=true or
// false in the query string. The reply is AddedBook, or UploadRefused, as JSON.
export const BookUploadPath = "/api/curator/books/upload"

export const MaxBookBytes = 500 * 1024 * 1024

export class AddedBook extends Schema.Class<AddedBook>("gmat-prep/api/AddedBook")({
  book: BookView,
  // True when this file was added before; nothing new was stored.
  alreadyAdded: Schema.Boolean
}) {}

export const UploadProblem = Schema.Literals([
  "not-unlocked",
  "details",
  "not-a-pdf",
  "too-large",
  "empty",
  "incomplete",
  "disk-full"
])
export type UploadProblem = typeof UploadProblem.Type

export class UploadRefused extends Schema.Class<UploadRefused>("gmat-prep/api/UploadRefused")({
  problem: UploadProblem,
  message: Schema.String
}) {}

// The stored PDF, for the browser's own viewer: add #page=N to open a page.
export const bookFilePath = (id: string) => `/api/curator/books/${encodeURIComponent(id)}/file`
