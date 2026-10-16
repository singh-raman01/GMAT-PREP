import type { FakeOutcome, TransportRequest } from "../src/server/llm/LlmTransport.ts"

// A stand-in for the models that read the fixture book (fixtures/book.ts):
// the Book Map survey and each extraction reading, answered from the page
// text the request quotes. It writes the first question's equation in LaTeX
// and garbles the math of the remainder question, as a careless model might,
// and gives the boldface, EXCEPT and passage-strengthen questions the wrong
// Question Type.

// The request's own message, which a retry repeats before its feedback.
const asked = (request: TransportRequest) => request.messages.find((message) => message.role === "user")?.content ?? ""

const quoted = (request: TransportRequest, tag: string) =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(asked(request))?.[1] ?? ""

// The pages a survey request quotes, by number.
export const surveyedPages = (request: TransportRequest) =>
  [...asked(request).matchAll(/<page number="(\d+)">\n([\s\S]*?)\n<\/page>/g)].map((match) => ({
    number: Number(match[1]),
    text: match[2]!
  }))

const survey = (request: TransportRequest) => ({
  pages: surveyedPages(request).map(({ number, text }) => {
    const heading = text.split("\n")[0] ?? ""
    if (heading === "Problem Solving") return { page: number, role: "questions", group: "ps", chapter: "4.0 Problem Solving" }
    if (heading === "Answer Key") return { page: number, role: "answer-key", group: "ps", chapter: null }
    if (heading === "Answer Explanations") {
      return { page: number, role: "explanations", group: "ps", chapter: "Problem Solving" }
    }
    if (heading === "Data Sufficiency Answer Key") {
      return { page: number, role: "answer-key", group: "ds", chapter: "Data Sufficiency" }
    }
    if (heading === "Data Sufficiency") return { page: number, role: "questions", group: "ds", chapter: "Data Sufficiency" }
    for (const [chapter, group] of [["Critical Reasoning", "cr"], ["Reading Comprehension", "rc"]] as const) {
      if (heading === chapter) return { page: number, role: "questions", group, chapter }
      if (heading === `${chapter} Answer Key`) return { page: number, role: "answer-key", group, chapter }
    }
    const diGroups = [
      ["Table Analysis", "ta"],
      ["Graphics Interpretation", "gi"],
      ["Two-Part Analysis", "tpa"],
      ["Multi-Source Reasoning", "msr"]
    ] as const
    for (const [title, group] of diGroups) {
      if (heading === title) return { page: number, role: "questions", group, chapter: "Data Insights" }
    }
    // One key for every Data Insights type, so its group is mixed.
    if (heading === "Data Insights Answer Key") {
      return { page: number, role: "answer-key", group: "mixed", chapter: "Data Insights" }
    }
    return { page: number, role: "other", group: null, chapter: null }
  })
})

const transcribe = (stem: string) =>
  stem
    .replace(/(\d+x \+ \d+ = \d+)/, "\\($1\\)")
    .replace("remainder when 17", "remainder when \\(\\frac{17}{\\)")

const psQuestions = (page: string) => {
  const lines = page.split("\n")
  const questions = []
  for (let i = 0; i < lines.length; i++) {
    const question = /^(\d+)\. (.*)$/.exec(lines[i] ?? "")
    if (question === null) continue
    const choices = [...(lines[i + 1] ?? "").matchAll(/\(([A-E])\)\s*(.*?)(?=\s+\([A-E]\)|$)/g)].map((match) => ({
      label: match[1]!,
      text: match[2]!.trim()
    }))
    const stem = question[2]!
    questions.push({
      number: Number(question[1]),
      stem: transcribe(stem),
      options: choices,
      figure: false,
      retired: /triangle/.test(stem) ? "geometry" : null,
      difficulty: null
    })
  }
  return { questions }
}

