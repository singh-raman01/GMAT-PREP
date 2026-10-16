import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { CuratorSession } from "./Curator.ts"
import { JobView, SpendCap } from "./Jobs.ts"

// Books the Curator adds, and the Book Map that says where in each Book the
// questions, answer keys, explanations and difficulty labels are.

export const BookId = Schema.String.pipe(Schema.brand("BookId"))
export type BookId = typeof BookId.Type

// added: the file is stored and waits to be read.
// reading: the worker reads its pages and costs a 10-page sample.
// unreadable: the file could not be read; note says why.
// previewed: the projected cost is shown, and the full run waits for the Curator.
// mapping: the LLM is proposing the Book Map.
// map-proposed: the proposal waits for the Curator to correct and confirm it.
// mapped: a Book Map version is confirmed.
export const BookStatus = Schema.Literals([
  "added",
  "reading",
  "unreadable",
  "previewed",
  "mapping",
  "map-proposed",
  "mapped"
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

export class CostPreview extends Schema.Class<CostPreview>("gmat-prep/api/CostPreview")({
  // The model that read the sample, and what the sample took.
  model: Schema.String,
  sampledPages: Schema.Array(Schema.Int),
  sampleTokens: Schema.Int,
  sampleCost: Schema.Number,
  // The same reading for every page with text, projected from the sample.
  projectedTokens: Schema.Int,
  projectedCost: Schema.Number
}) {}

export const PageRoute = Schema.Literals(["text", "image", "review"])
export type PageRoute = typeof PageRoute.Type

export class BookView extends Schema.Class<BookView>("gmat-prep/api/BookView")({
  id: BookId,
  title: Schema.String,
  edition: Schema.String,
  official: Schema.Boolean,
  fileHash: Schema.String,
  fileSize: Schema.Int,
  status: BookStatus,
  // Why the Book is unreadable, or what it waits for.
  note: Schema.NullOr(Schema.String),
  pageCount: Schema.NullOr(Schema.Int),
  textPages: Schema.NullOr(Schema.Int),
  // Pages with no text layer, and how they will be read.
  scannedPages: Schema.Array(Schema.Int),
  scannedRoute: Schema.NullOr(PageRoute),
  preview: Schema.NullOr(CostPreview),
  mapVersion: Schema.NullOr(Schema.Int),
  createdAt: Schema.Number
}) {}

export const MapRole = Schema.Literals(["questions", "answer-key", "explanations", "difficulty-labels"])
export type MapRole = typeof MapRole.Type

const PageNumber = Schema.Int.check(
  Schema.makeFilter((page: number) => page >= 1 && page <= 100_000, { description: "a page number" })
)

const RangeFields = {
  role: MapRole,
  firstPage: PageNumber,
  lastPage: PageNumber,
  section: Schema.NullOr(Schema.Literals(["quant", "verbal", "di"])),
  // A Question Type id from the Taxonomy, such as quant.ps.
  questionType: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String)
}

export class MapRange extends Schema.Class<MapRange>("gmat-prep/api/MapRange")(RangeFields) {}

export const MapRangeInput = Schema.Struct(RangeFields)
export type MapRangeInput = typeof MapRangeInput.Type

export class BookMapView extends Schema.Class<BookMapView>("gmat-prep/api/BookMapView")({
  book: BookView,
  // The LLM's latest proposal, or null while there is none.
  proposal: Schema.NullOr(Schema.Struct({
    ranges: Schema.Array(MapRange),
    model: Schema.String,
    promptVersion: Schema.String,
    createdAt: Schema.Number
  })),
  // The latest confirmed version, or null before the first confirmation.
  confirmed: Schema.NullOr(Schema.Struct({
    version: Schema.Int,
    ranges: Schema.Array(MapRange),
    confirmedAt: Schema.Number
  }))
}) {}

export class BookNotFound extends Schema.TaggedError<BookNotFound>()(
  "BookNotFound",
  {},
  { httpApiStatus: 404 }
) {}

// The Book's status does not allow the action, such as starting a run twice.
export class BookNotReady extends Schema.TaggedError<BookNotReady>()(
  "BookNotReady",
  { status: BookStatus },
  { httpApiStatus: 409 }
) {}

// A Book Map that cannot be right, with every problem found.
export class BookMapInvalid extends Schema.TaggedError<BookMapInvalid>()(
  "BookMapInvalid",
  { problems: Schema.Array(Schema.String) },
  { httpApiStatus: 400 }
) {}

const bookParams = { params: { id: BookId } }

export class BooksApi extends HttpApiGroup.make("books")
  .add(
    HttpApiEndpoint.get("list", "/books", {
      success: Schema.Array(BookView)
    }),
    HttpApiEndpoint.get("get", "/books/:id", {
      ...bookParams,
      success: BookMapView,
      error: BookNotFound
    }),
    // After the cost preview: the Curator confirms the full run and its cap,
    // and the LLM proposes the Book Map.
    HttpApiEndpoint.post("start", "/books/:id/start", {
      ...bookParams,
      payload: Schema.Struct({ spendCap: SpendCap }),
      success: JobView,
      error: [BookNotFound, BookNotReady]
    }),
    HttpApiEndpoint.post("confirmMap", "/books/:id/map", {
      ...bookParams,
      payload: Schema.Struct({ ranges: Schema.Array(MapRangeInput) }),
      success: BookMapView,
      error: [BookNotFound, BookNotReady, BookMapInvalid]
    })
  )
  .middleware(CuratorSession)
  .prefix("/api/curator")
{}

// Adding a Book is a plain HTTP upload, outside the typed API, so the file
// streams to disk instead of into memory: POST this path with the PDF as the
// body (Content-Type: application/pdf) and the details in the query string,
// title, edition and official=true|false. The reply is AddedBook as JSON.
export const BookUploadPath = "/api/curator/books/upload"

export const MaxBookBytes = 500 * 1024 * 1024

export class AddedBook extends Schema.Class<AddedBook>("gmat-prep/api/AddedBook")({
  book: BookView,
  // True when this file was added before; nothing new was stored.
  alreadyAdded: Schema.Boolean
}) {}
