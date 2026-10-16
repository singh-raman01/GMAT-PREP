import type { BookView } from "../../../src/api/Books.ts"

// How Books are described on the Curator's screens.

export const fileSize = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

export const pageCountText = (book: BookView) => {
  if (book.pageCount === null) return undefined
  const scanned = book.scannedPages.length
  return `${book.pageCount} ${book.pageCount === 1 ? "page" : "pages"}${scanned === 0 ? "" : `, ${scanned} scanned`}`
}

// Page numbers as short runs: 3, 7 to 9, 12.
export const pageRuns = (pages: ReadonlyArray<number>) => {
  const runs: Array<string> = []
  let start = pages[0]
  let previous = start
  for (const page of [...pages.slice(1), undefined]) {
    if (page !== undefined && previous !== undefined && page === previous + 1) {
      previous = page
      continue
    }
    if (start !== undefined && previous !== undefined) runs.push(start === previous ? `${start}` : `${start} to ${previous}`)
    start = page
    previous = page
  }
  return runs.join(", ")
}

// Where the Book is, and what it waits for, in a few words.
export const bookStatusText = (book: BookView): string => {
  const job = book.job
  const stalled = (verb: string) => {
    switch (job?.status) {
      case "paused":
        return `${verb} paused`
      case "failed":
        return `${verb} stopped`
      case "cancelled":
        return `${verb} cancelled`
      default:
        return undefined
    }
  }
  switch (book.status) {
    case "added":
      return stalled("Reading") ?? (job?.status === "running" ? "Reading the pages" : "Waiting to be read")
    case "unreadable":
      return "Could not be read"
    case "previewed":
      return "Cost preview ready; the full run waits for you"
    case "mapping":
      return stalled("Book Map run") ?? "The Book Map model is reading the pages"
    case "map-proposed":
      return "Book Map proposed; waiting for you to check it"
    case "mapped":
      return `Book Map version ${book.mapVersion ?? 1} confirmed`
    case "extracting":
      return stalled("Extraction") ?? "Extracting the Questions into the Review Queue"
    case "extracted":
      return "Questions extracted; they wait in the Review Queue"
  }
}
