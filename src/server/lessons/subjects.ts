import type { TaxonomyStrategy, TaxonomyTrapPattern, TaxonomyView } from "../../api/Taxonomy.ts"
import { skillsFor, strategiesFor, trapPatternsFor } from "../../api/taxonomyRules.ts"

// What Lessons are written about (docs/design.md, decision 93): every Skill
// and every Question Type in the Taxonomy, 73 subjects in version 1.

export type SubjectKind = "skill" | "questionType"

export interface LessonSubject {
  readonly kind: SubjectKind
  readonly id: string
  readonly name: string
  readonly description: string
  readonly section: { readonly id: string; readonly name: string }
  // A Skill's Topic; none for a Question Type.
  readonly topic: { readonly id: string; readonly name: string } | null
  // The Question Types it is asked in: a Question Type's own, or each that
  // takes the Skill.
  readonly questionTypes: ReadonlyArray<string>
}

export const lessonSubjects = (taxonomy: TaxonomyView): ReadonlyArray<LessonSubject> => {
  const allTypes = taxonomy.sections.flatMap((section) => section.questionTypes.map((type) => type.id))
  return taxonomy.sections.flatMap((section) => [
    ...section.topics.flatMap((topic) =>
      topic.skills.map((skill): LessonSubject => ({
        kind: "skill",
        id: skill.id,
        name: skill.name,
        description: skill.description,
        section: { id: section.id, name: section.name },
        topic: { id: topic.id, name: topic.name },
        questionTypes: allTypes.filter((type) => skillsFor(taxonomy, type).some((each) => each.id === skill.id))
      }))
    ),
    ...section.questionTypes.map((type): LessonSubject => ({
      kind: "questionType",
      id: type.id,
      name: type.name,
      description: type.description,
      section: { id: section.id, name: section.name },
      topic: null,
      questionTypes: [type.id]
    }))
  ])
}

// What a Lesson was written from: when this changes, the Lesson is marked
// for rewriting (decision 97).
export const basisOf = (subject: LessonSubject) =>
  JSON.stringify({
    name: subject.name,
    description: subject.description,
    section: subject.section.id,
    topic: subject.topic?.id ?? null
  })

const uniqueById = <A extends { readonly id: string }>(entries: ReadonlyArray<A>) => [
  ...new Map(entries.map((entry) => [entry.id, entry] as const)).values()
]

// The Strategies and Trap Patterns of the Question Types it is asked in.
export const strategiesOf = (taxonomy: TaxonomyView, subject: LessonSubject): ReadonlyArray<TaxonomyStrategy> =>
  uniqueById(subject.questionTypes.flatMap((type) => strategiesFor(taxonomy, type)))

export const trapPatternsOf = (taxonomy: TaxonomyView, subject: LessonSubject): ReadonlyArray<TaxonomyTrapPattern> =>
  uniqueById(subject.questionTypes.flatMap((type) => trapPatternsFor(taxonomy, type)))
