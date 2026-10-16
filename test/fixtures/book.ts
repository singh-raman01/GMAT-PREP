import { PDFDocument, StandardFonts } from "pdf-lib"

// A small made-up prep book: a title page, Problem Solving questions, an
// answer key, explanations, Data Sufficiency questions, and a scanned page
// with no text layer. Built at test time, so the repo holds no binary.

export interface BookFixture {
  readonly bytes: Uint8Array
  readonly pageCount: number
  readonly scannedPages: ReadonlyArray<number>
}

// A 4 by 4 grey PNG, standing in for a scanned page.
const greyPng = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAAAAACMmsGiAAAAEklEQVR4nGNoaGhgYGBgYGAAAAwQAoGq0r3+AAAAAElFTkSuQmCC"
  ),
  (char) => char.charCodeAt(0)
)

// psPages sets how many pages of Problem Solving questions it has, three
// questions to a page, each with a page of explanations.
export const makeBook = async (
  options: { readonly title?: string; readonly edition?: string; readonly psPages?: number } = {}
): Promise<BookFixture> => {
  const doc = await PDFDocument.create()
  doc.setTitle(options.title ?? "GMAT Practice Questions")
  // pdf-lib stamps the current time, which would change the file's hash.
  doc.setCreationDate(new Date(Date.UTC(2026, 0, 1)))
  doc.setModificationDate(new Date(Date.UTC(2026, 0, 1)))
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = (lines: ReadonlyArray<string>) => {
    const p = doc.addPage([612, 792])
    lines.forEach((line, i) => p.drawText(line, { x: 60, y: 720 - i * 18, size: 11, font }))
  }

  page([options.title ?? "GMAT Practice Questions", options.edition ?? "First edition", "A made-up book for tests"])
  const psPages = options.psPages ?? 3
  const questions = psPages * 3
  for (let set = 0; set < psPages; set++) {
    page([
      "Problem Solving",
      ...[1, 2, 3].flatMap((k) => {
        const n = set * 3 + k
        return [
          `${n}. If 3x + ${n} = ${n + 12}, what is the value of x?`,
          "(A) 2   (B) 3   (C) 4   (D) 5   (E) 6"
        ]
      })
    ])
  }
  page(["Answer Key", ...Array.from({ length: questions }, (_, i) => `${i + 1}. C`)])
  for (let k = 1; k <= questions; k += 3) {
    page([
      "Answer Explanations",
      ...[k, k + 1, k + 2].flatMap((n) => [`${n}. Subtract ${n} from both sides, then divide by 3.`, "The answer is C."])
    ])
  }
  page([
    "Data Sufficiency",
    `${questions + 1}. What is the value of x?`,
    "(1) x + 2 = 5",
    "(2) x is a prime number.",
    `${questions + 2}. Is n even?`,
    "(1) n + 1 is odd.",
    "(2) 3n is even."
  ])
  const scanned = doc.addPage([612, 792])
  scanned.drawImage(await doc.embedPng(greyPng), { x: 60, y: 300, width: 480, height: 400 })
  const scannedPage = doc.getPageCount()
  page(["Data Sufficiency Answer Key", `${questions + 1}. A`, `${questions + 2}. D`])

  const bytes = await doc.save()
  return { bytes, pageCount: doc.getPageCount(), scannedPages: [scannedPage] }
}
