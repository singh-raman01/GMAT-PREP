import { describe, expect, test } from "bun:test"
import {
  type Candidate,
  candidateProblems,
  DsOptions,
  linkSet,
  type LinkedItem,
  settledType
} from "../src/server/books/linking.ts"
import type { PageReading } from "../src/server/books/readings.ts"

const choices = (["A", "B", "C", "D", "E"] as const).map((label) => ({ label, text: `${label.toLowerCase()} choice` }))

const questionsPage = (items: ReadonlyArray<{ readonly number: number; readonly stem: string }>): PageReading => ({
  role: "questions",
  group: "ps",
  value: {
    questions: items.map((item) => ({
      number: item.number,
      stem: item.stem,
      options: choices,
      figure: false,
      retired: null,
      difficulty: null
    }))
  }
} as PageReading)

const keyPage = (answers: ReadonlyArray<readonly [number, string]>): PageReading => ({
  role: "answer-key",
  value: { answers: answers.map(([number, answer]) => ({ number, answer })) }
} as PageReading)

const explanationsPage = (items: ReadonlyArray<readonly [number, string]>): PageReading => ({
  role: "explanations",
  value: {
    explanations: items.map(([number, answer]) => ({ number, explanation: "Work it out.", answer, difficulty: null }))
  }
} as PageReading)

const summary = (items: ReadonlyArray<LinkedItem>) =>
  items.map((item) =>
    item._tag === "Skip"
      ? `${item.number} on page ${item.page}: skipped, ${item.reason}`
      : `${item.number} on page ${item.page}: key ${item.key}; ${candidateProblems(item).map((reason) => reason.code).join(", ")}`
  )

describe("Linking a question set", () => {
  test("a second item with a number the set already has is skipped and counted; the same item read twice is not", () => {
    const linked = linkSet({
      questions: [
        { page: 2, reading: questionsPage([{ number: 1, stem: "What is the value of x if 2x = 6?" }]) },
        // The question running onto the next page, read again.
        { page: 3, reading: questionsPage([{ number: 1, stem: "What is the value of x if 2x = 6?" }, { number: 2, stem: "How many?" }]) },
        // Numbering that starts again.
        { page: 4, reading: questionsPage([{ number: 1, stem: "A train leaves a station at noon. When does it arrive?" }]) }
      ],
      answers: [keyPage([[1, "C"], [2, "B"]])],
      explanations: [],
      labels: []
    })
    expect(summary(linked)).toEqual([
      "1 on page 2: key C; ",
      "2 on page 3: key B; ",
      "1 on page 4: skipped, repeated-number"
    ])
  })

  test("two answers for one number give no key and a key conflict, whatever the explanation says", () => {
    const linked = linkSet({
      questions: [{ page: 2, reading: questionsPage([{ number: 1, stem: "What is x?" }, { number: 2, stem: "What is y?" }]) }],
      answers: [keyPage([[1, "B"]]), keyPage([[1, "C"], [2, "A"]])],
      explanations: [explanationsPage([[1, "C"], [2, "A"]]), explanationsPage([[2, "D"]])],
      labels: []
    })
    expect(summary(linked)).toEqual([
      "1 on page 2: key null; key-conflict",
      "2 on page 2: key A; key-conflict"
    ])
    const [first, second] = linked.flatMap((item) => (item._tag === "Candidate" ? candidateProblems(item) : []))
    expect(first?.detail).toBe("The answer key gives more than one answer for it: B, C.")
    expect(second?.detail).toBe("Its explanations give different answers: A, D.")
  })
})

const verbalItem = (number: number, stem: string, type: string) => ({ number, stem, options: choices, type, difficulty: null })

const candidates = (items: ReadonlyArray<LinkedItem>) => items.filter((item): item is Candidate => item._tag === "Candidate")

