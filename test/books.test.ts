import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpServer } from "effect/http"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import {
  AddedBook,
  type BookDetail,
  BookId,
  bookFilePath,
  BookUploadPath,
  type MapRangeInput,
  UploadRefused
} from "../src/api/Books.ts"
import { AppConfig } from "../src/server/AppConfig.ts"
import { AllJobKinds } from "../src/server/jobs/kinds/index.ts"
import { FakeLlm } from "../src/server/llm/LlmTransport.ts"
import { ApiKeyStore } from "../src/server/settings/ApiKeyStore.ts"
import { Settings } from "../src/server/settings/Settings.ts"
import { fakeBookModel, surveyedPages } from "./fakeBookModel.ts"
import { makeBook } from "./fixtures/book.ts"
import { advanceUntil, openInspectableBrowser, runWithWorker, runWithWorkers } from "./harness.ts"

const passphrase = "correct horse battery"

const curatorBrowser = Effect.gen(function*() {
  const browser = yield* openInspectableBrowser
  yield* browser.api.curatorAccess.setPassphrase({ payload: { passphrase } })
  const token = Option.getOrThrow(yield* browser.cookie("gp_curator"))
  return { api: browser.api, cookie: `gp_curator=${token}` }
})

const decodeAdded = Schema.decodeUnknownSync(Schema.toCodecJson(AddedBook))
const decodeRefused = Schema.decodeUnknownSync(Schema.toCodecJson(UploadRefused))

// Adds a Book the way the Books screen does: the PDF as the body, the
// details in the query string.
const upload = (
  cookie: string,
  bytes: Uint8Array,
  details: { readonly title: string; readonly edition?: string; readonly official?: boolean }
) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const query = new URLSearchParams({
      title: details.title,
      edition: details.edition ?? "",
      official: String(details.official ?? false)
    })
    const response = yield* client.execute(
      HttpClientRequest.post(`${BookUploadPath}?${query}`).pipe(
        HttpClientRequest.setHeader("cookie", cookie),
        HttpClientRequest.bodyUint8Array(bytes, "application/pdf")
      )
    )
    const text = yield* response.text
    return { status: response.status, json: text.startsWith("{") ? (JSON.parse(text) as unknown) : text }
  })

const added = (reply: { readonly json: unknown }) => decodeAdded(reply.json)

// The Book Map model's settings, with an extraction model that reads images
// or not.
const configure = (extractionReadsImages = false) =>
  Effect.gen(function*() {
    const settings = yield* Settings
    yield* settings.saveLlm({
      baseUrl: "https://api.example.com/v1",
      jsonMode: "json-schema",
      models: [
        { task: "book-map", model: "map-model" },
        { task: "extraction", model: extractionReadsImages ? "vision-model" : "text-model" },
        { task: "tagging", model: "text-model" },
        { task: "solving", model: "text-model" },
        { task: "approaches", model: "text-model" }
      ],
      prices: [
        { model: "map-model", inputPerMillion: 1, outputPerMillion: 4 },
        { model: "text-model", inputPerMillion: 2, outputPerMillion: 8 },
        { model: "vision-model", inputPerMillion: 3, outputPerMillion: 12 }
      ],
      readsImages: ["vision-model"]
    })
    yield* (yield* ApiKeyStore).save("sk-test-12345678")
  })

// The pages quoted in a survey request.
const quotedPages = surveyedPages

// A stand-in for the Book Map and extraction models that reads the fixture
// book's headings. Answer keys of Problem Solving name no chapter, as some
// books print them.
const surveyByHeading = Effect.gen(function*() {
  const fake = yield* FakeLlm
  yield* fake.respondWith(fakeBookModel)
})

const detailOf = (api: Effect.Success<typeof curatorBrowser>["api"], id: BookId) => api.books.get({ params: { id } })

const waitForStatus = (
  api: Effect.Success<typeof curatorBrowser>["api"],
  id: BookId,
  status: string
) =>
  advanceUntil(
    detailOf(api, id).pipe(Effect.map((detail) => (detail.book.status === status ? detail : undefined))),
    { step: "200 millis", maxSteps: 3000 }
  )

const booksFolder = Effect.gen(function*() {
  const { dataDir } = yield* AppConfig
  return join(dataDir, "books")
})

