import { PDFDocument, StandardFonts } from "pdf-lib"

// A small made-up prep book: a title page, Problem Solving questions, an
// answer key, explanations, Data Sufficiency questions, and a scanned page
// with no text layer; with verbal, Critical Reasoning and Reading
// Comprehension questions too. Built at test time, so the repo holds no
// binary.

export interface BookFixture {
  readonly bytes: Uint8Array
  readonly pageCount: number
  readonly scannedPages: ReadonlyArray<number>
}

// A 4 by 4 grey PNG, standing in for a scanned page.
export const greyPng = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAAAAACMmsGiAAAAEklEQVR4nGNoaGhgYGBgYGAAAAwQAoGq0r3+AAAAAElFTkSuQmCC"
  ),
  (char) => char.charCodeAt(0)
)

// Nine Problem Solving questions, each keyed C. The seventh is geometry, a
// Retired item; the eighth nearly repeats the first; the explanation of the
// sixth gives D, against the answer key.
const practice: ReadonlyArray<readonly [string, string]> = [
  ["If 3x + 1 = 13, what is the value of x?", "(A) 2   (B) 3   (C) 4   (D) 5   (E) 6"],
  [
    "A shirt costs $25 after a 20 percent discount. What was its price before the discount?",
    "(A) $20   (B) $30   (C) $31.25   (D) $35   (E) $45"
  ],
  ["What is the average of 4, 8 and 12?", "(A) 6   (B) 7   (C) 8   (D) 9   (E) 10"],
  ["In how many ways can 3 different books be arranged on a shelf?", "(A) 3   (B) 4   (C) 6   (D) 8   (E) 9"],
  ["If y squared is 49 and y is negative, what is y?", "(A) -49   (B) -9   (C) -7   (D) 7   (E) 49"],
  ["What is 15 percent of 80?", "(A) 8   (B) 10   (C) 12   (D) 15   (E) 18"],
  ["A right triangle has legs of 3 and 4. What is its area?", "(A) 5   (B) 5.5   (C) 6   (D) 7   (E) 12"],
  ["If 3x + 8 = 20, what is the value of x?", "(A) 2   (B) 3   (C) 4   (D) 5   (E) 6"],
  ["What is the remainder when 17 is divided by 5?", "(A) 0   (B) 1   (C) 2   (D) 3   (E) 4"]
]

// Three Critical Reasoning questions, each keyed C: a weaken question, a
// boldface question and an EXCEPT question about strengthening.
const arguments_: ReadonlyArray<ReadonlyArray<string>> = [
  [
    "Town officials say a new bus route will cut traffic downtown, because many",
    "drivers will take the bus instead of driving.",
    "Which of the following, if true, most seriously weakens the officials' argument?",
    "(A) The bus route will run only on weekdays.",
    "(B) Bus fares in the town are lower than parking fees downtown.",
    "(C) Most drivers downtown deliver goods that cannot go by bus.",
    "(D) The town has added bus routes before.",
    "(E) Some drivers have said they would try the bus."
  ],
  [
    "Sales of the phone fell last year. Yet the company's profits rose, because it",
    "cut the cost of making each phone.",
    "In the argument, the two portions in boldface play which of the following roles?",
    "(A) The first is a conclusion; the second supports it.",
    "(B) The first is evidence against the conclusion; the second is the conclusion.",
    "(C) The first seems to conflict with the conclusion; the second explains it.",
    "(D) Both are evidence for the conclusion.",
    "(E) The first is a premise; the second restates it."
  ],
  [
    "A cafe plans to open at 6 a.m., expecting to sell more coffee to commuters on",
    "their way to the station.",
    "Each of the following, if true, strengthens the cafe's plan EXCEPT:",
    "(A) Many commuters pass the cafe before 7 a.m.",
    "(B) No other cafe near the station opens before 7 a.m.",
    "(C) Most commuters already buy coffee at the station itself.",
    "(D) Commuters have asked the cafe to open earlier.",
    "(E) The cafe's coffee is cheaper than the station's."
  ]
]

