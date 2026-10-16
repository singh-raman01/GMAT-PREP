import { Effect, Schema } from "effect"
import { getDocumentProxy } from "unpdf"

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
}

export interface PdfReading {
  readonly pageCount: number
  // The pages asked for that the file has, in order.
  readonly pages: ReadonlyArray<PdfPage>
}

// A page with fewer characters than this has no text layer worth reading;
// it is a scanned page, or a page that is only a picture.
export const MinTextChars = 20

export const hasTextLayer = (text: string) => text.replace(/\s/g, "").length >= MinTextChars

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

const reasonOf = (cause: unknown): PdfUnreadable["reason"] => {
  const name = (cause as { readonly name?: string }).name ?? ""
  if (name === "PasswordException") return "password"
  if (name === "InvalidPDFException") return "not-a-pdf"
  return "damaged"
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
// needs.
export const readPdfPages = (
  bytes: Uint8Array,
  first: number,
  last: number
): Effect.Effect<PdfReading, PdfUnreadable> =>
  Effect.tryPromise({
    try: async () => {
      const pdf = await getDocumentProxy(bytes, {
        disableFontFace: true,
        useSystemFonts: false,
        // Errors only; pdf.js warns about fonts it does not need for text.
        verbosity: 0
      })
      try {
        const pages: Array<PdfPage> = []
        for (let number = Math.max(1, first); number <= Math.min(last, pdf.numPages); number++) {
          const page = await pdf.getPage(number)
          const content = await page.getTextContent()
          pages.push({ number, text: pageText(content.items) })
          page.cleanup()
        }
        return { pageCount: pdf.numPages, pages }
      } finally {
        await pdf.cleanup()
      }
    },
    catch: (cause) => new PdfUnreadable({ reason: reasonOf(cause), detail: String(cause).slice(0, 300) })
  }).pipe(
    Effect.filterOrFail(
      (reading) => reading.pageCount > 0,
      () => new PdfUnreadable({ reason: "no-pages", detail: "the file has no pages" })
    )
  )