const dsQuestions = (page: string) => {
  const lines = page.split("\n")
  const questions = []
  for (let i = 0; i < lines.length; i++) {
    const question = /^(\d+)\. (.*)$/.exec(lines[i] ?? "")
    if (question === null) continue
    const statements = [lines[i + 1], lines[i + 2]].map((line) => (line ?? "").replace(/^\(\d\)\s*/, ""))
    questions.push({
      number: Number(question[1]),
      question: question[2]!,
      statements,
      figure: false,
      retired: null,
      difficulty: null
    })
  }
  return { questions }
}

// A verbal question from its numbered first line: the lines up to its first
// answer choice, the last of them the question asked, then its choices.
const verbalQuestions = (lines: ReadonlyArray<string>, typeOf: (asked: string) => string) => {
  const questions = []
  for (let i = 0; i < lines.length; i++) {
    const start = /^(\d+)\. (.*)$/.exec(lines[i] ?? "")
    if (start === null) continue
    const text = [start[2]!]
    let j = i + 1
    for (; j < lines.length && !/^\(A\) /.test(lines[j] ?? ""); j++) text.push(lines[j]!)
    const options = []
    for (; j < lines.length && /^\([A-E]\) /.test(lines[j] ?? ""); j++) {
      options.push({ label: lines[j]!.slice(1, 2), text: lines[j]!.slice(4) })
    }
    const asked = text.at(-1)!
    const stem = text.length === 1 ? asked : `${text.slice(0, -1).join(" ")}\n\n${asked}`
    questions.push({ number: Number(start[1]), stem, options, type: typeOf(asked), difficulty: null })
  }
  return questions
}

const crType = (asked: string) =>
  /EXCEPT/.test(asked)
    ? "verbal.cr-weaken"
    : /boldface/.test(asked)
    ? "verbal.cr-inference"
    : /weaken/.test(asked)
    ? "verbal.cr-weaken"
    : "verbal.cr-inference"

const rcType = (asked: string) =>
  /primary purpose/.test(asked)
    ? "verbal.rc-main-idea"
    : /^According to the passage/.test(asked)
    ? "verbal.rc-detail"
    : "verbal.rc-inference"

const crQuestions = (page: string) => ({ questions: verbalQuestions(page.split("\n"), crType) })

// A passage runs from the line that names its questions to the first
// question.
const rcPage = (page: string) => {
  const lines = page.split("\n")
  const passages = []
  for (let i = 0; i < lines.length; i++) {
    const range = /^Questions (\d+) to (\d+) refer to the passage below\.$/.exec(lines[i] ?? "")
    if (range === null) continue
    const text = []
    for (let j = i + 1; j < lines.length && !/^\d+\. /.test(lines[j] ?? ""); j++) text.push(lines[j]!)
    const first = Number(range[1])
    passages.push({ text: text.join(" "), questions: Array.from({ length: Number(range[2]) - first + 1 }, (_, k) => first + k) })
  }
  return { passages, questions: verbalQuestions(lines, rcType) }
}

// The Data Insights pages of the fixture (fixtures/book.ts). A table is a
// header line and rows, cells set apart with " | ", a heading's unit in
// brackets.
const tableOf = (header: string, rows: ReadonlyArray<string>) => {
  const cells = rows.map((row) => row.split(" | ").map((cell) => cell.trim()))
  return {
    columns: header.split(" | ").map((heading, index) => {
      const unit = /\((.*)\)$/.exec(heading)?.[1] ?? ""
      const column = cells.map((row) => row[index] ?? "")
      const type = column.every((cell) => /%$/.test(cell))
        ? "percent"
        : unit.startsWith("$")
        ? "currency"
        : column.every((cell) => /^-?[\d,.]+$/.test(cell))
        ? "number"
        : "text"
      return { name: heading.replace(/\s*\(.*\)$/, "").trim(), type, unit }
    }),
    rows: cells
  }
}

// The lines of each question on a page: its number, its first line's words,
// and the lines up to the next question.
const numberedItems = (lines: ReadonlyArray<string>) => {
  const items: Array<{ number: number; first: string; rest: Array<string> }> = []
  for (const line of lines) {
    const start = /^(\d+)\. (.*)$/.exec(line)
    if (start !== null) items.push({ number: Number(start[1]), first: start[2]!, rest: [] })
    else items.at(-1)?.rest.push(line)
  }
  return items
}

