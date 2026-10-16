import { Clock, Context, Effect, Layer, Schema } from "effect"
import {
  TaxonomyCounts,
  TaxonomyMistakeType,
  TaxonomyQuestionType,
  TaxonomySection,
  TaxonomySkill,
  TaxonomyStrategy,
  TaxonomyTopic,
  TaxonomyTrapPattern,
  TaxonomyView
} from "../../api/Taxonomy.ts"
import { Db } from "../db/Database.ts"
import { taxonomyVersions } from "../db/schema.ts"
import taxonomyV1 from "../../../taxonomy/v1.yaml" with { type: "text" }

export class TaxonomyInvalid extends Schema.TaggedError<TaxonomyInvalid>()("TaxonomyInvalid", {
  problems: Schema.Array(Schema.String)
}) {}

const entryFields = {
  id: Schema.String,
  name: Schema.String,
  description: Schema.String
}

const TaxonomyFile = Schema.Struct({
  version: Schema.Int,
  mistake_types: Schema.Array(Schema.Struct(entryFields)),
  sections: Schema.Array(Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    question_types: Schema.Array(Schema.Struct(entryFields)),
    topics: Schema.Array(Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      skills: Schema.Array(Schema.Struct({
        ...entryFields,
        applies_to: Schema.optional(Schema.Array(Schema.String))
      }))
    })),
    trap_patterns: Schema.Array(Schema.Struct({
      ...entryFields,
      applies_to: Schema.Array(Schema.String)
    })),
    strategies: Schema.Array(Schema.Struct({
      ...entryFields,
      valid_when: Schema.String,
      applies_to: Schema.Array(Schema.String)
    }))
  }))
})
type TaxonomyFile = typeof TaxonomyFile.Type

const crossCheck = (file: TaxonomyFile): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const seen = new Set<string>()
  const claim = (id: string) => {
    if (seen.has(id)) problems.push(`duplicate id ${id}`)
    seen.add(id)
  }
  const questionTypes = new Set(file.sections.flatMap((section) => section.question_types.map((qt) => qt.id)))
  const checkAppliesTo = (owner: string, appliesTo: ReadonlyArray<string>) => {
    for (const id of appliesTo) {
      if (!questionTypes.has(id)) problems.push(`${owner} applies to unknown Question Type ${id}`)
    }
  }
  const checkPrefix = (id: string, prefix: string) => {
    if (!id.startsWith(prefix)) problems.push(`${id} should start with ${prefix}`)
  }

  file.mistake_types.forEach((mistakeType) => claim(mistakeType.id))
  for (const section of file.sections) {
    claim(section.id)
    for (const questionType of section.question_types) {
      claim(questionType.id)
      checkPrefix(questionType.id, `${section.id}.`)
    }
    for (const topic of section.topics) {
      claim(topic.id)
      checkPrefix(topic.id, `${section.id}.`)
      for (const skill of topic.skills) {
        claim(skill.id)
        checkPrefix(skill.id, `${topic.id}.`)
        checkAppliesTo(skill.id, skill.applies_to ?? [])
      }
    }
    for (const trap of section.trap_patterns) {
      claim(trap.id)
      checkPrefix(trap.id, `${section.id}.trap.`)
      checkAppliesTo(trap.id, trap.applies_to)
    }
    for (const strategy of section.strategies) {
      claim(strategy.id)
      checkPrefix(strategy.id, `${section.id}.strategy.`)
      checkAppliesTo(strategy.id, strategy.applies_to)
    }
  }
  return problems
}

const toView = (file: TaxonomyFile): TaxonomyView => {
  const sections = file.sections.map((section) =>
    new TaxonomySection({
      id: section.id,
      name: section.name,
      questionTypes: section.question_types.map((qt) => new TaxonomyQuestionType(qt)),
      topics: section.topics.map((topic) =>
        new TaxonomyTopic({
          id: topic.id,
          name: topic.name,
          skills: topic.skills.map((skill) =>
            new TaxonomySkill({
              id: skill.id,
              name: skill.name,
              description: skill.description,
              appliesTo: skill.applies_to ?? []
            })
          )
        })
      ),
      trapPatterns: section.trap_patterns.map((trap) =>
        new TaxonomyTrapPattern({
          id: trap.id,
          name: trap.name,
          description: trap.description,
          appliesTo: trap.applies_to
        })
      ),
      strategies: section.strategies.map((strategy) =>
        new TaxonomyStrategy({
          id: strategy.id,
          name: strategy.name,
          description: strategy.description,
          validWhen: strategy.valid_when,
          appliesTo: strategy.applies_to
        })
      )
    })
  )
  const counts = new TaxonomyCounts({
    sections: sections.length,
    topics: sections.reduce((n, s) => n + s.topics.length, 0),
    skills: sections.reduce((n, s) => n + s.topics.reduce((m, t) => m + t.skills.length, 0), 0),
    questionTypes: sections.reduce((n, s) => n + s.questionTypes.length, 0),
    mistakeTypes: file.mistake_types.length,
    trapPatterns: sections.reduce((n, s) => n + s.trapPatterns.length, 0),
    strategies: sections.reduce((n, s) => n + s.strategies.length, 0)
  })
  return new TaxonomyView({
    version: file.version,
    counts,
    mistakeTypes: file.mistake_types.map((mistakeType) => new TaxonomyMistakeType(mistakeType)),
    sections
  })
}

// Parses and validates a Taxonomy file. Pure apart from parsing.
export const parseTaxonomy = Effect.fn("parseTaxonomy")(function*(raw: string) {
  const parsed = yield* Effect.try({
    try: () => Bun.YAML.parse(raw) as unknown,
    catch: (error) => new TaxonomyInvalid({ problems: [`not valid YAML: ${String(error)}`] })
  })
  const file = yield* Schema.decodeUnknownEffect(TaxonomyFile)(parsed).pipe(
    Effect.mapError((error) => new TaxonomyInvalid({ problems: [error.message] }))
  )
  const problems = crossCheck(file)
  if (problems.length > 0) {
    return yield* new TaxonomyInvalid({ problems })
  }
  return toView(file)
})

export class Taxonomy extends Context.Service<Taxonomy, {
  readonly view: TaxonomyView
  readonly fileHash: string
}>()("gmat-prep/server/Taxonomy") {
  static readonly layer = Layer.effect(
    Taxonomy,
    Effect.gen(function*() {
      const db = yield* Db
      const view = yield* parseTaxonomy(taxonomyV1)
      const fileHash = new Bun.CryptoHasher("sha256").update(taxonomyV1).digest("hex")
      const loadedAt = yield* Clock.currentTimeMillis
      yield* db.insert(taxonomyVersions)
        .values({ version: view.version, fileHash, loadedAt })
        .onConflictDoNothing()
        .pipe(Effect.orDie)
      return Taxonomy.of({ view, fileHash })
    })
  )
}
