import { PDFiumLibrary } from "@hyzyla/pdfium"
import wasmFile from "@hyzyla/pdfium/pdfium.wasm" with { type: "file" }
import { Effect, Schema } from "effect"
import { encode } from "fast-png"

// A figure that cannot become data is kept as the band of its page it sits
// in (ADR 0006), drawn with PDFium, which runs as WebAssembly so the app
// needs no native libraries. Only the job worker draws pages.

export class PageNotDrawn extends Schema.TaggedError<PageNotDrawn>()("PageNotDrawn", { detail: Schema.String }) {}

// A band of a page, as shares of its height from the top.
export interface Band {
  readonly top: number
  readonly bottom: number
}

// Pages are drawn at twice their size in points, sharp enough to read.
const Scale = 2

let library: Promise<PDFiumLibrary> | undefined

const pdfium = () =>
  library ??= Bun.file(wasmFile).arrayBuffer().then((wasmBinary) => PDFiumLibrary.init({ wasmBinary }))

// The band of a page (numbered from 1) as a PNG.
export const drawBand = (pdf: Uint8Array, page: number, band: Band): Effect.Effect<Uint8Array, PageNotDrawn> =>
  Effect.tryPromise({
    try: async () => {
      const document = await (await pdfium()).loadDocument(pdf)
      try {
        const drawn = await document.getPage(page - 1).render({ scale: Scale, render: "bitmap" })
        const top = Math.max(0, Math.min(drawn.height - 1, Math.floor(band.top * drawn.height)))
        const bottom = Math.max(top + 1, Math.min(drawn.height, Math.ceil(band.bottom * drawn.height)))
        const rows = bottom - top
        // PDFium draws blue, green, red and alpha; PNG wants red first.
        const rgba = new Uint8Array(drawn.width * rows * 4)
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < drawn.width; x++) {
            const from = ((top + y) * drawn.width + x) * 4
            const to = (y * drawn.width + x) * 4
            rgba[to] = drawn.data[from + 2]!
            rgba[to + 1] = drawn.data[from + 1]!
            rgba[to + 2] = drawn.data[from]!
            rgba[to + 3] = drawn.data[from + 3]!
          }
        }
        return encode({ width: drawn.width, height: rows, data: rgba, channels: 4 })
      } finally {
        document.destroy()
      }
    },
    catch: (cause) => new PageNotDrawn({ detail: cause instanceof Error ? cause.message : String(cause) })
  })