describe("Adding a Book", () => {
  test("the same file twice does nothing, and a different edition of the same title is a new Book", () =>
    runWithWorkers(
      Effect.gen(function*() {
        const curator = yield* curatorBrowser
        const firstEdition = yield* Effect.promise(() => makeBook())
        const first = yield* upload(curator.cookie, firstEdition.bytes, {
          title: "Practice Questions",
          edition: "First edition",
          official: true
        })
        expect(first.status).toBe(201)
        const book = added(first)
        expect(book.alreadyAdded).toBe(false)
        expect(book.book).toMatchObject({
          title: "Practice Questions",
          edition: "First edition",
          official: true,
          status: "added",
          fileSize: firstEdition.bytes.length
        })
        expect(book.book.job).toMatchObject({ kind: "book-intake", status: "queued" })
        const hash = new Bun.CryptoHasher("sha256").update(firstEdition.bytes).digest("hex")
        expect(book.book.fileHash).toBe(hash)
        const folder = yield* booksFolder
        expect(existsSync(join(folder, `${hash}.pdf`))).toBe(true)

        const again = yield* upload(curator.cookie, firstEdition.bytes, { title: "Another name" })
        expect(again.status).toBe(200)
        expect(added(again)).toMatchObject({ alreadyAdded: true, book: { id: book.book.id, title: "Practice Questions" } })
        expect(readdirSync(folder)).toEqual([`${hash}.pdf`])

        const secondEdition = yield* Effect.promise(() => makeBook({ edition: "Second edition" }))
        const second = yield* upload(curator.cookie, secondEdition.bytes, {
          title: "Practice Questions",
          edition: "Second edition"
        })
        expect(second.status).toBe(201)
        expect(added(second).book.id).not.toBe(book.book.id)
        expect(added(second).book.official).toBe(false)

        expect((yield* curator.api.books.list()).map((each) => each.edition)).toEqual([
          "Second edition",
          "First edition"
        ])
        expect((yield* curator.api.jobs.list()).filter((job) => job.kind === "book-intake")).toHaveLength(2)
      }),
      AllJobKinds
    ))

  test("refuses a locked Curator, missing details, a file that is not a PDF and an empty file", () =>
    runWithWorkers(
      Effect.gen(function*() {
        const curator = yield* curatorBrowser
        const book = yield* Effect.promise(() => makeBook())
        const refusals = [
          yield* upload("", book.bytes, { title: "Practice Questions" }),
          yield* upload(curator.cookie, book.bytes, { title: "   " }),
          yield* upload(curator.cookie, new TextEncoder().encode("hello, not a pdf"), { title: "Notes" }),
          yield* upload(curator.cookie, new Uint8Array(0), { title: "Nothing" })
        ]
        expect(refusals.map((reply) => [reply.status, decodeRefused(reply.json).problem])).toEqual([
          [401, "not-unlocked"],
          [400, "details"],
          [415, "not-a-pdf"],
          [400, "empty"]
        ])
        // Only a PDF body is accepted on this path.
        const client = yield* HttpClient.HttpClient
        const asText = yield* client.execute(
          HttpClientRequest.post(`${BookUploadPath}?title=Notes`).pipe(
            HttpClientRequest.setHeader("cookie", curator.cookie),
            HttpClientRequest.bodyText("%PDF-1.7", "text/plain")
          )
        )
        expect(asText.status).toBe(415)
        expect(yield* curator.api.books.list()).toHaveLength(0)
        const folder = yield* booksFolder
        expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([])
      }),
      AllJobKinds
    ))

  test("an upload with no length, or longer than the limit, is refused before it is read", () =>
    runWithWorkers(
      Effect.gen(function*() {
        const curator = yield* curatorBrowser
        const server = yield* HttpServer.HttpServer
        const port = (server.address as { readonly port: number }).port
        const path = `${BookUploadPath}?title=Big&edition=&official=false`
        // The status line of a request sent as written.
        const send = (headers: string, body: string) =>
          Effect.promise(() =>
            new Promise<string>((resolve, reject) => {
              void Bun.connect({
                hostname: "127.0.0.1",
                port,
                socket: {
                  open: (socket) => {
                    socket.write(
                      `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/pdf\r\n` +
                        `Cookie: ${curator.cookie}\r\n${headers}\r\n${body}`
                    )
                  },
                  data: (socket, data) => {
                    resolve(new TextDecoder().decode(data).split("\r\n")[0] ?? "")
                    socket.end()
                  },
                  error: (_socket, error) => reject(error)
                }
              })
            })
          )
        expect(yield* send("Transfer-Encoding: chunked\r\n", "5\r\n%PDF-\r\n")).toStartWith("HTTP/1.1 411")
        const statusLine = yield* send(`Content-Length: ${600 * 1024 * 1024}\r\n`, "%PDF-")
        expect(statusLine).toStartWith("HTTP/1.1 413")
        // Nothing was written.
        expect(existsSync(yield* booksFolder)).toBe(false)
      }),
      AllJobKinds
    ))

  test("the stored file opens in the browser's own viewer, for the Curator only", () =>
    runWithWorkers(
      Effect.gen(function*() {
        const curator = yield* curatorBrowser
        const book = yield* Effect.promise(() => makeBook())
        const { book: view } = added(yield* upload(curator.cookie, book.bytes, { title: "Practice Questions" }))
        const client = yield* HttpClient.HttpClient
        const opened = yield* client.execute(
          HttpClientRequest.get(bookFilePath(view.id)).pipe(HttpClientRequest.setHeader("cookie", curator.cookie))
        )
        expect(opened.status).toBe(200)
        expect(opened.headers["content-type"]).toBe("application/pdf")
        expect(opened.headers["content-disposition"]).toBe(`inline; filename="Practice Questions.pdf"`)
        expect(opened.headers["content-security-policy"]).toBe("frame-ancestors 'none'")
        expect(opened.headers["x-frame-options"]).toBe("DENY")
        // Kept out of the browser's cache, where it would open after locking.
        expect(opened.headers["cache-control"]).toBe("no-store")
        expect(Buffer.from(yield* opened.arrayBuffer).equals(Buffer.from(book.bytes))).toBe(true)
        const locked = yield* client.execute(HttpClientRequest.get(bookFilePath(view.id)))
        expect(locked.status).toBe(401)
      }),
      AllJobKinds
    ))
})

