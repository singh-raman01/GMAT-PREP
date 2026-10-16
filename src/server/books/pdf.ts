import { Effect, Schema } from "effect"
import { getDocumentProxy, getResolvedPDFJS } from "unpdf"

// Reads a PDF's pages as text with pdf.js. Books are untrusted files, so
// pdf.js runs without loading fonts, and only in the job worker, where a file
// that hangs or crashes the parser cannot stop a Session.

export class PdfUnreadable extends Schema.TaggedError<PdfUnreadable>()("PdfUnreadable", {
  reason: Schema.Literals(["not-a-pdf", "password", "damaged", "no-pages"]),
  detail: Schema.String
}) {}

export interface PdfPage {
  readonly number: number
  // Lines as pdf.js finds them, joined with newlines.
  readonly text: string
  // A page that has to be read another way than by its text: a scanned
  // page, a page that is only a picture, or one pdf.js could not read.
  readonly scanned: boolean
}

export interface PdfReading {
  readonly pageCount: number
  // The pages asked for that the file has, in order.
  readonly pages: ReadonlyArray<PdfPage>
}

// A page with fewer characters than this has no text layer worth reading.
// It is a scanned page when it shows a picture; otherwise it is a blank
// page or a short one, such as a chapter title, and is read as text.
export const MinTextChars = 20

export const hasTextLayer = (text: string) => text.replace(/\s/g, "").length >= MinTextChars

// A PDF starts with this marker, within its first kilobyte.
const PdfMarker = "%PDF-"

const hasPdfMarker = (bytes: Uint8Array) =>
  new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes(PdfMarker)

interface TextItem {
  readonly str?: string
  readonly hasEOL?: boolean
}

const pageText = (items: ReadonlyArray<unknown>) => {
  let text = ""
  for (const item of items as ReadonlyArray<TextItem>) {
    if (typeof item.str === "string") text += item.str
    if (item.hasEOL === true) text += "\n"
  }
  return text.replace(/[ \t]+\n/g, "\n").trim()
}

// A file with the PDF marker that pdf.js cannot open is a damaged PDF, such
// as one cut short, rather than another kind of file.
const reasonOf = (cause: unknown, marked: boolean): PdfUnreadable["reason"] => {
  const name = (cause as { readonly name?: string }).name ?? ""
  if (name === "PasswordException") return "password"
  if (name === "InvalidPDFException") return marked ? "damaged" : "not-a-pdf"
  return "damaged"
}

// The operators that paint a picture on a page.
const imageOperators = async () => {
  const { OPS } = await getResolvedPDFJS()
  return new Set<number>([
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
    OPS.paintImageMaskXObject,
    OPS.paintImageXObjectRepeat,
    OPS.paintImageMaskXObjectRepeat,
    OPS.paintInlineImageXObjectGroup,
    OPS.paintImageMaskXObjectGroup,
    OPS.paintSolidColorImageMask
  ])
}

// What the Curator is told about a file that cannot be read.
export const unreadableNote = (error: PdfUnreadable): string => {
  switch (error.reason) {
    case "not-a-pdf":
      return "The file is not a PDF the app can read."
    case "password":
      return "The PDF is protected by a password. Save a copy without the password and add that instead."
    case "no-pages":
      return "The PDF has no pages."
    case "damaged":
      return `The PDF is damaged and could not be read (${error.detail}).`
  }
}

// Reads pages first to last of the file, or as many of them as it has. pdf.js
// takes over the buffer it is given, so the caller passes one it no longer
// needs. A page pdf.js cannot read counts as scanned, so it waits for the
// Curator instead of stopping the whole Book.
export const readPdfPages = (
  bytes: Uint8Array,
  first: number,
  last: number
): Effect.Effect<PdfReading, PdfUnreadable> => {
  const marked = hasPdfMarker(bytes)
  return Effect.tryPromise({
    try: async () => {
      const pdf = await getDocumentProxy(bytes, {
        disableFontFace: true,
        useSystemFonts: false,
        // Errors only; pdf.js warns about fonts it does not need for text.
        verbosity: 0
      })
      try {
        const pictures = await imageOperators()
        const pages: Array<PdfPage> = []
        for (let number = Math.max(1, first); number <= Math.min(last, pdf.numPages); number++) {
          try {
            const page = await pdf.getPage(number)
            const text = pageText((await page.getTextContent()).items)
            const scanned = !hasTextLayer(text) &&
              (await page.getOperatorList()).fnArray.some((operator) => pictures.has(operator))
            pages.push({ number, text, scanned })
            page.cleanup()
          } catch {
            pages.push({ number, text: "", scanned: true })
          }
        }
        return { pageCount: pdf.numPages, pages }
      } finally {
        // Frees the document and its copy of the file; cleanup() alone keeps them.
        await pdf.loadingTask.destroy()
      }
    },
    catch: (cause) => new PdfUnreadable({ reason: reasonOf(cause, marked), detail: String(cause).slice(0, 300) })
  }).pipe(
    Effect.filterOrFail(
      (reading) => reading.pageCount > 0,
      () => new PdfUnreadable({ reason: "no-pages", detail: "the file has no pages" })
    )
  )
}
