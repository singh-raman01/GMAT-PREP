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

const explanations = (page: string) => {
  const lines = page.split("\n")
  const items = []
  for (let i = 0; i < lines.length; i++) {
    const start = /^(\d+)\. (.*)$/.exec(lines[i] ?? "")
    if (start === null) continue
    const answer = /^The answer is ([A-E])\.$/.exec(lines[i + 1] ?? "")?.[1] ?? null
    items.push({ number: Number(start[1]), explanation: start[2], answer, difficulty: null })
  }
  return { explanations: items }
}

// Token counts per call, for the spend each test expects.
export const FakeTokens = { tokensIn: 1000, tokensOut: 100 } as const

export const fakeBookModel = (request: TransportRequest): FakeOutcome => {
  const system = request.messages[0]?.content ?? ""
  const page = quoted(request, "page")
  const reply = system.includes("say what each page holds")
    ? survey(request)
    : system.includes("Problem Solving questions")
    ? psQuestions(page)
    : system.includes("answer keys")
    ? answers(page)
    : system.includes("worked explanations")
    ? explanations(page)
    : system.includes("difficulty labels")
    ? { labels: [] }
    : { numbers: [...page.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1])) }
  return { content: JSON.stringify(reply), ...FakeTokens }
}
