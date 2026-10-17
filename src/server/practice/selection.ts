import { setKey } from "../../api/bookMapRules.ts"
import { bandOf, SimilarDifficulty } from "../../api/difficulty.ts"
import type { FilterChoice, StatusFilter } from "../../api/Practice.ts"
import { sha256 } from "../access/tokens.ts"

// Which Questions a Practice Set takes, and in what order.

// A published Question as Practice Sets choose among them.
export interface PoolQuestion {
  readonly id: string
  readonly section: string
  readonly questionType: string
  readonly primarySkill: string | null
  readonly secondarySkills: ReadonlyArray<string>
  // The current Difficulty.
  readonly difficulty: number
  // Whether it joined the Mock Reserve; null until that is decided.
  readonly reserve: boolean | null
  readonly released: boolean
  // The passage it asks about, shared with the passage's other Questions.
  readonly stimulusId: string | null
}

// What a Profile has done with Questions.
export interface History {
  readonly seen: ReadonlySet<string>
  readonly bookmarked: ReadonlySet<string>
  readonly missed: ReadonlySet<string>
}

// A Mock Reserve Question stays out of Practice Sets until the Curator
// releases it or the Profile has Seen it (ADR 0008). So does one whose
// Reserve decision is still to come, as while its Book's run goes on.
export const openToPractice = (
  question: { readonly id: string; readonly reserve: boolean | null; readonly released: boolean },
  seen: ReadonlySet<string>
) => question.reserve === false || question.released || seen.has(question.id)