describe("Verbal and Data Sufficiency questions", () => {
  test("the question's own words settle its type where the Taxonomy has a rule", () => {
    const argument = "The town says a new bus route will cut traffic, since drivers will take the bus."
    const cr = (asked: string, type: string) => settledType("cr", `${argument}\n\n${asked}`, type)
    expect(cr("In the argument, the two portions in boldface play which of the following roles?", "verbal.cr-inference"))
      .toBe("verbal.cr-structure")
    expect(cr("The argument proceeds by which of the following methods of reasoning?", "verbal.cr-flaw"))
      .toBe("verbal.cr-structure")
    expect(cr("The argument is most vulnerable to criticism on the grounds that it", "verbal.cr-flaw")).toBe("verbal.cr-flaw")
    expect(cr("Which of the following describes the method of reasoning the argument uses?", "verbal.cr-flaw"))
      .toBe("verbal.cr-structure")
    expect(cr("Each of the following, if true, strengthens the argument EXCEPT:", "verbal.cr-weaken")).toBe("verbal.cr-strengthen")
    expect(cr("Each of the following, if true, casts doubt on the plan EXCEPT:", "verbal.cr-strengthen")).toBe("verbal.cr-weaken")
    // A word in the argument does not count; only the question asked does.
    expect(settledType("cr", "The mayor supports the plan.\n\nWhich of the following most weakens it EXCEPT:", "verbal.cr-weaken"))
      .toBe("verbal.cr-weaken")
    expect(cr("Which of the following is an assumption the argument depends on?", "verbal.cr-assumption"))
      .toBe("verbal.cr-assumption")
    expect(settledType("rc", "Which of the following, if true, would most strengthen the author's claim?", "verbal.rc-inference"))
      .toBe("verbal.rc-application")
    expect(settledType("rc", "The author would most likely support which of the following?", "verbal.rc-inference"))
      .toBe("verbal.rc-inference")
  })

  test("a passage serves the questions it names, on its own page and the next", () => {
    const linked = linkSet({
      questions: [
        {
          page: 5,
          reading: {
            role: "questions",
            group: "rc",
            value: {
              passages: [{ text: "  The council met twice.  ", questions: [1, 2, 3] }],
              questions: [verbalItem(1, "The primary purpose of the passage is to", "verbal.rc-main-idea")]
            }
          }
        },
        {
          page: 6,
          reading: {
            role: "questions",
            group: "rc",
            value: {
              passages: [],
              questions: [
                verbalItem(2, "Which of the following, if true, would most weaken the claim?", "verbal.rc-inference"),
                verbalItem(4, "According to the passage, when did it start?", "verbal.rc-detail")
              ]
            }
          }
        }
      ],
      answers: [keyPage([[1, "C"], [2, "C"], [4, "C"]])],
      explanations: [],
      labels: []
    })
    const [first, second, fourth] = candidates(linked)
    expect(first).toMatchObject({ section: "verbal", questionType: "verbal.rc-main-idea", passage: "The council met twice." })
    expect(second).toMatchObject({ page: 6, questionType: "verbal.rc-application", passage: "The council met twice." })
    // No passage names the fourth, so it waits in the Review Queue.
    expect(fourth?.passage).toBeNull()
    expect(candidateProblems(fourth!)).toEqual([
      { code: "structure", detail: "The readings do not say which passage it asks about." }
    ])
    expect(candidateProblems(first!)).toEqual([])
  })

  test("a Data Sufficiency question is the question and its statements, with the five fixed choices, in Data Insights", () => {
    const linked = linkSet({
      questions: [{
        page: 9,
        reading: {
          role: "questions",
          group: "ds",
          value: {
            questions: [
              { number: 1, question: "Is n even?", statements: ["n + 1 is odd.", "3n is even."], figure: false, retired: null, difficulty: null },
              {
                number: 2,
                question: "What is the area of the triangle?",
                statements: ["Its base is 4.", "Its height is 3."],
                figure: false,
                retired: "geometry",
                difficulty: null
              }
            ]
          }
        }
      }],
      answers: [keyPage([[1, "D"], [2, "C"]])],
      explanations: [],
      labels: []
    })
    expect(linked[0]).toMatchObject({
      _tag: "Candidate",
      section: "di",
      questionType: "di.ds",
      stem: "Is n even?\n\n(1) n + 1 is odd.\n\n(2) 3n is even.",
      options: DsOptions,
      key: "D"
    })
    expect(linked[1]).toMatchObject({ _tag: "Skip", reason: "geometry" })
  })
})
