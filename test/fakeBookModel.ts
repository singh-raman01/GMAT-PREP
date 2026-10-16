import type { FakeOutcome, TransportRequest } from "../src/server/llm/LlmTransport.ts"

// A stand-in for the models that read the fixture book (fixtures/book.ts):
// the Book Map survey and each extraction reading, answered from the page
// text the request quotes. It writes the first question's equation in LaTeX
// and garbles the math of the remainder question, as a careless model might.

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

// Enrichment. Every fixture question's right answer is C, so by default the
// solves say C, the Approaches reach the key, and every wrong choice gets a
// note.
export interface FakeEnrichment {
  // The answer an independent solve gives, by the question's stem and run.
  readonly solve?: (stem: string, run: number) => string
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
  return {
    stem: body.split("\n\nAnswer choices:")[0] ?? "",
    labels: [...body.matchAll(/^\(([A-E])\) /gm)].map((match) => match[1]!),
    key: /^Right answer: ([A-E])$/m.exec(body)?.[1] ?? null,
    explained: body.includes("The book's explanation:")
  }
}

const enrichment = (request: TransportRequest, options: FakeEnrichment) => {
  const system = request.messages[0]?.content ?? ""
  const question = questionOf(request)
  if (system.includes("You tag a GMAT question")) {
    const offered = firstListed(system, "Skills")
    return {
      primarySkill: options.skill?.(question.stem, offered) ?? offered[0] ?? "none",
      secondarySkills: [],
      difficulty: options.difficulty?.(question.stem) ?? 0
    }
  }
  if (system.includes("You solve a GMAT question")) {
    const run = system.includes("different route") ? 2 : system.includes("check your answer") ? 3 : 1
    return { work: "Worked it out.", answer: options.solve?.(question.stem, run) ?? "C" }
  }
  const strategy = firstListed(system, "Strategies")[0] ?? "none"
  const attempt = request.messages.some((message) => message.content.includes("Your last reply had these problems")) ? 2 : 1
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