describe("Reading a Book", () => {
  test("finds pages without a text layer, and routes them by whether the extraction model reads images", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure(false)
        yield* surveyByHeading
        const curator = yield* curatorBrowser
        const book = yield* Effect.promise(() => makeBook())
        const { book: view } = added(yield* upload(curator.cookie, book.bytes, { title: "Practice Questions" }))
        const read = yield* waitForStatus(curator.api, view.id, "previewed")
        expect(read.book).toMatchObject({
          pageCount: book.pageCount,
          textPages: book.pageCount - 1,
          scannedPages: [...book.scannedPages],
          scannedRoute: "review"
        })

        // A model that reads images, chosen before the full run starts,
        // takes the scanned pages instead.
        yield* configure(true)
        const started = yield* curator.api.books.start({ params: { id: view.id }, payload: { spendCap: 1 } })
        expect(started).toMatchObject({ status: "mapping", scannedRoute: "image" })
        const later = yield* Effect.promise(() => makeBook({ title: "More Practice" }))
        const { book: other } = added(yield* upload(curator.cookie, later.bytes, { title: "More Practice" }))
        const otherRead = yield* waitForStatus(curator.api, other.id, "previewed")
        expect(otherRead.book.scannedRoute).toBe("image")
      }),
      AllJobKinds
    ))

  test("a file that cannot be read is marked unreadable, with the reason, and can be read again", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure()
        const curator = yield* curatorBrowser
        const damaged = new TextEncoder().encode(`%PDF-1.7\n${"this is not really a PDF\n".repeat(50)}`)
        const { book: view } = added(yield* upload(curator.cookie, damaged, { title: "Damaged" }))
        const unreadable = yield* waitForStatus(curator.api, view.id, "unreadable")
        expect(unreadable.book.note).toStartWith("The PDF is damaged and could not be read (")
        expect(unreadable.book.job).toMatchObject({ status: "failed", note: unreadable.book.note })
        const again = yield* curator.api.books.readAgain({ params: { id: view.id } })
        expect(again).toMatchObject({ status: "added", note: null, job: { kind: "book-intake", status: "queued" } })
        const before = (yield* curator.api.jobs.list()).find((job) => job.id === unreadable.book.job?.id)
        expect(before?.status).toBe("cancelled")
      }),
      AllJobKinds
    ))
})

