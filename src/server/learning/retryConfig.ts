import { Schema } from "effect"

// A retry set is a Practice Set whose config lists, for each Question it
// serves, the Error Log entry and Retry Ladder step it is for. The entry is
// known by its Question; step 1 serves that Question, steps 2 and 3 a
// Sibling.

export const RetryStep = Schema.Literals([1, 2, 3])
export type RetryStep = typeof RetryStep.Type

export const RetryItem = Schema.Struct({
  entry: Schema.String,
  step: RetryStep,
  questionId: Schema.String
})
export type RetryItem = typeof RetryItem.Type

// Read from any Practice Set's config: only the retry list matters here.
const RetryList = Schema.Struct({ retry: Schema.optional(Schema.Array(RetryItem)) })
const decodeRetryList = Schema.decodeUnknownSync(Schema.fromJsonString(RetryList))

export const retryItemsOf = (config: string): ReadonlyArray<RetryItem> => decodeRetryList(config).retry ?? []

// The retry list as SQLite's json_extract gives it: the array's JSON, or null
// for a set with none.
const decodeRetryItems = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(RetryItem)))
export const retryListOf = (json: string | null): ReadonlyArray<RetryItem> => (json === null ? [] : decodeRetryItems(json))
