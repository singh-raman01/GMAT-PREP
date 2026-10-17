import { PDFDocument, StandardFonts } from "pdf-lib"

// A made-up Reading Comprehension book in the layout the fake book model
// reads (test/fakeBookModel.ts): each passage on a page of its own with the
// questions about it, then an answer key keyed C throughout.

export interface RcPassage {
  readonly lines: ReadonlyArray<string>
  readonly questions: ReadonlyArray<{ readonly stem: string; readonly options: ReadonlyArray<string> }>
}

export const rcBook = async (title: string, passages: ReadonlyArray<RcPassage>) => {
  const doc = await PDFDocument.create()
  doc.setTitle(title)
  doc.setCreationDate(new Date(Date.UTC(2026, 0, 1)))
  doc.setModificationDate(new Date(Date.UTC(2026, 0, 1)))
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = (lines: ReadonlyArray<string>) => {
    const added = doc.addPage([612, 792])
    lines.forEach((line, i) => added.drawText(line, { x: 40, y: 760 - i * 16, size: 9, font }))
  }
  page([title, "A made-up verbal book"])
  let number = 1
  const numbers: Array<number> = []
  for (const passage of passages) {
    const first = number
    const last = number + passage.questions.length - 1
    const lines = ["Reading Comprehension", `Questions ${first} to ${last} refer to the passage below.`, ...passage.lines]
    for (const question of passage.questions) {
      lines.push(`${number}. ${question.stem}`)
      question.options.forEach((option, i) => lines.push(`(${"ABCDE"[i]}) ${option}`))
      numbers.push(number)
      number += 1
    }
    page(lines)
  }
  page(["Reading Comprehension Answer Key", ...numbers.map((n) => `${n}. C`)])
  return { bytes: await doc.save(), pageCount: doc.getPageCount() }
}

const topics = ["bees", "glaciers", "railways", "printing"] as const

// Each topic's passage, in four lines, unlike the others.
const passageLines: Record<(typeof topics)[number], ReadonlyArray<string>> = {
  bees: [
    "Historians of beekeeping long held that the change came quickly, within one decade of the first reports.",
    "Recent archival work suggests a slower shift, driven by local councils rather than by trade.",
    "The new account explains why early hive records are so uneven from one district to the next.",
    "Yet it leaves open why the councils acted at all, a question the archives rarely address."
  ],
  glaciers: [
    "Measurements taken at the foot of the Rhone glacier show it retreating faster after 1990.",
    "Some geologists credit warmer summers; others point to thinner winter snowpack at altitude.",
    "A survey of meltwater channels found sediment patterns that fit the snowpack account better.",
    "Still, the survey covered only one valley, and its authors warn against reading too much into it."
  ],
  railways: [
    "When the first branch lines opened, small market towns expected trade to flow toward them.",
    "Instead, ledgers from the period show merchants moving their stock to the larger junctions.",
    "Freight rates, which favored long hauls, made it cheaper to ship goods through a regional hub.",
    "Only towns that won a station on a main line kept the markets that had once defined them."
  ],
  printing: [
    "Movable type is often said to have spread across Europe by way of the great trading fairs.",
    "Guild registers tell a quieter story of journeymen carrying their craft from shop to shop.",
    "Where a skilled printer settled, a press often followed within a few years, fairs or no fairs.",
    "The registers rarely record failures, though, so the pattern may flatter the journeymen."
  ]
}

// Four passages of three questions each, every one different; a change
// rewrites words in one passage, as another edition or a rescan might.
export const fourPassages = (change?: { readonly passage: number; readonly from: string; readonly to: string }) =>
  topics.map((topic, k): RcPassage => ({
    lines: passageLines[topic].map((line) =>
      change !== undefined && change.passage === k ? line.replace(change.from, change.to) : line
    ),
    questions: [
      {
        stem: `The primary purpose of the passage about ${topic} is to`,
        options: [
          `defend the older view of ${topic}`,
          `list the records about ${topic}`,
          `describe a revised account of ${topic}`,
          `praise those who studied ${topic}`,
          `predict the future of ${topic}`
        ]
      },
      {
        stem: `According to the passage, the evidence about ${topic} suggests that`,
        options: [
          `${topic} changed suddenly`,
          `trade explains ${topic}`,
          `the usual account of ${topic} is incomplete`,
          `nothing was recorded about ${topic}`,
          `${topic} were studied too much`
        ]
      },
      {
        stem: `The author would most likely agree that the sources on ${topic} are`,
        options: ["complete", "forged", "limited in what they show", "lost", "identical everywhere"]
      }
    ]
  }))

// A fourth question about each passage, as a later edition might add.
export const withExtraQuestion = (passages: ReadonlyArray<RcPassage>): Array<RcPassage> =>
  passages.map((passage, k) => ({
    ...passage,
    questions: [
      ...passage.questions,
      {
        stem: `In the passage, the question left open about ${topics[k]} concerns`,
        options: ["the archives", "the decade", "why the councils acted", "the trade routes", "the first reports"]
      }
    ]
  }))