describe("The cost preview", () => {
  test("reads a 10-page sample, projects the full run, and waits for the Curator", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure()
        yield* surveyByHeading
        const fake = yield* FakeLlm
        const curator = yield* curatorBrowser
        // 25 pages: 24 with text and one scanned.
        const book = yield* Effect.promise(() => makeBook({ psPages: 10 }))
        const { book: view } = added(yield* upload(curator.cookie, book.bytes, { title: "Big Practice" }))
        const previewed = yield* waitForStatus(curator.api, view.id, "previewed")
        const preview = previewed.book.preview!
        expect(preview.sampledPages).toHaveLength(10)
        expect(preview.sampledPages).toEqual([...preview.sampledPages].sort((a, b) => a - b))
        expect(preview.sampledPages[0]).toBeLessThan(5)
        expect(preview.sampledPages.at(-1)).toBeGreaterThan(20)
        // Every call takes 1000 tokens in and 100 out: $0.0014 with the Book
        // Map model, $0.0028 with the extraction model.
        expect(preview.model).toBe("map-model")
        expect(preview.projectedPages).toBe(24)
        const [map, extraction] = preview.steps
        // The survey of the 10 pages, then of all 24 pages with text, since
        // the full run surveys the sampled ones again among their neighbours.
        expect(map).toMatchObject({
          name: "Book Map",
          sampledPages: 10,
          sampleTokens: 1100,
          projectedPages: 24,
          projectedTokens: 2640
        })
        expect(map?.sampleCost).toBeCloseTo(0.0014, 12)
        expect(map?.projectedCost).toBeCloseTo(0.0014 / 10 * 24, 12)
        // 9 of the 10 are Problem Solving pages; the tenth holds Data
        // Sufficiency, which this version does not extract. 9 in 10 of the
        // 24 pages with text is 22 such pages, 13 of them still to read.
        expect(extraction).toMatchObject({
          name: "Extraction",
          sampledPages: 9,
          sampleTokens: 9900,
          projectedPages: 13,
          projectedTokens: 14300
        })
        expect(extraction?.projectedCost).toBeCloseTo(9 * 0.0028 / 9 * 13, 12)
        // Two of the sample's Questions are enriched to cost enrichment: five
        // calls each. The sample holds 13 Questions besides two Retired ones,
        // so the Book's 24 pages with text hold about 31.
        const enrichment = preview.steps[2]
        expect(enrichment).toMatchObject({
          name: "Enrichment",
          unit: "question",
          sampledPages: 2,
          sampleTokens: 11000,
          projectedPages: 31,
          projectedTokens: 170500
        })
        expect(enrichment?.projectedCost).toBeCloseTo(10 * 0.0028 / 2 * 31, 12)
        expect(preview.sampleTokens).toBe(22000)
        expect(preview.projectedTokens).toBe(2640 + 14300 + 170500)
        const [sampleRequest] = yield* fake.requests
        expect(sampleRequest?.model).toBe("map-model")
        expect(quotedPages(sampleRequest!).map((page) => page.number)).toEqual([...preview.sampledPages])
        expect(previewed.book.job).toMatchObject({ kind: "book-intake", status: "done" })

        // Nothing more runs until the Curator starts the full run.
        yield* advanceUntil(Effect.succeed(undefined), { step: "1 minute", maxSteps: 10 }).pipe(Effect.ignore)
        expect(yield* fake.requests).toHaveLength(20)
        expect((yield* detailOf(curator.api, view.id)).book.status).toBe("previewed")

        const started = yield* curator.api.books.start({ params: { id: view.id }, payload: { spendCap: 0.05 } })
        expect(started.job).toMatchObject({ kind: "book-map", spendCap: 0.05, stepsTotal: 4 })
        const again = yield* curator.api.books.start({ params: { id: view.id }, payload: { spendCap: 0.05 } }).pipe(
          Effect.flip
        )
        expect(again).toMatchObject({ _tag: "BookNotReady", status: "mapping" })
        yield* waitForStatus(curator.api, view.id, "map-proposed")
        // The full run surveyed all 24 pages with text in order, ten at a time.
        const runRequests = (yield* fake.requests).slice(20)
        expect(runRequests.map((request) => quotedPages(request).length)).toEqual([10, 10, 4])
        expect(runRequests.flatMap((request) => quotedPages(request).map((page) => page.number))).toEqual(
          Array.from({ length: 25 }, (_, i) => i + 1).filter((number) => number !== 24)
        )
      }),
      AllJobKinds
    ))

  test("without models for enrichment, it is not costed and no cap is suggested, until it is costed again", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* (yield* Settings).saveLlm({
          baseUrl: "https://api.example.com/v1",
          jsonMode: "json-schema",
          models: [{ task: "book-map", model: "map-model" }, { task: "extraction", model: "text-model" }],
          prices: [
            { model: "map-model", inputPerMillion: 1, outputPerMillion: 4 },
            { model: "text-model", inputPerMillion: 2, outputPerMillion: 8 }
          ],
          readsImages: []
        })
        yield* (yield* ApiKeyStore).save("sk-test-12345678")
        yield* surveyByHeading
        const fake = yield* FakeLlm
        const curator = yield* curatorBrowser
        const book = yield* Effect.promise(() => makeBook({ psPages: 10 }))
        const { book: view } = added(yield* upload(curator.cookie, book.bytes, { title: "Big Practice" }))
        const previewed = yield* waitForStatus(curator.api, view.id, "previewed")
        expect(previewed.book.preview?.steps[2]).toMatchObject({
          name: "Enrichment",
          sampledPages: 0,
          projectedPages: 31,
          projectedCost: 0,
          costed: false
        })
        const sampleRequests = (yield* fake.requests).length

        // Once the models are set, the sample is taken again; only the
        // enrichment calls are new.
        yield* configure()
        yield* curator.api.books.readAgain({ params: { id: view.id } })
        const costed = yield* waitForStatus(curator.api, view.id, "previewed")
        expect(costed.book.preview?.steps[2]).toMatchObject({ sampledPages: 2, projectedPages: 31, costed: true })
        expect((yield* fake.requests).length - sampleRequests).toBe(10)
        // A preview with every step costed is not taken again.
        const refused = yield* curator.api.books.readAgain({ params: { id: view.id } }).pipe(Effect.flip)
        expect(refused).toMatchObject({ _tag: "BookNotReady" })
      }),
      AllJobKinds
    ))

  test("the full run needs the Book Map model set up first", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure()
        yield* surveyByHeading
        const curator = yield* curatorBrowser
        const book = yield* Effect.promise(() => makeBook())
        const { book: view } = added(yield* upload(curator.cookie, book.bytes, { title: "Practice Questions" }))
        yield* waitForStatus(curator.api, view.id, "previewed")
        yield* (yield* ApiKeyStore).remove
        const refused = yield* curator.api.books.start({ params: { id: view.id }, payload: { spendCap: 1 } }).pipe(
          Effect.flip
        )
        expect(refused).toMatchObject({ _tag: "LlmNotConfigured", missing: ["the API key"] })
      }),
      AllJobKinds
    ))
})

