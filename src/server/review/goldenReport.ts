import { GoldenMiss, GoldenReport, TagAgreementNeeded } from "../../api/Golden.ts"
import { QuestionId } from "../../api/Review.ts"

// Comparing a check of the golden set with what the Curator approved.

export interface GoldenItem {
  readonly stem: string
  readonly options: ReadonlyArray<{ readonly label: string; readonly text: string }>
  readonly key: string | null
}

export interface GoldenTags {
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
  a.primarySkill === b.primarySkill && a.secondarySkills.length === b.secondarySkills.length &&
  a.secondarySkills.every((skill) => b.secondarySkills.includes(skill))

export const goldenReport = (entries: ReadonlyArray<GoldenEntry>, finishedAt: number): GoldenReport => {
  const results = entries.map((entry) => {
    const { expected, item, tags } = entry
    const text = item !== null && item.stem === expected.stem && item.options.length === expected.options.length &&
      item.options.every((option, index) => option.text === expected.options[index]?.text)
    const parts = item !== null && item.options.map((option) => option.label).join() ===
        expected.options.map((option) => option.label).join()
    const key = item !== null && item.key === expected.key
    const agrees = tags !== null && sameTags(tags, expected)
    const detail = [
      item === null ? "Not found when its page was read again." : undefined,
      item !== null && item.stem !== expected.stem
        ? `Text: "${clip(item.stem)}", not "${clip(expected.stem)}".`
        : undefined,
      item !== null && item.stem === expected.stem && !text ? "Answer choice text differs." : undefined,
      item !== null && !parts
        ? `Choices ${item.options.map((option) => option.label).join(", ") || "none"}, not ${
          expected.options.map((option) => option.label).join(", ")
        }.`
        : undefined,
      item !== null && !key ? `Key ${item.key ?? "none"}, not ${expected.key ?? "none"}.` : undefined,
      !agrees
        ? tags === null
          ? "Tagging gave no usable reply."
          : `Tags ${[tags.primarySkill ?? "none", ...tags.secondarySkills].join(", ")}, not ${
            [expected.primarySkill ?? "none", ...expected.secondarySkills].join(", ")
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
