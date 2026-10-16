import { GoldenMiss, GoldenReport, TagAgreementNeeded } from "../../api/Golden.ts"
import { QuestionId } from "../../api/Review.ts"
import { normalizeText } from "../../api/richText.ts"

// Comparing a check of the golden set with what the Curator approved.

export interface GoldenItem {
  // What it asks about, written out under its label, such as "The passage:";
  // null when it stands alone. It is compared as normalized text, since the
  // stored Stimulus may be another Book's reading of it.
  readonly stimulus: string | null
  readonly stem: string
  // Each Part's words and options.
  readonly parts: ReadonlyArray<{
    readonly prompt: string | null
    readonly options: ReadonlyArray<{ readonly label: string; readonly text: string }>
  }>
  // Each Part's key, joined; see api/keys.ts.
  readonly key: string | null
}

// The Question Type the reading gives, and the Skills tagging gives.
export interface GoldenTags {
  readonly questionType: string
  readonly primarySkill: string | null
  readonly secondarySkills: ReadonlyArray<string>
}

export interface GoldenEntry {
  readonly questionId: string
  readonly set: string
  readonly number: number
  readonly expected: GoldenItem & GoldenTags
  // What reading the page again gave for the item; null when it was not found.
  readonly item: GoldenItem | null
  // What tagging again gave; null when its reply could not be used.
  readonly tags: GoldenTags | null
}

const clip = (text: string) => (text.length > 120 ? `${text.slice(0, 119)}…` : text)

const sameTags = (a: GoldenTags, b: GoldenTags) =>
  a.questionType === b.questionType && a.primarySkill === b.primarySkill &&
  a.secondarySkills.length === b.secondarySkills.length && a.secondarySkills.every((skill) => b.secondarySkills.includes(skill))

export const goldenReport = (entries: ReadonlyArray<GoldenEntry>, finishedAt: number): GoldenReport => {
  const results = entries.map((entry) => {
    const { expected, item, tags } = entry
    const shown = (each: GoldenItem) => (each.stimulus === null ? null : normalizeText(each.stimulus))
    const sameStimulus = item !== null && shown(item) === shown(expected)
    const sameWords = item !== null && item.parts.length === expected.parts.length &&
      item.parts.every((part, index) => {
        const other = expected.parts[index]!
        return part.prompt === other.prompt && part.options.length === other.options.length &&
          part.options.every((option, at) => option.text === other.options[at]?.text)
      })
    const text = item !== null && sameStimulus && item.stem === expected.stem && sameWords
    const labels = (each: GoldenItem) => each.parts.map((part) => part.options.map((option) => option.label).join(", "))
      .join("; ")
    const parts = item !== null && labels(item) === labels(expected)
    const key = item !== null && item.key === expected.key
    const agrees = tags !== null && sameTags(tags, expected)
    const detail = [
      item === null ? "Not found when its page was read again." : undefined,
      item !== null && !sameStimulus
        ? `${(expected.stimulus ?? item.stimulus ?? "").split(":")[0]} differs.`
        : undefined,
      item !== null && item.stem !== expected.stem
        ? `Text: "${clip(item.stem)}", not "${clip(expected.stem)}".`
        : undefined,
      item !== null && !sameWords ? "Answer choice text differs." : undefined,
      item !== null && !parts ? `Choices ${labels(item) || "none"}, not ${labels(expected)}.` : undefined,
      item !== null && !key ? `Key ${item.key ?? "none"}, not ${expected.key ?? "none"}.` : undefined,
      !agrees
        ? tags === null
          ? "Tagging gave no usable reply."
          : `Tags ${[tags.questionType, tags.primarySkill ?? "none", ...tags.secondarySkills].join(", ")}, not ${
            [expected.questionType, expected.primarySkill ?? "none", ...expected.secondarySkills].join(", ")
          }.`
        : undefined
    ].filter((part) => part !== undefined).join(" ")
    return { entry, text, parts, key, agrees, detail }
  })
  const count = (keep: (result: (typeof results)[number]) => boolean) => results.filter(keep).length
  const items = results.length
  const tagAgreement = items === 0 ? 0 : count((result) => result.agrees) / items
  const textExact = count((result) => result.text)
  const partsExact = count((result) => result.parts)
  const keysExact = count((result) => result.key)
  return new GoldenReport({
    items,
    textExact,
    partsExact,
    keysExact,
    tagAgreement,
    passed: items > 0 && textExact === items && partsExact === items && keysExact === items &&
      tagAgreement >= TagAgreementNeeded,
    misses: results.filter((result) => !(result.text && result.parts && result.key && result.agrees)).map((result) =>
      new GoldenMiss({
        questionId: QuestionId.make(result.entry.questionId),
        set: result.entry.set,
        number: result.entry.number,
        text: result.text,
        parts: result.parts,
        key: result.key,
        tags: result.agrees,
        detail: result.detail
      })
    ),
    finishedAt
  })
}
