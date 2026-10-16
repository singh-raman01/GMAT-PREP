import { SecondaryWeight } from "./abilities.ts"

// Exam frequency (docs/design.md, "Learning loop"): how much of the exam a
// Skill or Question Type is, as its share of the published Questions from
// Books marked official, a secondary Skill counting half; until an official
// Book's Questions are published, the whole published Question Bank stands
// in.

export interface BankQuestion {
  // Whether it has a Source in a Book marked official.
  readonly official: boolean
  readonly questionType: string
  readonly primarySkill: string | null
  readonly secondarySkills: ReadonlyArray<string>
}

export interface Frequencies {
  readonly basis: "official" | "bank"
  readonly skills: ReadonlyMap<string, number>
  readonly questionTypes: ReadonlyMap<string, number>
}

export const frequenciesOf = (questions: ReadonlyArray<BankQuestion>): Frequencies => {
  const official = questions.filter((question) => question.official)
  const basis = official.length > 0 ? "official" : "bank"
  const counted = basis === "official" ? official : questions
  const skills = new Map<string, number>()
  const questionTypes = new Map<string, number>()
  const add = (map: Map<string, number>, id: string, weight: number) => map.set(id, (map.get(id) ?? 0) + weight)
  for (const question of counted) {
    add(questionTypes, question.questionType, 1)
    if (question.primarySkill !== null) add(skills, question.primarySkill, 1)
    for (const skill of new Set(question.secondarySkills)) {
      if (skill !== question.primarySkill) add(skills, skill, SecondaryWeight)
    }
  }
  const share = (map: Map<string, number>) =>
    new Map([...map].map(([id, weight]) => [id, counted.length === 0 ? 0 : weight / counted.length] as const))
  return { basis, skills: share(skills), questionTypes: share(questionTypes) }
}
