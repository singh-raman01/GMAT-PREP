import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { parseCell } from "../src/api/dataset.ts"
import type { Dataset } from "../src/api/dataset.ts"
import type { PracticeChoice, PracticeView } from "../src/api/Practice.ts"
import { FigureFiles } from "../src/server/books/FigureFiles.ts"
import { datasetOf, seedBook, type SeedPart } from "./fixtures/bank.ts"
import { openInspectableBrowser, runWithWorkers } from "./harness.ts"

const learner = Effect.gen(function*() {
  const browser = yield* openInspectableBrowser
  yield* browser.api.profiles.create({ payload: { name: "Asha" } })
  const token = Option.getOrThrow(yield* browser.cookie("gp_profile"))
  return { api: browser.api, cookie: `gp_profile=${token}` }
})

const filters = (settings: Partial<Extract<PracticeChoice, { kind: "filters" }>> = {}): PracticeChoice => ({
  kind: "filters",
  status: "any",
  size: 10,
  section: "di",
  ...settings
})

const typed = (columns: Dataset["columns"], rows: ReadonlyArray<ReadonlyArray<string>>) =>
  datasetOf(columns, rows, (column, text) => {
    const parsed = parseCell(columns[column]!.type, text)
    return "value" in parsed ? parsed.value : null
  })

const regions = typed(
  [
    { name: "Region", type: "text", unit: "" },
    { name: "Sales", type: "currency", unit: "$ thousands" },
    { name: "Growth", type: "percent", unit: "" }
  ],
  [["North", "$1,200", "4%"], ["South", "$980", "-2%"], ["East", "$15", "12.5%"]]
)

const statement = (prompt: string, key: "A" | "B"): SeedPart =>
  ({ kind: "two-choice", prompt, options: ["Yes", "No"], key })

const tableAnalysis = {
  number: 1,
  questionType: "di.ta",
  stimulus: { kind: "table" as const, body: "Sales by region last year.", dataset: regions },
  parts: [
    statement("North sold the most.", "A"),
    statement("Every region grew.", "B"),
    statement("East grew fastest.", "A")
  ]
}

const sending = (view: PracticeView, choices: ReadonlyArray<string>) => ({
  params: { id: view.id },
  payload: {
    seq: view.nextSeq,
    questionId: view.current!.question.id,
    selection: choices.map((choice, part) => ({ part, choice })),
    guessed: false
  }
})

