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
  readonly reserve: boolean
  readonly released: boolean
}

// What a Profile has done with Questions.
export interface History {
  readonly seen: ReadonlySet<string>
  readonly bookmarked: ReadonlySet<string>
  readonly missed: ReadonlySet<string>
}

// A Mock Reserve Question stays out of Practice Sets until the Curator
// releases it or the Profile has Seen it (ADR 0008).
export const openToPractice = (
  question: { readonly id: string; readonly reserve: boolean; readonly released: boolean },
  seen: ReadonlySet<string>
) => !question.reserve || question.released || seen.has(question.id)

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
  const ordered = hashOrder(matching, salt).toSorted((a, b) => rank(a) - rank(b))
  return { questionIds: ordered.slice(0, filters.size).map((question) => question.id), matching: matching.length }
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
// Question Type and a Difficulty within 0.5 of its own, nearest first.
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
  return hashOrder(near, salt).toSorted((a, b) => gap(a) - gap(b)).slice(0, count).map((question) => question.id)
}

// One of a Book's items, with its Question.
export interface BookItem {
  readonly questionId: string
  readonly set: string
  readonly number: number
  readonly page: number
  readonly status: string
  readonly reserve: boolean
  readonly released: boolean
}

export interface ItemRange {
  readonly set?: string | undefined
  readonly from?: number | undefined
  readonly to?: number | undefined
}

export interface BookOrder {
  readonly questionIds: ReadonlyArray<string>
  readonly heldForMocks: ReadonlyArray<{ readonly set: string; readonly number: number }>
  readonly unavailable: ReadonlyArray<{ readonly set: string; readonly number: number }>
}

// A Book's items in the range, in the order it prints them. Unseen Mock
// Reserve Questions are held for Mocks, and items not published are not in
// the Question Bank; both are skipped. A Question the Book prints twice is
// served at its first place.
export const bookOrder = (items: ReadonlyArray<BookItem>, seen: ReadonlySet<string>, range: ItemRange): BookOrder => {
  const inRange = items
    .filter((item) =>
      (range.set === undefined || setKey(item.set) === setKey(range.set)) &&
      (range.from === undefined || item.number >= range.from) &&
      (range.to === undefined || item.number <= range.to)
    )
    .toSorted((a, b) => a.page - b.page || a.number - b.number)
  const questionIds: Array<string> = []
  const heldForMocks: Array<{ set: string; number: number }> = []
  const unavailable: Array<{ set: string; number: number }> = []
  const taken = new Set<string>()
  for (const item of inRange) {
    const ref = { set: item.set, number: item.number }
    if (item.status !== "published") unavailable.push(ref)
    else if (!openToPractice({ id: item.questionId, reserve: item.reserve, released: item.released }, seen)) {
      heldForMocks.push(ref)
    } else if (!taken.has(item.questionId)) {
      taken.add(item.questionId)
      questionIds.push(item.questionId)
    }
  }
  return { questionIds, heldForMocks, unavailable }
}
