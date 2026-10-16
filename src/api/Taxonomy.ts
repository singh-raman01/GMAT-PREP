import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { ProfileSession } from "./Profiles.ts"

const Entry = {
  id: Schema.String,
  name: Schema.String,
  description: Schema.String
}

export class TaxonomySkill extends Schema.Class<TaxonomySkill>("gmat-prep/api/TaxonomySkill")({
  ...Entry,
  appliesTo: Schema.Array(Schema.String)
}) {}

export class TaxonomyTopic extends Schema.Class<TaxonomyTopic>("gmat-prep/api/TaxonomyTopic")({
  id: Schema.String,
  name: Schema.String,
  skills: Schema.Array(TaxonomySkill)
}) {}

export class TaxonomyQuestionType extends Schema.Class<TaxonomyQuestionType>("gmat-prep/api/TaxonomyQuestionType")(
  Entry
) {}

export class TaxonomyTrapPattern extends Schema.Class<TaxonomyTrapPattern>("gmat-prep/api/TaxonomyTrapPattern")({
  ...Entry,
  appliesTo: Schema.Array(Schema.String)
}) {}

export class TaxonomyStrategy extends Schema.Class<TaxonomyStrategy>("gmat-prep/api/TaxonomyStrategy")({
  ...Entry,
  validWhen: Schema.String,
  appliesTo: Schema.Array(Schema.String)
}) {}

export class TaxonomySection extends Schema.Class<TaxonomySection>("gmat-prep/api/TaxonomySection")({
  id: Schema.String,
  name: Schema.String,
  questionTypes: Schema.Array(TaxonomyQuestionType),
  topics: Schema.Array(TaxonomyTopic),
  trapPatterns: Schema.Array(TaxonomyTrapPattern),
  strategies: Schema.Array(TaxonomyStrategy)
}) {}

export class TaxonomyMistakeType extends Schema.Class<TaxonomyMistakeType>("gmat-prep/api/TaxonomyMistakeType")(
  Entry
) {}

export class TaxonomyCounts extends Schema.Class<TaxonomyCounts>("gmat-prep/api/TaxonomyCounts")({
  sections: Schema.Int,
  topics: Schema.Int,
  skills: Schema.Int,
  questionTypes: Schema.Int,
  mistakeTypes: Schema.Int,
  trapPatterns: Schema.Int,
  strategies: Schema.Int
}) {}

export class TaxonomyView extends Schema.Class<TaxonomyView>("gmat-prep/api/TaxonomyView")({
  version: Schema.Int,
  counts: TaxonomyCounts,
  mistakeTypes: Schema.Array(TaxonomyMistakeType),
  sections: Schema.Array(TaxonomySection)
}) {}

export class TaxonomyApi extends HttpApiGroup.make("taxonomy")
  .add(
    HttpApiEndpoint.get("current", "/", {
      success: TaxonomyView
    })
  )
  .middleware(ProfileSession)
  .prefix("/api/taxonomy")
{}