// A table's line; a statement's menu options are set apart the same way, so
// a line with a blank is not one.
const isRow = (line: string) => line.includes(" | ") && !line.includes("[blank]")

const taQuestions = (page: string) => ({
  questions: numberedItems(page.split("\n")).map((item) => {
    const rows = item.rest.filter(isRow)
    const after = item.rest.slice(item.rest.findIndex((line) => line.startsWith("For each statement")) + 1)
    return {
      number: item.number,
      intro: item.first,
      table: tableOf(rows[0]!, rows.slice(1)),
      pair: ["Yes", "No"],
      statements: after,
      difficulty: null
    }
  })
})

// A statement with a menu: [blank] where the menu goes, its options in
// brackets at the end.
const blankStatement = (line: string) => {
  const options = /\(([^()]*)\)$/.exec(line)?.[1]?.split(" | ") ?? []
  return { text: line.replace(/\s*\([^()]*\)$/, "").replace("[blank]", "{{blank}}"), options }
}

const giQuestions = (page: string) => ({
  questions: numberedItems(page.split("\n")).map((item) => {
    const rows = item.rest.filter(isRow)
    const data = rows.length === 0 ? null : tableOf(rows[0]!, rows.slice(1))
    return {
      number: item.number,
      intro: item.first,
      chart: data === null
        ? null
        : { kind: "bar", title: "", data, x: data.columns[0]!.name, y: data.columns[1]!.name, series: "", sets: [] },
      figure: data === null,
      statements: item.rest.filter((line) => line.includes("[blank]")).map(blankStatement),
      difficulty: null
    }
  })
})

const tpaQuestions = (page: string) => ({
  questions: numberedItems(page.split("\n")).map((item) => {
    const heading = item.rest.findIndex(isRow)
    return {
      number: item.number,
      stem: [item.first, ...item.rest.slice(0, heading)].join(" "),
      columns: item.rest[heading]!.split(" | "),
      options: item.rest.slice(heading + 1),
      difficulty: null
    }
  })
})

const msrPage = (page: string) => {
  const lines = page.split("\n")
  const range = lines.map((line) => /^Questions (\d+) to (\d+) refer to the sources below\.$/.exec(line)).find((match) => match !== null)
  const numbers = range === undefined || range === null
    ? []
    : Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, k) => Number(range[1]) + k)
  const sources = lines.flatMap((line): ReadonlyArray<{
    readonly title: string
    readonly kind: string
    readonly text: string
    readonly table: ReturnType<typeof tableOf> | null
    readonly questions: ReadonlyArray<number>
  }> => {
    const tab = /^Tab ([^:]+): (.*)$/.exec(line)
    if (tab === null) return []
    const [title, body] = [tab[1]!, tab[2]!]
    if (!isRow(body)) return [{ title, kind: "text", text: body, table: null, questions: numbers }]
    const [header, ...rows] = body.split(" / ")
    return [{ title, kind: "table", text: "", table: tableOf(header!, rows), questions: numbers }]
  })
  const questions = numberedItems(lines.filter((line) => !line.startsWith("Tab "))).map((item) => {
    const choices = [...(item.rest[0] ?? "").matchAll(/\(([A-E])\)\s*(.*?)(?=\s+\([A-E]\)|$)/g)]
    return choices.length > 0
      ? {
        number: item.number,
        stem: item.first,
        options: choices.map((match) => ({ label: match[1]!, text: match[2]!.trim() })),
        statements: [],
        pair: [],
        difficulty: null
      }
      : { number: item.number, stem: item.first, options: [], statements: item.rest, pair: ["Yes", "No"], difficulty: null }
  })
  return { sources, questions }
}

// An answer key whose questions may have several parts: each part's answer
// as printed, set apart with commas.
const partsAnswers = (page: string) => ({
  answers: [...page.matchAll(/^(\d+)\. (.+)$/gm)].map((match) => ({
    number: Number(match[1]),
    parts: match[2]!.split(", ").map((part) => part.trim())
  }))
})