// An order that looks shuffled but is the same for the same salt, such as a
// Session's id.
export const hashOrder = <A extends { readonly id: string }>(items: ReadonlyArray<A>, salt: string): Array<A> =>
  items.map((item) => ({ item, at: sha256(`${salt}|${item.id}`) }))
    .toSorted((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map(({ item }) => item)

const statusFits = (status: StatusFilter, id: string, history: History) =>
  status === "unseen"
    ? !history.seen.has(id)
    : status === "missed"
    ? history.missed.has(id)
    : status === "bookmarked"
    ? history.bookmarked.has(id)
    : true

export const matchesFilters = (question: PoolQuestion, filters: FilterChoice, history: History) =>
  openToPractice(question, history.seen) &&
  (filters.section === undefined || question.section === filters.section) &&
  (filters.questionType === undefined || question.questionType === filters.questionType) &&
  (filters.skill === undefined || question.primarySkill === filters.skill ||
    question.secondarySkills.includes(filters.skill)) &&
  (filters.band === undefined || bandOf(question.difficulty) === filters.band) &&
  statusFits(filters.status, question.id, history)

export interface Picked {
  readonly questionIds: ReadonlyArray<string>
  // How many Questions matched, before the set size.
  readonly matching: number
}

// The Questions the filters match, in hash order, up to the set size. Under
// any status, unseen Questions come before Seen ones; under a Skill, those
// whose primary Skill it is come before those that have it as a secondary.
// A passage's matching Questions are taken together, in the order the Bank
// holds them, which is the order the Book prints them, at the place of the
// best of them, so a set serves them one after another; the set size may
// cut the last passage short.
export const pickByFilters = (
  pool: ReadonlyArray<PoolQuestion>,
  history: History,
  filters: FilterChoice,
  salt: string
): Picked => {
  const matching = pool.filter((question) => matchesFilters(question, filters, history))
  const rank = (question: PoolQuestion) =>
    (filters.status === "any" && history.seen.has(question.id) ? 2 : 0) +
    (filters.skill !== undefined && question.primarySkill !== filters.skill ? 1 : 0)
  const units = new Map<string, Array<PoolQuestion>>()
  for (const question of matching) {
    const key = question.stimulusId ?? question.id
    units.set(key, [...(units.get(key) ?? []), question])
  }
  const best = (members: ReadonlyArray<PoolQuestion>) => Math.min(...members.map(rank))
  const ordered = hashOrder([...units].map(([id, members]) => ({ id, members })), salt)
    .toSorted((a, b) => best(a.members) - best(b.members))
  return {
    questionIds: ordered.flatMap((unit) => unit.members).slice(0, filters.size).map((question) => question.id),
    matching: matching.length
  }
}

export interface SimilarTarget {
  readonly id: string
  readonly questionType: string
  readonly primarySkill: string | null
  readonly difficulty: number
}

// Float slack, so a gap of exactly 0.5 counts as within it.
const Slack = 1e-9

// Unseen Questions open to the Profile with the target's primary Skill and
// Question Type and a Difficulty within 0.5 of its own, nearest first. Those
// picked about one passage come together, at the place of the nearest of
// them, in the order the Bank holds them.
export const pickSimilar = (
  pool: ReadonlyArray<PoolQuestion>,
  seen: ReadonlySet<string>,
  target: SimilarTarget,
  count: number,
  salt: string
): ReadonlyArray<string> => {
  if (target.primarySkill === null) return []
  const gap = (question: PoolQuestion) => Math.abs(question.difficulty - target.difficulty)
  const near = pool.filter((question) =>
    question.id !== target.id &&
    !seen.has(question.id) &&
    openToPractice(question, seen) &&
    question.questionType === target.questionType &&
    question.primarySkill === target.primarySkill &&
    gap(question) <= SimilarDifficulty + Slack
  )
  const picked = hashOrder(near, salt).toSorted((a, b) => gap(a) - gap(b)).slice(0, count)
  const place = new Map(pool.map((question, index) => [question.id, index] as const))
  return [...Map.groupBy(picked, (question) => question.stimulusId ?? question.id).values()]
    .flatMap((members) => members.toSorted((a, b) => place.get(a.id)! - place.get(b.id)!))
    .map((question) => question.id)
}

// One of a Book's items, with its Question.
export interface BookItem {
  readonly questionId: string
  readonly set: string
  readonly number: number
  readonly page: number
  readonly status: string
  readonly reserve: boolean | null
  readonly released: boolean
}

// Why a Book's item is not in a set: its Question is in the Mock Reserve, or
// waits for that decision; or it is not in the Question Bank, being checked
// or withdrawn.
export type SkipReason = "reserve" | "undecided" | "checking" | "withdrawn"

export interface SkippedItem {
  readonly set: string
  readonly number: number
  readonly reason: SkipReason
}

// Where a set serves a Question the Book prints: its first place in range.
export interface Place {
  readonly questionId: string
  readonly set: string
  readonly number: number
}

export interface ItemRange {
  readonly set?: string | undefined
  readonly from?: number | undefined
  readonly to?: number | undefined
}

export interface BookOrder {
  readonly questionIds: ReadonlyArray<string>
  readonly places: ReadonlyArray<Place>
  readonly heldForMocks: ReadonlyArray<SkippedItem>
  readonly unavailable: ReadonlyArray<SkippedItem>
}

// A Book's items in the range, in the order it prints them: by page, and on
// a page two sets share, the set that started first, then by number. Unseen
// Mock Reserve Questions, and those whose Reserve decision is to come, are
// held for Mocks, and items not published are not in the Question Bank;
// both are skipped. A Question the Book prints twice is served at its first
// place.
export const bookOrder = (items: ReadonlyArray<BookItem>, seen: ReadonlySet<string>, range: ItemRange): BookOrder => {
  const inRange = items.filter((item) =>
    (range.set === undefined || setKey(item.set) === setKey(range.set)) &&
    (range.from === undefined || item.number >= range.from) &&
    (range.to === undefined || item.number <= range.to)
  )
  const setStarts = new Map<string, number>()
  for (const item of items) {
    const key = setKey(item.set)
    setStarts.set(key, Math.min(setStarts.get(key) ?? item.page, item.page))
  }
  const startOf = (item: BookItem) => setStarts.get(setKey(item.set)) ?? item.page
  const ordered = inRange.toSorted((a, b) => a.page - b.page || startOf(a) - startOf(b) || a.number - b.number)
  const questionIds: Array<string> = []
  const places: Array<Place> = []
  const heldForMocks: Array<SkippedItem> = []
  const unavailable: Array<SkippedItem> = []
  const taken = new Set<string>()
  for (const item of ordered) {
    const ref = { set: item.set, number: item.number }
    if (item.status !== "published") {
      unavailable.push({ ...ref, reason: item.status === "withdrawn" ? "withdrawn" : "checking" })
    } else if (!openToPractice({ id: item.questionId, reserve: item.reserve, released: item.released }, seen)) {
      heldForMocks.push({ ...ref, reason: item.reserve === null ? "undecided" : "reserve" })
    } else if (!taken.has(item.questionId)) {
      taken.add(item.questionId)
      questionIds.push(item.questionId)
      places.push({ questionId: item.questionId, ...ref })
    }
  }
  return { questionIds, places, heldForMocks, unavailable }
}
