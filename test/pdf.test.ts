import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { readPdfPages } from "../src/server/books/pdf.ts"
import { greyPng, makeBook } from "./fixtures/book.ts"

describe("Reading a PDF", () => {
  test("each page's text comes back in order, and a page with no text layer is found", async () => {
    const book = await makeBook()
    const reading = await Effect.runPromise(readPdfPages(book.bytes, 1, 1000))
    expect(reading.pageCount).toBe(book.pageCount)
    expect(reading.pages).toHaveLength(book.pageCount)
    expect(reading.pages[1]?.text).toStartWith("Problem Solving\n1. If 3x + 1 = 13, what is the value of x?")
    const scanned = reading.pages.filter((page) => page.scanned).map((page) => page.number)
    expect(scanned).toEqual([...book.scannedPages])
  })

  test("a page with little text is scanned only when it shows a picture", async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const picture = await doc.embedPng(greyPng)
    doc.addPage()
    doc.addPage().drawText("5.0 Problem Solving", { x: 60, y: 700, size: 11, font })
    const figure = doc.addPage()
    figure.drawText("Figure 3.1", { x: 60, y: 700, size: 11, font })
    figure.drawImage(picture, { x: 60, y: 300, width: 200, height: 200 })
    doc.addPage().drawImage(picture, { x: 60, y: 300, width: 480, height: 400 })
    const reading = await Effect.runPromise(readPdfPages(await doc.save(), 1, 10))
    expect(reading.pages.map((page) => [page.number, page.text, page.scanned])).toEqual([
      [1, "", false],
      [2, "5.0 Problem Solving", false],
      [3, "Figure 3.1", true],
      [4, "", true]
    ])
  })

  test("a PDF cut short is damaged, not some other kind of file", async () => {
    const book = await makeBook()
    const error = await Effect.runPromise(
      readPdfPages(book.bytes.slice(0, Math.floor(book.bytes.length / 3)), 1, 10).pipe(Effect.flip)
    )
    expect(error.reason).toBe("damaged")
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
