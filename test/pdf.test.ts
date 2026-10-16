import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { hasTextLayer, readPdfPages } from "../src/server/books/pdf.ts"
import { makeBook } from "./fixtures/book.ts"

describe("Reading a PDF", () => {
  test("each page's text comes back in order, and a page with no text layer is found", async () => {
    const book = await makeBook()
    const reading = await Effect.runPromise(readPdfPages(book.bytes, 1, 1000))
    expect(reading.pageCount).toBe(book.pageCount)
    expect(reading.pages).toHaveLength(book.pageCount)
    expect(reading.pages[1]?.text).toStartWith("Problem Solving\n1. If 3x + 1 = 13, what is the value of x?")
    const scanned = reading.pages.filter((page) => !hasTextLayer(page.text)).map((page) => page.number)
    expect(scanned).toEqual([...book.scannedPages])
  })

  test("a range of pages reads only those pages, and says how many the file has", async () => {
    const book = await makeBook()
    const reading = await Effect.runPromise(readPdfPages(book.bytes, 5, 6))
    expect(reading.pageCount).toBe(book.pageCount)
    expect(reading.pages.map((page) => page.number)).toEqual([5, 6])
    expect(reading.pages[0]?.text).toStartWith("Answer Key")
  })

  test("a file that is not a PDF is refused as such", async () => {
    const error = await Effect.runPromise(
      readPdfPages(new TextEncoder().encode("hello, not a pdf"), 1, 10).pipe(Effect.flip)
    )
    expect(error.reason).toBe("not-a-pdf")
  })

  test("the same content always makes the same file", async () => {
    const [a, b] = await Promise.all([makeBook(), makeBook()])
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true)
  })
})
