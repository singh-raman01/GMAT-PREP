import { describe, expect, test } from "bun:test"
import {
  type Candidate,
  candidateProblems,
  DsOptions,
  dsStem,
  linkSet,
  type LinkedItem,
  NearMatch,
  nearText,
  settledType,
  similarity,
  trigrams
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

describe("The verbal type rules", () => {
  const argument = "Officials say the new bus route will cut traffic downtown, because many drivers will take the bus."
  const cr = (asked: string, type: string) => settledType("cr", `${argument}\n\n${asked}`, type)

  test("leave a right reading alone when the question only mentions support or a method", () => {
    const stands: ReadonlyArray<readonly [string, string]> = [
      ["Each of the following, if true, undermines the evidence offered in support of the conclusion EXCEPT:", "verbal.cr-weaken"],
      ["Each of the following, if true, weakens the support for the officials' prediction EXCEPT:", "verbal.cr-weaken"],
      ["Each of the following is supported by the information above EXCEPT:", "verbal.cr-inference"],
      ["The statements above, if true, most strongly support each of the following EXCEPT:", "verbal.cr-inference"],
      ["Each of the following would be useful to know in judging the support for the conclusion EXCEPT:", "verbal.cr-evaluate"],
      ["Which of the following points to a flaw in the method of reasoning used above?", "verbal.cr-flaw"],
      ["The method of reasoning above is most vulnerable to criticism on the grounds that it", "verbal.cr-flaw"]
    ]
    for (const [asked, type] of stands) expect(cr(asked, type)).toBe(type)
  })

  test("swap strengthen and weaken only for an EXCEPT question read as the opposite task", () => {
    expect(cr("Each of the following, if true, would support the officials' claim EXCEPT:", "verbal.cr-weaken"))
      .toBe("verbal.cr-strengthen")
    expect(cr("Each of the following, if true, undermines the evidence offered in support of the conclusion EXCEPT:", "verbal.cr-strengthen"))
      .toBe("verbal.cr-weaken")
    expect(cr("Each of the following, if true, strengthens the argument EXCEPT:", "verbal.cr-evaluate")).toBe("verbal.cr-evaluate")
  })

  test("catch other wordings of boldface and of passage questions about new facts", () => {
    expect(cr("In the argument, the two bolded portions play which of the following roles?", "verbal.cr-inference"))
      .toBe("verbal.cr-structure")
    expect(cr("In the argument above, the two portions in bold-faced type play which roles?", "verbal.cr-inference"))
      .toBe("verbal.cr-structure")
    expect(settledType("rc", "Which of the following, if it were true, would most weaken the author's claim?", "verbal.rc-inference"))
      .toBe("verbal.rc-application")
    expect(settledType("rc", "Which of the following, if accurate, would most strengthen the scientists' hypothesis?", "verbal.rc-inference"))
      .toBe("verbal.rc-application")
  })

  test("read only the question when the stem has no blank line before it", () => {
    expect(settledType(
      "cr",
      "The mayor's plan, which critics say proceeds by guesswork, will fail. Which of the following most weakens the conclusion?",
      "verbal.cr-weaken"
    )).toBe("verbal.cr-weaken")
  })
})

describe("Linking passages", () => {
  const rcPage = (
    passages: ReadonlyArray<{ readonly text: string; readonly questions: ReadonlyArray<number> }>,
    items: ReadonlyArray<{ readonly number: number; readonly stem: string; readonly type: string; readonly topic?: string }>
  ): PageReading => ({
    role: "questions",
    group: "rc",
    value: {
      passages: passages.map((passage) => ({ ...passage, questions: [...passage.questions] })),
      questions: items.map((item) => ({
        number: item.number,
        stem: item.stem,
        options: choices.map((choice) => ({ ...choice, text: `${choice.text} about ${item.topic ?? "it"}` })),
        type: item.type,
        difficulty: null
      }))
    }
  } as PageReading)
  const key = (numbers: ReadonlyArray<number>) => keyPage(numbers.map((number) => [number, "C"] as const))

  test("numbering that starts again with each passage records the second passage's questions as skips", () => {
    for (const topic of ["glaciers", "bees"]) {
      const linked = linkSet({
        questions: [
          {
            page: 10,
            reading: rcPage([{ text: "Passage one about bees.", questions: [1, 2] }], [
              { number: 1, stem: "The primary purpose of the passage is to", type: "verbal.rc-main-idea", topic: "bees" },
              { number: 2, stem: "According to the passage, bees", type: "verbal.rc-detail", topic: "bees" }
            ])
          },
          {
            page: 11,
            reading: rcPage([{ text: "Passage two about glaciers.", questions: [1, 2] }], [
              // With choices worded alike or not, it is another item.
              { number: 1, stem: "The primary purpose of the passage is to", type: "verbal.rc-main-idea", topic },
              { number: 2, stem: "The author mentions moraines in order to", type: "verbal.rc-structure", topic }
            ])
          }
        ],
        answers: [key([1, 2])],
        explanations: [],
        labels: []
      })
      expect(linked.filter((item) => item.page === 11).map((item) => [item._tag, item.number])).toEqual([["Skip", 1], ["Skip", 2]])
      expect(candidates(linked).map((item) => item.passage)).toEqual(["Passage one about bees.", "Passage one about bees."])
    }
  })

  test("a question two passages on its page name is held, naming both; the nearest page's passage wins otherwise", () => {
    const linked = linkSet({
      questions: [
        {
          page: 19,
          reading: rcPage([{ text: "An earlier passage that also names eight.", questions: [8] }], [])
        },
        {
          page: 20,
          reading: rcPage([
            { text: "First passage, which the book says serves 5 to 8.", questions: [5, 6, 7, 8] },
            { text: "Second passage, serving 8 to 10.", questions: [8, 9, 10] }
          ], [
            { number: 7, stem: "The first passage suggests that bees", type: "verbal.rc-inference" },
            { number: 8, stem: "The second passage suggests that glaciers", type: "verbal.rc-inference" }
          ])
        }
      ],
      answers: [key([7, 8])],
      explanations: [],
      labels: []
    })
    const [seven, eight] = candidates(linked)
    expect(seven).toMatchObject({ passage: "First passage, which the book says serves 5 to 8.", rivalPassage: null })
    expect(candidateProblems(seven!)).toEqual([])
    expect(candidateProblems(eight!)).toEqual([{
      code: "structure",
      detail: 'Two passages on its page name it: "First passage, which the book says serves 5…" and "Second passage, serving 8 to 10.".'
    }])
  })

  test("a passage read with no text names no question", () => {
    const linked = linkSet({
      questions: [{
        page: 30,
        reading: rcPage([{ text: "  ", questions: [21, 22] }], [
          { number: 21, stem: "The author mentions the council chiefly in order to", type: "verbal.rc-structure" }
        ])
      }],
      answers: [key([21])],
      explanations: [],
      labels: []
    })
    const [only] = candidates(linked)
    expect(only?.passage).toBeNull()
    expect(candidateProblems(only!)).toEqual([{ code: "structure", detail: "The readings do not say which passage it asks about." }])
  })
})

describe("Data Sufficiency near matches", () => {
  test("leave the five fixed choices out, so different questions are not near matches", () => {
    const pairs: ReadonlyArray<readonly [string, ReadonlyArray<string>, string, ReadonlyArray<string>]> = [
      ["What is the value of x?", ["2x + 3 = 11", "x^2 = 16"], "What is the value of x?", ["x + y = 5", "x - y = 1"]],
      ["Is x > y?", ["x - y > 0", "y < 0"], "Is x > y?", ["x/y > 1", "y > 0"]]
    ]
    for (const [q1, s1, q2, s2] of pairs) {
      const near = (question: string, statements: ReadonlyArray<string>) =>
        trigrams(nearText("di.ds", dsStem(question, statements), DsOptions))
      expect(similarity(near(q1, s1), near(q2, s2))).toBeLessThan(NearMatch)
    }
    // A copy with other numbers still is one.
    const copy = similarity(
      trigrams(nearText("di.ds", dsStem("What is the value of x?", ["2x + 3 = 11", "x^2 = 16"]), DsOptions)),
      trigrams(nearText("di.ds", dsStem("What is the value of x?", ["3x + 2 = 14", "x^2 = 25"]), DsOptions))
    )
    expect(copy).toBeGreaterThanOrEqual(NearMatch)
  })
})
