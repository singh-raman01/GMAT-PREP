import { Schema } from "effect"
import { renderProblem } from "../../api/richText.ts"

// A Lesson's content (docs/design.md, decision 94): the rules, the methods
// with when each is valid, the common traps, and a walkthrough of each
// worked example. Text is Markdown with math between \( \) or \[ \], as in
// Questions.

export const LessonPromptVersion = "write-lesson@1"

export const RulesAtMost = 8
export const MethodsAtMost = 5
export const TrapsAtMost = 6
const TitleLimit = 100
const TextLimit = 1800

export interface LessonContent {
  readonly rules: ReadonlyArray<{ readonly title: string; readonly text: string }>
  readonly methods: ReadonlyArray<{
    readonly name: string
    // A Strategy id from the Taxonomy, where one fits.
    readonly strategy: string | null
    readonly whenValid: string
    readonly steps: string
  }>
  readonly traps: ReadonlyArray<{ readonly trapPattern: string | null; readonly text: string }>
  // One for each worked example, in the order they were given.
  readonly examples: ReadonlyArray<{ readonly example: number; readonly walkthrough: string }>
}

// Text that renders, of a sensible length.
const text = (limit: number) =>
  Schema.String.check(
    Schema.makeFilter((value: string) => {
      if (value.trim() === "") return "must not be empty"
      if (value.length > limit) return `is ${value.length} characters long; keep it to ${limit}`
      const problem = renderProblem(value)
      return problem === undefined || problem.replace("in a Question", "in a Lesson")
    })
  )

// One of the given ids, or null; with none given, only null.
const idOrNull = (ids: ReadonlyArray<string>) => {
  const [first, ...rest] = ids
  return first === undefined ? Schema.Null : Schema.NullOr(Schema.Literals([first, ...rest]))
}

// The reply for a Lesson with the given Strategies, Trap Patterns and number
// of worked examples. Checks the strict JSON schema cannot carry run when it
// is decoded, so a reply that breaks them gets the one retry.
export const lessonOutput = (
  strategies: ReadonlyArray<string>,
  trapPatterns: ReadonlyArray<string>,
  examples: number
) =>
  Schema.Struct({
    rules: Schema.Array(Schema.Struct({ title: text(TitleLimit), text: text(TextLimit) }))
      .check(Schema.isMinLength(1), Schema.isMaxLength(RulesAtMost)),
    methods: Schema.Array(Schema.Struct({
      name: text(TitleLimit),
      strategy: idOrNull(strategies),
      whenValid: text(TextLimit),
      steps: text(TextLimit)
    })).check(Schema.isMinLength(1), Schema.isMaxLength(MethodsAtMost)),
    traps: Schema.Array(Schema.Struct({ trapPattern: idOrNull(trapPatterns), text: text(TextLimit) }))
      .check(Schema.isMinLength(1), Schema.isMaxLength(TrapsAtMost)),
    examples: Schema.Array(Schema.Struct({ example: Schema.Int, walkthrough: text(TextLimit * 2) })).check(
      Schema.makeFilter((given: ReadonlyArray<{ readonly example: number }>) => {
        const numbers = given.map((each) => each.example)
        const wanted = Array.from({ length: examples }, (_, index) => index + 1)
        return (numbers.length === wanted.length && numbers.every((number, index) => number === wanted[index])) ||
          `give one walkthrough for each worked example, numbered ${wanted.join(", ")} in that order`
      })
    )
  })

const wordsIn = (value: string) => value.split(/\s+/).filter((word) => word !== "").length

// Its words, for the Study Plan's estimate at 200 a minute: the whole Lesson,
// and the methods part alone.
export const wordsOf = (content: LessonContent) => {
  const methods = content.methods.reduce((sum, each) => sum + wordsIn(`${each.name} ${each.whenValid} ${each.steps}`), 0)
  const rest = [
    ...content.rules.flatMap((each) => [each.title, each.text]),
    ...content.traps.map((each) => each.text),
    ...content.examples.map((each) => each.walkthrough)
  ].reduce((sum, each) => sum + wordsIn(each), 0)
  return { words: methods + rest, methodsWords: methods }
}
