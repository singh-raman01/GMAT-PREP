import type {
  TaxonomyMistakeType,
  TaxonomySkill,
  TaxonomyStrategy,
  TaxonomyTrapPattern,
  TaxonomyView
} from "./Taxonomy.ts"

// Which tags a Question of a given Question Type may carry (ADR 0007).
// Skills describe what a Question exercises, whichever Section serves it: a
// DS Question takes Quant Skills, and the other Data Insights types take
// Quant or Verbal Skills. A tag that names its Question Types in applies_to
// fits only those.

// The Section a Question Type, Skill or other id belongs to, from its prefix.
export const sectionOf = (id: string) => id.slice(0, id.indexOf("."))

// Sections whose Skills a Question Type borrows besides its own.
const Borrowed: Readonly<Record<string, ReadonlyArray<string>>> = {
  "di.ds": ["quant"],
  "di.msr": ["quant", "verbal"],
  "di.ta": ["quant", "verbal"],
  "di.gi": ["quant", "verbal"],
  "di.tpa": ["quant", "verbal"]
}

const fits = (appliesTo: ReadonlyArray<string>, ownerSection: string, questionType: string) =>
  appliesTo.length > 0
    ? appliesTo.includes(questionType)
    : ownerSection === sectionOf(questionType) || (Borrowed[questionType] ?? []).includes(ownerSection)

export const skillsFor = (taxonomy: TaxonomyView, questionType: string): ReadonlyArray<TaxonomySkill> =>
  taxonomy.sections.flatMap((section) =>
    section.topics.flatMap((topic) => topic.skills.filter((skill) => fits(skill.appliesTo, section.id, questionType)))
  )

export const strategiesFor = (taxonomy: TaxonomyView, questionType: string): ReadonlyArray<TaxonomyStrategy> =>
  taxonomy.sections.flatMap((section) => section.strategies.filter((strategy) => strategy.appliesTo.includes(questionType)))

export const trapPatternsFor = (taxonomy: TaxonomyView, questionType: string): ReadonlyArray<TaxonomyTrapPattern> =>
  taxonomy.sections.flatMap((section) => section.trapPatterns.filter((trap) => trap.appliesTo.includes(questionType)))

// Time pressure comes only from timing, never from an option.
export const TimePressure = "time-pressure"

export const optionMistakeTypes = (taxonomy: TaxonomyView): ReadonlyArray<TaxonomyMistakeType> =>
  taxonomy.mistakeTypes.filter((mistakeType) => mistakeType.id !== TimePressure)

// A Data Sufficiency Question's Skills are its maths, from Quantitative
// Reasoning, and one secondary Skill from this Topic for whether it asks for
// a value or for a yes or no.
export const SufficiencyTopic = "di.sufficiency"
const isSufficiency = (skill: string) => skill.startsWith(`${SufficiencyTopic}.`)

// Whether the tag rules let a Skill be the primary Skill of a Question of
// this type: a DS Question's primary Skill is the maths it tests, a Quant
// Skill, so never a sufficiency Skill (decision 19).
export const mayBePrimary = (questionType: string, skill: string) =>
  questionType !== "di.ds" || (!isSufficiency(skill) && sectionOf(skill) === "quant")

// The Skills no Question can have as its primary Skill, as every Question
// Type they fit refuses them that role: in version 1, the two sufficiency
// Skills, which fit DS alone. Questions carry them as secondary Skills.
export const secondaryOnlySkills = (taxonomy: TaxonomyView): ReadonlySet<string> => {
  const primary = new Set(
    taxonomy.sections.flatMap((section) => section.questionTypes).flatMap((type) =>
      skillsFor(taxonomy, type.id).filter((skill) => mayBePrimary(type.id, skill.id)).map((skill) => skill.id)
    )
  )
  return new Set(
    taxonomy.sections.flatMap((section) => section.topics.flatMap((topic) => topic.skills))
      .map((skill) => skill.id)
      .filter((id) => !primary.has(id))
  )
}

export interface QuestionTags {
  readonly questionType: string
  readonly primarySkill: string | null
  readonly secondarySkills: ReadonlyArray<string>
  readonly strategies: ReadonlyArray<string>
  readonly options: ReadonlyArray<{ readonly mistakeType: string; readonly trapPattern: string | null }>
}

// Every tag that is outside the Taxonomy or does not fit the Question Type.
export const tagProblems = (taxonomy: TaxonomyView, tags: QuestionTags): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const known = (ids: ReadonlyArray<{ readonly id: string }>) => new Set(ids.map((entry) => entry.id))
  const questionTypes = known(taxonomy.sections.flatMap((section) => section.questionTypes))
  if (!questionTypes.has(tags.questionType)) {
    problems.push(`The Question Type ${tags.questionType} is not in the Taxonomy.`)
    return problems
  }
  const skills = known(skillsFor(taxonomy, tags.questionType))
  const allSkills = known(taxonomy.sections.flatMap((section) => section.topics.flatMap((topic) => topic.skills)))
  const checkSkill = (skill: string, role: string) => {
    if (!allSkills.has(skill)) problems.push(`The ${role} Skill ${skill} is not in the Taxonomy.`)
    else if (!skills.has(skill)) problems.push(`The ${role} Skill ${skill} does not fit ${tags.questionType}.`)
  }
  if (tags.primarySkill === null) problems.push("It has no primary Skill.")
  else checkSkill(tags.primarySkill, "primary")
  if (tags.secondarySkills.length > 2) problems.push("It has more than two secondary Skills.")
  for (const skill of tags.secondarySkills) checkSkill(skill, "secondary")
  if (tags.primarySkill !== null && tags.secondarySkills.includes(tags.primarySkill)) {
    problems.push("Its primary Skill is also a secondary one.")
  }
  if (tags.primarySkill !== null && !mayBePrimary(tags.questionType, tags.primarySkill)) {
    if (isSufficiency(tags.primarySkill)) problems.push("Its primary Skill is a sufficiency Skill, not its maths.")
    else if (allSkills.has(tags.primarySkill)) problems.push("Its primary Skill should be the maths it tests, a Quant Skill.")
  }
  if (
    tags.questionType === "di.ds" && tags.primarySkill !== null && !isSufficiency(tags.primarySkill) &&
    tags.secondarySkills.filter(isSufficiency).length !== 1
  ) {
    problems.push("It needs exactly one sufficiency Skill among its secondary Skills.")
  }
  const strategies = known(strategiesFor(taxonomy, tags.questionType))
  for (const strategy of tags.strategies) {
    if (!strategies.has(strategy)) problems.push(`The Strategy ${strategy} does not fit ${tags.questionType}.`)
  }
  const mistakeTypes = known(optionMistakeTypes(taxonomy))
  const trapPatterns = known(trapPatternsFor(taxonomy, tags.questionType))
  for (const option of tags.options) {
    if (option.mistakeType === TimePressure) problems.push("An option is tagged Time pressure, which only timing gives.")
    else if (!mistakeTypes.has(option.mistakeType)) problems.push(`The Mistake Type ${option.mistakeType} is not in the Taxonomy.`)
    if (option.trapPattern !== null && !trapPatterns.has(option.trapPattern)) {
      problems.push(`The Trap Pattern ${option.trapPattern} does not fit ${tags.questionType}.`)
    }
  }
  return problems
}
