import { Effect, Schema } from "effect"
import { getDocumentProxy, getResolvedPDFJS } from "unpdf"
import type { Band } from "./figures.ts"

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

interface PlacedItem {
  readonly str?: string
  readonly transform?: ReadonlyArray<number>
  readonly height?: number
}

// Where a question sits on its page, as shares of the page's height from the
// top: from the line that starts with its number to the line that starts the
// next question below it, or the foot of the page. The whole page when its
// number is not found at the start of a line.
export const questionBand = (bytes: Uint8Array, page: number, number: number): Effect.Effect<Band, PdfUnreadable> =>
  Effect.tryPromise({
    try: async () => {
      // pdf.js takes over the buffer it is given.
      const pdf = await getDocumentProxy(bytes.slice(), { disableFontFace: true, useSystemFonts: false, verbosity: 0 })
      try {
        const handle = await pdf.getPage(page)
        const height = handle.getViewport({ scale: 1 }).height
        const starts = ((await handle.getTextContent()).items as ReadonlyArray<PlacedItem>).flatMap((item) => {
          const found = /^\s*(\d+)\.(?:\s|$)/.exec(item.str ?? "")
          const baseline = item.transform?.[5]
          if (found === null || baseline === undefined || height <= 0) return []
          const lineHeight = item.height ?? item.transform?.[3] ?? 0
          return [{ number: Number(found[1]), top: Math.max(0, 1 - (baseline + lineHeight) / height) }]
        }).toSorted((a, b) => a.top - b.top)
        const own = starts.find((start) => start.number === number)
        if (own === undefined) return { top: 0, bottom: 1 }
        const next = starts.find((start) => start.top > own.top && start.number !== number)
        // A little room above the question's first line, and none of the next one.
        return { top: Math.max(0, own.top - 0.01), bottom: next === undefined ? 1 : Math.max(own.top + 0.02, next.top - 0.005) }
      } finally {
        await pdf.loadingTask.destroy()
      }
    },
    catch: (cause) => new PdfUnreadable({ reason: "damaged", detail: String(cause).slice(0, 300) })
  })