describe("The full run", () => {
  test("starting it again keeps one budget for the whole run", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure()
        yield* surveyByHeading
        const curator = yield* curatorBrowser
        const book = yield* Effect.promise(() => makeBook({ psPages: 10 }))
        const { book: view } = added(yield* upload(curator.cookie, book.bytes, { title: "Big Practice" }))
        yield* waitForStatus(curator.api, view.id, "previewed")
        // Two survey calls of $0.0014 pass this cap, and the run pauses.
        const started = yield* curator.api.books.start({ params: { id: view.id }, payload: { spendCap: 0.002 } })
        const paused = yield* advanceUntil(
          detailOf(curator.api, view.id).pipe(
            Effect.map((detail) => (detail.book.job?.status === "paused" ? detail : undefined))
          ),
          { step: "200 millis", maxSteps: 3000 }
        )
        expect(paused.book.runSpent).toBeCloseTo(0.0028, 12)
        yield* curator.api.jobs.cancel({ params: { id: started.job!.id } })

        const tooLow = yield* curator.api.books.start({ params: { id: view.id }, payload: { spendCap: 0.0028 } }).pipe(
          Effect.flip
        )
        expect(tooLow).toMatchObject({ _tag: "RunCapTooLow" })
        const again = yield* curator.api.books.start({ params: { id: view.id }, payload: { spendCap: 0.05 } })
        expect(again).toMatchObject({ status: "mapping", runCap: 0.05, job: { kind: "book-map" } })
        expect(again.job!.spendCap).toBeCloseTo(0.05 - 0.0028, 12)
        expect(again.runSpent).toBeCloseTo(0.0028, 12)
        const proposed = yield* waitForStatus(curator.api, view.id, "map-proposed")
        expect(proposed.book.runSpent).toBeCloseTo(0.0042, 12)
      }),
      AllJobKinds
    ))

  test("mapping a Book by hand before it starts takes the scanned-page route chosen then", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure(false)
        yield* surveyByHeading
        const curator = yield* curatorBrowser
        const book = yield* Effect.promise(() => makeBook())
        const { book: view } = added(yield* upload(curator.cookie, book.bytes, { title: "Practice Questions" }))
        expect((yield* waitForStatus(curator.api, view.id, "previewed")).book.scannedRoute).toBe("review")
        yield* configure(true)
        const confirmed = yield* curator.api.books.confirmMap({
          params: { id: view.id },
          payload: {
            ranges: [{ role: "questions", firstPage: 2, lastPage: 4, set: "Problem Solving", group: "ps" }],
            spendCap: 1
          }
        })
        expect(confirmed.book).toMatchObject({ status: "extracting", runCap: 1, scannedRoute: "image" })
      }),
      AllJobKinds
    ))

  test("a survey reply that leaves out a page is tried again", () =>
    runWithWorker(
      Effect.gen(function*() {
        yield* configure()
        yield* surveyByHeading
        const fake = yield* FakeLlm
        yield* fake.reply({ content: JSON.stringify({ pages: [] }) })
        const curator = yield* curatorBrowser
        const book = yield* Effect.promise(() => makeBook())
        const { book: view } = added(yield* upload(curator.cookie, book.bytes, { title: "Practice Questions" }))
        yield* waitForStatus(curator.api, view.id, "previewed")
        const [first, retry] = yield* fake.requests
        expect(quotedPages(retry!)).toEqual(quotedPages(first!))
        expect(retry!.messages.at(-1)?.content).toContain("it leaves out pages")
      }),
      AllJobKinds
    ))
})

