import { Effect, type Schema } from "effect"
import type { DifficultyBand } from "../../api/difficulty.ts"
import type { TaxonomyView } from "../../api/Taxonomy.ts"
import { skillsFor } from "../../api/taxonomyRules.ts"
import type { StimulusDraft } from "../books/linking.ts"
import { LlmAdapter, type LlmError, type LlmReply } from "../llm/LlmAdapter.ts"
import { quoteData } from "../llm/quoting.ts"
import { draftText } from "../stimuli/stimulusText.ts"
import { buildItem, type DraftItem, type DraftQuestion, type SecondReading } from "./items.ts"
import {
  ColumnsTranslation,
  GeneratePromptVersions,
  type GeneratedType,
  GeneratorOutputs,
  generatorSystem,
  StatementTranslation,
  TranslateColumnsPromptVersion,
  TranslatePromptVersion,
  translateColumnsSystem,
  translateSystem
} from "./prompts.ts"

// The generator's and the second pass's calls for one item of a batch.

export interface BatchSpec {
  readonly questionType: GeneratedType
  readonly skill: string
  readonly band: DifficultyBand
  readonly count: number
}

const BandWords: Readonly<Record<DifficultyBand, string>> = {
  easy: "easy: most test takers answer it right, in one or two direct steps",
  medium: "medium: a typical test taker answers it right about half the time",
  hard: "hard: few test takers answer it right; it takes several steps, a subtle condition or careful reading"
}

const describeSpec = (taxonomy: TaxonomyView, spec: BatchSpec, item: number, earlier: ReadonlyArray<string>) => {
  const type = taxonomy.sections.flatMap((section) => section.questionTypes).find((each) => each.id === spec.questionType)
  const skill = skillsFor(taxonomy, spec.questionType).find((each) => each.id === spec.skill)
  return [
    "The batch asks for:",
    `- Question Type: ${type?.name ?? spec.questionType}. ${type?.description ?? ""}`,
    `- Skill to test: ${skill?.name ?? spec.skill}. ${skill?.description ?? ""}`,
    `- Difficulty: ${BandWords[spec.band]}.`,
    "",
    spec.questionType === "di.msr" ? `This is set ${item} of ${spec.count}.` : `This is question ${item} of ${spec.count}.`,
    ...(earlier.length === 0
      ? []
      : ["Earlier items in the batch were about these topics; choose another:", ...earlier.map((topic) => `- ${topic}`)])
  ].join("\n")
}

const fixNote = (problems: ReadonlyArray<string>) =>
  `Your last reply broke these rules:\n${problems.map((problem) => `- ${problem}`).join("\n")}\nWrite the whole item again, fixing them.`

export interface Generated {
  readonly item: DraftItem
  readonly model: string
  readonly promptVersion: string
}

// One item, written once more when it breaks a rule. An item still broken,
// or a reply the model could not get into shape, is a failed item.
export const generateItem = (
  jobId: string,
  taxonomy: TaxonomyView,
  spec: BatchSpec,
  item: number,
  earlier: ReadonlyArray<string>
): Effect.Effect<Generated | { readonly failed: ReadonlyArray<string> }, Exclude<LlmError, { readonly _tag: "LlmInvalidReply" }>, LlmAdapter> =>
  Effect.gen(function*() {
    const llm = yield* LlmAdapter
    const ask = (note: string | null) =>
      llm.call({
        task: "generation",
        promptVersion: GeneratePromptVersions[spec.questionType],
        system: generatorSystem[spec.questionType],
        user: [describeSpec(taxonomy, spec, item, earlier), ...(note === null ? [] : ["", note])].join("\n"),
        output: GeneratorOutputs[spec.questionType] as Schema.Codec<unknown, unknown>,
        jobId
      }).pipe(
        Effect.map((reply) => ({ reply, built: buildItem(spec.questionType, reply.value) })),
        Effect.catchTag("LlmInvalidReply", (error) => Effect.succeed({ invalid: error.problem }))
      )
    const first = yield* ask(null)
    if ("invalid" in first) return { failed: [first.invalid] }
    if ("item" in first.built) return { item: first.built.item, model: first.reply.model, promptVersion: first.reply.promptVersion }
    const second = yield* ask(fixNote(first.built.problems))
    if ("invalid" in second) return { failed: [second.invalid] }
    if ("item" in second.built) {
      return { item: second.built.item, model: second.reply.model, promptVersion: second.reply.promptVersion }
    }
    return { failed: second.built.problems }
  })

