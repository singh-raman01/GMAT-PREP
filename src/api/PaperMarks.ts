import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { BookId, BookNotFound } from "./Books.ts"
import { ProfileSession } from "./Profiles.ts"

// Paper Marks: a Book, or a page range of it, that the Learner worked on
// paper. Its Questions are Seen for the Profile from the time of the mark.

const Page = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export const PaperMarkInput = Schema.Struct({
  bookId: BookId,
  // Both pages, included, or neither for the whole Book.
  firstPage: Schema.NullOr(Page),
  lastPage: Schema.NullOr(Page)
})
export type PaperMarkInput = typeof PaperMarkInput.Type

export class PaperMarkView extends Schema.Class<PaperMarkView>("gmat-prep/api/PaperMarkView")({
  id: Schema.String,
  book: Schema.Struct({ id: BookId, title: Schema.String }),
  firstPage: Schema.NullOr(Schema.Int),
  lastPage: Schema.NullOr(Schema.Int),
  // The published Questions it makes Seen.
  questions: Schema.Int,
  createdAt: Schema.Number
}) {}

export class PaperMarkNotFound extends Schema.TaggedError<PaperMarkNotFound>()(
  "PaperMarkNotFound",
  {},
  { httpApiStatus: 404 }
) {}

// Pages the Book does not have, or a range given by one end only.
export class PaperMarkInvalid extends Schema.TaggedError<PaperMarkInvalid>()(
  "PaperMarkInvalid",
  { problems: Schema.Array(Schema.String) },
  { httpApiStatus: 422 }
) {}

export class PaperMarksApi extends HttpApiGroup.make("paperMarks")
  .add(
    // The Profile's Paper Marks, the latest first.
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(PaperMarkView) }),
    HttpApiEndpoint.post("add", "/", {
      payload: PaperMarkInput,
      success: Schema.Array(PaperMarkView),
      error: [BookNotFound, PaperMarkInvalid]
    }),
    // Its Questions are unseen again, unless a Session has served them.
    HttpApiEndpoint.delete("remove", "/:id", {
      params: { id: Schema.String },
      success: Schema.Array(PaperMarkView),
      error: PaperMarkNotFound
    })
  )
  .middleware(ProfileSession)
  .prefix("/api/paper-marks")
{}