describe("The Book Map", () => {
  const mappedBook = (curator: Effect.Success<typeof curatorBrowser>) =>
    Effect.gen(function*() {
      yield* configure()
      yield* surveyByHeading
      const book = yield* Effect.promise(() => makeBook({ psPages: 10 }))
      const { book: view } = added(yield* upload(curator.cookie, book.bytes, { title: "Big Practice" }))
      yield* waitForStatus(curator.api, view.id, "previewed")
      yield* curator.api.books.start({ params: { id: view.id }, payload: { spendCap: 1 } })
      return yield* waitForStatus(curator.api, view.id, "map-proposed")
    })

  const rangesOf = (detail: BookDetail) =>
    detail.proposal?.ranges.map((range) => ({
      role: range.role,
      firstPage: range.firstPage,
      lastPage: range.lastPage,
      set: range.set,
      group: range.group
    }))

  test("is proposed from the pages, with keys and explanations joined to their questions", () =>
    runWithWorker(
      Effect.gen(function*() {
        const curator = yield* curatorBrowser
        const proposed = yield* mappedBook(curator)
        expect(rangesOf(proposed)).toEqual([
          { role: "questions", firstPage: 2, lastPage: 11, set: "4.0 Problem Solving", group: "ps" },
          { role: "answer-key", firstPage: 12, lastPage: 12, set: "4.0 Problem Solving", group: "ps" },
          { role: "explanations", firstPage: 13, lastPage: 22, set: "4.0 Problem Solving", group: "ps" },
          { role: "questions", firstPage: 23, lastPage: 23, set: "Data Sufficiency", group: "ds" },
          { role: "answer-key", firstPage: 25, lastPage: 25, set: "Data Sufficiency", group: "ds" }
        ])
        expect(proposed.proposal).toMatchObject({ model: "map-model", promptVersion: "book-survey@2" })
        expect(proposed.confirmed).toBeNull()
        expect(proposed.book.job).toMatchObject({
          kind: "book-map",
          status: "done",
          result: "Proposed a Book Map of 5 ranges in 2 sets."
        })
      }),
      AllJobKinds
    ))

  test("is corrected and confirmed, and each confirmation makes a new version", () =>
    runWithWorker(
      Effect.gen(function*() {
        const curator = yield* curatorBrowser
        const proposed = yield* mappedBook(curator)
        const id = proposed.book.id
        const ranges = rangesOf(proposed)! as Array<MapRangeInput>

        const wrong: Array<MapRangeInput> = [
          ...ranges,
          { role: "answer-key", firstPage: 25, lastPage: 26, set: "Data Sufficency", group: "ds" },
          { role: "explanations", firstPage: 20, lastPage: 21, set: "4.0 Problem Solving", group: "ps" }
        ]
        const invalid = yield* curator.api.books.confirmMap({ params: { id }, payload: { ranges: wrong } }).pipe(
          Effect.flip
        )
        expect(invalid._tag).toBe("BookMapInvalid")
        expect(invalid._tag === "BookMapInvalid" && invalid.problems).toEqual([
          "Answer key, pages 25 to 26: the Book has 25 pages.",
          "Answer key, pages 25 to 26: the set \"Data Sufficency\" has no questions. Use the set name of the questions it belongs to.",
          "Two ranges of explanations in the set \"4.0 Problem Solving\" share pages: pages 13 to 22 and pages 20 to 21."
        ])
        expect((yield* detailOf(curator.api, id)).confirmed).toBeNull()

        // The scanned page 24 holds Data Sufficiency questions too.
        const fixed = ranges.map((range) =>
          range.role === "questions" && range.group === "ds" ? { ...range, lastPage: 24, set: " Data  Sufficiency " } : range
        )
        const first = yield* curator.api.books.confirmMap({ params: { id }, payload: { ranges: fixed } })
        // Confirming starts extraction, within what is left of the run's cap.
        expect(first.book).toMatchObject({ status: "extracting", mapVersion: 1, runCap: 1, job: { kind: "book-extract" } })
        // The Book Map run took three calls of $0.0014.
        expect(first.book.job!.spendCap).toBeCloseTo(1 - 0.0042, 12)
        expect(first.confirmed?.version).toBe(1)
        expect(first.confirmed?.ranges.find((range) => range.group === "ds" && range.role === "questions")).toMatchObject({
          firstPage: 23,
          lastPage: 24,
          set: "Data Sufficiency"
        })

        const renamed = fixed.map((range) =>
          range.group === "ps" ? { ...range, set: "Problem Solving practice" } : range
        )
        const second = yield* curator.api.books.confirmMap({ params: { id }, payload: { ranges: renamed } })
        expect(second.confirmed?.version).toBe(2)
        expect(second.confirmed?.ranges.filter((range) => range.set === "Problem Solving practice")).toHaveLength(3)
        expect((yield* curator.api.books.list())[0]?.mapVersion).toBe(2)
      }),
      AllJobKinds
    ))

  test("cannot be confirmed before the Book's pages are read", () =>
    runWithWorkers(
      Effect.gen(function*() {
        const curator = yield* curatorBrowser
        const book = yield* Effect.promise(() => makeBook())
        const { book: view } = added(yield* upload(curator.cookie, book.bytes, { title: "Practice Questions" }))
        const refused = yield* curator.api.books.confirmMap({
          params: { id: view.id },
          payload: { ranges: [{ role: "questions", firstPage: 2, lastPage: 4, set: "PS", group: "ps" }] }
        }).pipe(Effect.flip)
        expect(refused).toMatchObject({ _tag: "BookNotReady", status: "added" })
        const missing = yield* curator.api.books.get({ params: { id: BookId.make("no-such-book") } }).pipe(Effect.flip)
        expect(missing._tag).toBe("BookNotFound")
      }),
      AllJobKinds
    ))
})