const answers = (page: string) => ({
  answers: [...page.matchAll(/^(\d+)\. ([A-E])$/gm)].map((match) => ({ number: Number(match[1]), answer: match[2] }))
})

const explanations = (page: string, label: FakeEnrichment["label"]) => {
  const lines = page.split("\n")
  const items = []
  for (let i = 0; i < lines.length; i++) {
    const start = /^(\d+)\. (.*)$/.exec(lines[i] ?? "")
    if (start === null) continue
    const answer = /^The answer is ([A-E])\.$/.exec(lines[i + 1] ?? "")?.[1] ?? null
    const number = Number(start[1])
    items.push({ number, explanation: start[2], answer, difficulty: label?.(number) ?? null })
  }
  return { explanations: items }
}

// Token counts per call, for the spend each test expects.
export const FakeTokens = { tokensIn: 1000, tokensOut: 100 } as const

// Enrichment. Every fixture question's right answer is C but for its two
// Data Sufficiency questions, so by default the solves give the fixture's
// key, the Approaches reach the key, and every wrong choice gets a note.
export interface FakeEnrichment {
  // The answer an independent solve gives, by the question's stem and run;
  // the fixture's key when it gives none.
  readonly solve?: (stem: string, run: number) => string | undefined
  // The answer the Approaches reach, by the key and the attempt (2 when the
  // first reply was sent back).
  readonly approachAnswer?: (key: string, attempt: number) => string
  // The Difficulty estimate, by stem.
  readonly difficulty?: (stem: string) => number
  // The primary Skill, by stem and the Skills offered.
  readonly skill?: (stem: string, offered: ReadonlyArray<string>) => string
  // The difficulty label an explanation prints, by question number.
  readonly label?: (number: number) => "easy" | "medium" | "hard" | null
}

const firstListed = (system: string, heading: string) =>
  [...(system.split(`${heading}:\n`)[1] ?? "").matchAll(/^- ([\w.-]+):/gm)].map((match) => match[1]!)

const questionOf = (request: TransportRequest) => {
  const body = quoted(request, "question")
  // A Question with several Parts lists each Part and its options.
  const parts = body.split(/^Part \d+ \([^)]*\):.*$/m).slice(1).map((section) =>
    [...section.matchAll(/^\(([A-H])\) /gm)].map((match) => match[1]!)
  )
  const asked = body.split("\n\nThe question:\n").at(-1) ?? body
  return {
    stem: (parts.length > 0 ? asked.split(/\n\nPart 1 /)[0] : asked.split("\n\nAnswer choices:")[0]) ?? "",
    labels: [...body.matchAll(/^\(([A-E])\) /gm)].map((match) => match[1]!),
    key: /^Right answer: ([A-E])$/m.exec(body)?.[1] ?? null,
    parts,
    keys: [...(/^Right answers: (.*)$/m.exec(body)?.[1] ?? "").matchAll(/part \d+ ([A-H])/g)].map((match) => match[1]!),
    explained: body.includes("The book's explanation:")
  }
}

// The fixture's Data Insights keys, by the start of the question.
const fixtureParts = (stem: string): ReadonlyArray<string> | undefined =>
  /^The table shows sales/.test(stem)
    ? ["A", "B", "A"]
    : /^The chart shows units/.test(stem)
    ? ["B", "B"]
    : /^The figure shows the floor plan/.test(stem)
    ? ["B"]
    : /^A rectangle's sides/.test(stem)
    ? ["B", "C"]
    : /^For each statement, choose Yes if the sources/.test(stem)
    ? ["A", "A"]
    : undefined

// The fixture's keys: C, but for its two Data Sufficiency questions.
const fixtureKey = (stem: string) => (/^What is the value of x\?/.test(stem) ? "A" : /^Is n even\?/.test(stem) ? "D" : "C")