describe("Data Insights Questions in Practice", () => {
  test("a Table Analysis Question shows its typed table and is right only when every statement is", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("DI Review", [tableAnalysis, { ...tableAnalysis, number: 2 }])
      const asha = yield* learner
      const started = yield* asha.api.practice.start({ payload: { choice: filters({ size: 2 }) } })
      const question = started.current!.question
      expect(question.stimulus).toMatchObject({ kind: "table", body: "Sales by region last year.", image: null, tabs: [] })
      expect(question.stimulus?.dataset?.columns.map((column) => column.type)).toEqual(["text", "currency", "percent"])
      expect(question.stimulus?.dataset?.rows[0]).toEqual([
        { text: "North", value: null },
        { text: "$1,200", value: 1200 },
        { text: "4%", value: 4 }
      ])
      expect(question.parts.map((part) => [part.kind, part.prompt, part.options.map((option) => option.text)])).toEqual([
        ["two-choice", "North sold the most.", ["Yes", "No"]],
        ["two-choice", "Every region grew.", ["Yes", "No"]],
        ["two-choice", "East grew fastest.", ["Yes", "No"]]
      ])

      // Every statement needs an answer.
      const partial = yield* asha.api.practice.answer({
        params: { id: started.id },
        payload: { seq: started.nextSeq, questionId: question.id, selection: [{ part: 0, choice: "A" }], guessed: false }
      }).pipe(Effect.flip)
      expect(partial).toMatchObject({
        _tag: "SelectionInvalid",
        problems: ["Choose an answer for Part 2.", "Choose an answer for Part 3."]
      })

      // Two of three right is wrong.
      const missed = yield* asha.api.practice.answer(sending(started, ["A", "A", "A"]))
      expect(missed.current?.response).toMatchObject({ correct: false })
      expect(missed.current?.debrief).toMatchObject({
        correct: false,
        keys: [{ part: 0, key: "A" }, { part: 1, key: "B" }, { part: 2, key: "A" }],
        trapNotes: [{ part: 1, label: "A" }]
      })
      // The Approaches reach every Part's key.
      expect(missed.current?.debrief?.approaches.length).toBeGreaterThan(0)

      const second = yield* asha.api.practice.next({ params: { id: started.id }, payload: { position: 1 } })
      const right = yield* asha.api.practice.answer(sending(second, ["A", "B", "A"]))
      expect(right.current?.response?.correct).toBe(true)
    })))

  test("a chart is drawn from its Dataset and served as SVG, and a figure as PNG, to an unlocked Profile", () =>
    runWithWorkers(Effect.gen(function*() {
      const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
      const file = yield* (yield* FigureFiles).keep(png)
      const sales = {
        $schema: "https://vega.github.io/schema/vega-lite/v6.json",
        data: { name: "dataset" },
        mark: "bar",
        encoding: { x: { field: "Region", type: "nominal" }, y: { field: "Sales", type: "quantitative" } }
      }
      const blank = (prompt: string, options: ReadonlyArray<string>, key: string): SeedPart =>
        ({ kind: "dropdown", prompt, options, key })
      yield* seedBook("DI Review", [
        {
          number: 1,
          questionType: "di.gi",
          stimulus: { kind: "chart", dataset: regions, spec: sales },
          parts: [
            blank("North sold {{blank}} South.", ["less than", "about as much as", "more than"], "C"),
            blank("The total is closest to {{blank}} thousand dollars.", ["1,500", "2,200", "3,000"], "B")
          ]
        },
        { number: 2, questionType: "di.gi", stimulus: { kind: "figure", file }, parts: [blank("It shows {{blank}}.", ["a", "b"], "A")] }
      ])
      const asha = yield* learner
      const started = yield* asha.api.practice.start({ payload: { choice: filters({ size: 2 }) } })
      const client = yield* HttpClient.HttpClient
      const fetch = (path: string, cookie: string) =>
        client.execute(HttpClientRequest.get(path).pipe(HttpClientRequest.setHeader("cookie", cookie)))
      const seen: Array<string> = []
      let view = started
      for (let position = 0; position < 2; position++) {
        const stimulus = view.current!.question.stimulus!
        const image = yield* fetch(stimulus.image!, asha.cookie)
        expect(image.status).toBe(200)
        seen.push(`${stimulus.kind} ${image.headers["content-type"]}`)
        if (stimulus.kind === "chart") {
          const svg = yield* image.text
          expect(svg).toStartWith("<svg")
          expect(svg).toContain("North")
          expect(stimulus.dataset?.rows).toHaveLength(3)
          expect(view.current!.question.parts.map((part) => part.kind)).toEqual(["dropdown", "dropdown"])
        } else {
          expect(new Uint8Array(yield* image.arrayBuffer)).toEqual(png)
        }
        expect((yield* fetch(stimulus.image!, "")).status).toBe(401)
        view = yield* asha.api.practice.answer(sending(view, view.current!.question.parts.map(() => "A")))
        if (position === 0) view = yield* asha.api.practice.next({ params: { id: started.id }, payload: { position: 1 } })
      }
      expect(seen.toSorted()).toEqual(["chart image/svg+xml", "figure image/png"])
    })))

  test("a Multi-Source Reasoning set's Questions share their tabs and come together; TPA columns share one list", () =>
    runWithWorkers(Effect.gen(function*() {
      const tabs = {
        kind: "tabs" as const,
        share: "set",
        tabs: [
          { title: "Email", kind: "passage" as const, body: "The plant ships on Fridays." },
          { title: "Schedule", kind: "table" as const, dataset: regions }
        ]
      }
      const msr = (number: number) => ({ number, questionType: "di.msr", stimulus: tabs })
      const column = (prompt: string, key: string): SeedPart =>
        ({ kind: "column-choice", prompt, options: ["2", "3", "4", "5", "6", "7"], key })
      yield* seedBook("DI Review", [
        msr(1),
        msr(2),
        { number: 3, questionType: "di.tpa", parts: [column("Width", "B"), column("Height", "B")] },
        msr(4)
      ])
      const asha = yield* learner
      for (let set = 0; set < 3; set++) {
        const started = yield* asha.api.practice.start({ payload: { choice: filters({ size: 4 }) } })
        const kinds: Array<string> = []
        let view = started
        while (view.current !== null) {
          const question = view.current.question
          kinds.push(question.stimulus?.kind ?? question.parts.map((part) => part.kind).join("+"))
          if (question.stimulus?.kind === "tabs") {
            expect(question.stimulus.tabs.map((tab) => [tab.title, tab.kind])).toEqual([["Email", "passage"], [
              "Schedule",
              "table"
            ]])
          }
          view = yield* asha.api.practice.answer(sending(view, question.parts.map(() => "B")))
          if (view.current === null || view.current.position + 1 >= view.total) break
          view = yield* asha.api.practice.next({ params: { id: view.id }, payload: { position: view.current.position + 1 } })
        }
        // The set's three tabs Questions sit together, before or after the TPA.
        expect(["tabs,tabs,tabs,column-choice+column-choice", "column-choice+column-choice,tabs,tabs,tabs"])
          .toContain(kinds.join(","))
      }
    })))
})
