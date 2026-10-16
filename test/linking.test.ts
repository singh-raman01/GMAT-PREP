import { describe, expect, test } from "bun:test"
import { candidateProblems, linkSet, type LinkedItem } from "../src/server/books/linking.ts"
import type { PageReading } from "../src/server/books/readings.ts"

const choices = ["A", "B", "C", "D", "E"].map((label) => ({ label, text: `${label.toLowerCase()} choice` }))

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