// A Reading Comprehension passage and its three questions, each keyed C: the
// passage and the first question on one page, the other two on the next.
export const PassageLines: ReadonlyArray<string> = [
  "In the 1890s, the town council debated whether to build a public library.",
  "Supporters argued that a library would raise reading rates among workers.",
  "Opponents said the town could not afford the upkeep. The council met twice,",
  "and in the end a local mill owner paid for the building himself."
]
const passageQuestions: ReadonlyArray<ReadonlyArray<string>> = [
  [
    "The primary purpose of the passage is to",
    "(A) argue that libraries raise reading rates",
    "(B) criticize the town council",
    "(C) describe how a town came to have a library",
    "(D) praise the mill owner",
    "(E) compare two towns' libraries"
  ],
  [
    "According to the passage, how many times did the council meet?",
    "(A) Never",
    "(B) Once",
    "(C) Twice",
    "(D) Three times",
    "(E) Every month"
  ],
  [
    "Which of the following, if true, would most strengthen the supporters' claim?",
    "(A) The library closed after ten years.",
    "(B) The mill owner did not read.",
    "(C) Workers in towns with libraries read more than workers in towns without.",
    "(D) The council met a third time.",
    "(E) Upkeep costs fell."
  ]
]

// psPages sets how many pages of Problem Solving questions it has, three
// questions to a page, each with a page of explanations; past nine, the
// questions repeat. Questions are numbered on through the book.
export const makeBook = async (
  options: {
    readonly title?: string
    readonly edition?: string
    readonly psPages?: number
    // A key other than C for some questions, by number.
    readonly keys?: Readonly<Record<number, string>>
    // Critical Reasoning and Reading Comprehension pages at the end, each set
    // with its answer key.
    readonly verbal?: boolean
  } = {}
): Promise<BookFixture> => {
  const doc = await PDFDocument.create()
  doc.setTitle(options.title ?? "GMAT Practice Questions")
  // pdf-lib stamps the current time, which would change the file's hash.
  doc.setCreationDate(new Date(Date.UTC(2026, 0, 1)))
  doc.setModificationDate(new Date(Date.UTC(2026, 0, 1)))
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = (lines: ReadonlyArray<string>) => {
    const p = doc.addPage([612, 792])
    lines.forEach((line, i) => p.drawText(line, { x: 60, y: 720 - i * 18, size: 11, font }))
  }

  page([options.title ?? "GMAT Practice Questions", options.edition ?? "First edition", "A made-up book for tests"])
  const psPages = options.psPages ?? 3
  const questions = psPages * 3
  for (let set = 0; set < psPages; set++) {
    page([
      "Problem Solving",
      ...[1, 2, 3].flatMap((k) => {
        const n = set * 3 + k
        const [stem, choices] = practice[(n - 1) % practice.length]!
        return [`${n}. ${stem}`, choices]
      })
    ])
  }
  page(["Answer Key", ...Array.from({ length: questions }, (_, i) => `${i + 1}. ${options.keys?.[i + 1] ?? "C"}`)])
  for (let k = 1; k <= questions; k += 3) {
    page([
      "Answer Explanations",
      ...[k, k + 1, k + 2].flatMap((n) => [
        `${n}. Work it out step by step from what the question gives.`,
        `The answer is ${n === 6 ? "D" : "C"}.`
      ])
    ])
  }
  page([
    "Data Sufficiency",
    `${questions + 1}. What is the value of x?`,
    "(1) x + 2 = 5",
    "(2) x is a prime number.",
    `${questions + 2}. Is n even?`,
    "(1) n + 1 is odd.",
    "(2) 3n is even."
  ])
  const scanned = doc.addPage([612, 792])
  scanned.drawImage(await doc.embedPng(greyPng), { x: 60, y: 300, width: 480, height: 400 })
  const scannedPage = doc.getPageCount()
  page(["Data Sufficiency Answer Key", `${questions + 1}. A`, `${questions + 2}. D`])
  if (options.verbal === true) {
    const cr = questions + 3
    const numbered = (lines: ReadonlyArray<string>, n: number) => [`${n}. ${lines[0]}`, ...lines.slice(1)]
    page(["Critical Reasoning", ...arguments_.flatMap((lines, i) => numbered(lines, cr + i))])
    page(["Critical Reasoning Answer Key", ...arguments_.map((_, i) => `${cr + i}. C`)])
    const rc = cr + arguments_.length
    page([
      "Reading Comprehension",
      `Questions ${rc} to ${rc + 2} refer to the passage below.`,
      ...PassageLines,
      ...numbered(passageQuestions[0]!, rc)
    ])
    page(["Reading Comprehension", ...numbered(passageQuestions[1]!, rc + 1), ...numbered(passageQuestions[2]!, rc + 2)])
    page(["Reading Comprehension Answer Key", ...passageQuestions.map((_, i) => `${rc + i}. C`)])
  }

  const bytes = await doc.save()
  return { bytes, pageCount: doc.getPageCount(), scannedPages: [scannedPage] }
}