// The material a second reading needs, written out as the generator wrote it.
const material = (stimulus: StimulusDraft) => {
  const shown = draftText(stimulus)
  return `${shown.label}:\n${shown.text}`
}

const optionsText = (options: ReadonlyArray<{ readonly label: string; readonly text: string }>) =>
  options.map((option) => `(${option.label}) ${option.text}`).join("\n")

export interface SecondReadings {
  // For each Question, each Part's second reading, null when the reply was
  // unusable; for a Two-Part Analysis, both columns'.
  readonly predicates: ReadonlyArray<ReadonlyArray<SecondReading | null>>
  readonly model: string
  readonly promptVersion: string
}

// The second, independent reading of every computed Part's words. It sees the
// material and the words, never the generator's predicates, its approximate
// flag or the tab it chose.
export const readAgain = (jobId: string, item: DraftItem): Effect.Effect<SecondReadings, Exclude<LlmError, { readonly _tag: "LlmInvalidReply" }>, LlmAdapter> =>
  Effect.gen(function*() {
    const llm = yield* LlmAdapter
    let model = ""
    let promptVersion = TranslatePromptVersion
    const readPart = (question: DraftQuestion, index: number) =>
      Effect.gen(function*() {
        const part = question.parts[index]!
        if (part.statement.kind !== "computed") return null
        const body = [
          material(item.stimulus),
          "",
          `The question: ${question.stem}`,
          "",
          ...(part.kind === "dropdown"
            ? [`The sentence to complete: ${part.prompt}`, "Its options:", optionsText(part.options)]
            : [`The statement to judge: ${part.prompt}`])
        ].join("\n")
        return yield* llm.call({
          task: "statement-translation",
          promptVersion: TranslatePromptVersion,
          system: translateSystem,
          user: quoteData("question", body),
          output: StatementTranslation,
          jobId
        }).pipe(
          Effect.map((reply): LlmReply<typeof StatementTranslation.Type> | null => reply),
          Effect.catchTag("LlmInvalidReply", () => Effect.succeed(null))
        )
      })
    const predicates: Array<ReadonlyArray<SecondReading | null>> = []
    for (const question of item.questions) {
      if (question.parts.every((part) => part.kind === "column-choice")) {
        const body = [
          material(item.stimulus),
          "",
          `The problem: ${question.stem}`,
          ...question.parts.map((part, index) => `Column ${index + 1}: ${part.prompt}`),
          "Options shared by both columns:",
          optionsText(question.parts[0]?.options ?? [])
        ].join("\n")
        const reply = yield* llm.call({
          task: "statement-translation",
          promptVersion: TranslateColumnsPromptVersion,
          system: translateColumnsSystem,
          user: quoteData("question", body),
          output: ColumnsTranslation,
          jobId
        }).pipe(
          Effect.map((reply) => {
            model = reply.model
            promptVersion = reply.promptVersion
            return reply.value.columns.length === 2
              ? reply.value.columns.map((predicate): SecondReading => ({ predicate, approximate: false, dataset: null }))
              : [null, null]
          }),
          Effect.catchTag("LlmInvalidReply", () => Effect.succeed([null, null]))
        )
        predicates.push(reply)
        continue
      }
      const seconds: Array<SecondReading | null> = []
      for (const index of question.parts.keys()) {
        const reply = yield* readPart(question, index)
        if (reply === null) {
          seconds.push(null)
          continue
        }
        model = reply.model
        promptVersion = reply.promptVersion
        seconds.push({
          predicate: reply.value.predicate,
          approximate: reply.value.approximate,
          dataset: item.stimulus.kind === "tabs" && reply.value.tab !== null ? reply.value.tab - 1 : null
        })
      }
      predicates.push(seconds)
    }
    return { predicates, model, promptVersion }
  })