const enrichment = (request: TransportRequest, options: FakeEnrichment) => {
  const system = request.messages[0]?.content ?? ""
  const question = questionOf(request)
  if (system.includes("You tag a GMAT question")) {
    const offered = firstListed(system, "Skills")
    // A Data Sufficiency question's maths, and whether it asks for a value.
    const sufficiency = system.includes("This is a Data Sufficiency question")
    const maths = offered.filter((skill) => !skill.startsWith("di.sufficiency."))
    return {
      primarySkill: options.skill?.(question.stem, maths) ?? maths[0] ?? "none",
      secondarySkills: sufficiency ? [/^Is /.test(question.stem) ? "di.sufficiency.yes-no" : "di.sufficiency.value"] : [],
      difficulty: options.difficulty?.(question.stem) ?? 0
    }
  }
  if (system.includes("You solve a GMAT question")) {
    const run = system.includes("different route") ? 2 : system.includes("check your answer") ? 3 : 1
    const solved = options.solve?.(question.stem, run)
    if (question.parts.length > 0) {
      return {
        work: "Worked it out.",
        answers: solved?.split(",") ?? fixtureParts(question.stem) ?? question.parts.map((labels) => labels[0] ?? "A")
      }
    }
    return { work: "Worked it out.", answer: solved ?? fixtureKey(question.stem) }
  }
  const strategy = firstListed(system, "Strategies")[0] ?? "none"
  const attempt = request.messages.some((message) => message.content.includes("Your last reply had these problems")) ? 2 : 1
  if (question.parts.length > 0) {
    const keys = question.keys
    const reached = options.approachAnswer?.(keys.join(","), attempt) ?? keys.join(",")
    return {
      approaches: [{ strategy, steps: "1. Work it out.", expectedSeconds: 120, validWhen: "Always.", answers: reached.split(",") }],
      bookApproach: question.explained ? { strategy, expectedSeconds: 150, validWhen: "Always." } : null,
      wrongOptions: question.parts.flatMap((labels, part) =>
        labels.filter((label) => label !== keys[part]).map((label) => ({
          // Numbered from 1, as the prompt asks.
          part: part + 1,
          label,
          trapNote: `Choice ${label} of part ${part + 1} comes from a slip.`,
          mistakeType: "calculation-slip",
          trapPattern: null
        }))
      )
    }
  }
  const key = question.key ?? "C"
  return {
    approaches: [{
      strategy,
      steps: "1. Work it out.",
      expectedSeconds: 90,
      validWhen: "Always.",
      answer: options.approachAnswer?.(key, attempt) ?? key
    }],
    bookApproach: question.explained ? { strategy, expectedSeconds: 120, validWhen: "Always." } : null,
    wrongOptions: question.labels.filter((label) => label !== key).map((label) => ({
      label,
      trapNote: `Choice ${label} comes from a slip.`,
      mistakeType: "calculation-slip",
      trapPattern: null
    }))
  }
}

export const makeFakeBookModel = (options: FakeEnrichment = {}) => (request: TransportRequest): FakeOutcome => {
  const system = request.messages[0]?.content ?? ""
  const page = quoted(request, "page")
  const reply = system.includes("say what each page holds")
    ? survey(request)
    : system.includes("You tag a GMAT question") || system.includes("You solve a GMAT question") ||
        system.includes("You write teaching material")
    ? enrichment(request, options)
    : system.includes("Problem Solving questions")
    ? psQuestions(page)
    : system.includes("Data Sufficiency questions")
    ? dsQuestions(page)
    : system.includes("Critical Reasoning questions")
    ? crQuestions(page)
    : system.includes("Reading Comprehension passages")
    ? rcPage(page)
    : system.includes("Table Analysis questions")
    ? taQuestions(page)
    : system.includes("Graphics Interpretation questions")
    ? giQuestions(page)
    : system.includes("Two-Part Analysis questions")
    ? tpaQuestions(page)
    : system.includes("Multi-Source Reasoning sets")
    ? msrPage(page)
    : system.includes("may have several parts")
    ? partsAnswers(page)
    : system.includes("answer keys")
    ? answers(page)
    : system.includes("worked explanations")
    ? explanations(page, options.label)
    : system.includes("difficulty labels")
    ? { labels: [] }
    : { numbers: [...page.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1])) }
  return { content: JSON.stringify(reply), ...FakeTokens }
}

export const fakeBookModel = makeFakeBookModel()
