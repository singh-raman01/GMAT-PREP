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
  return {
    stem: body.split("\n\nAnswer choices:")[0] ?? "",
    labels: [...body.matchAll(/^\(([A-E])\) /gm)].map((match) => match[1]!),
    key: /^Right answer: ([A-E])$/m.exec(body)?.[1] ?? null,
    explained: body.includes("The book's explanation:")
  }
}

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
    return { work: "Worked it out.", answer: options.solve?.(question.stem, run) ?? fixtureKey(question.stem) }
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
    : system.includes("Data Sufficiency questions")
    ? dsQuestions(page)
    : system.includes("Critical Reasoning questions")
    ? crQuestions(page)
    : system.includes("Reading Comprehension passages")
    ? rcPage(page)
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
