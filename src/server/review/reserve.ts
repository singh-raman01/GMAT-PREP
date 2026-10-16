import { and, eq, isNull } from "drizzle-orm"
import { Clock, Effect } from "effect"
import { fitsSlot } from "../../api/blueprint.ts"
import { type Band, bandOf } from "../../api/taxonomyRules.ts"
import { Db } from "../db/Database.ts"
import { books, questions, sources } from "../db/schema.ts"

// The Mock Reserve (ADR 0008): a quarter of each Section's Questions from
// each Book, held back for Mocks. Membership is decided per unit, so an RC
// passage's or an MSR set's Questions stay together, and only units that fit
// a Section Blueprint slot can join. Each Question Type and Difficulty Band
// gets its share, and within one the units are taken in the order of their
// text's hash, so the same Book always gives the same Reserve. A unit is
// decided once; later Questions from the Book make up any shortfall.

export interface ReserveUnit {
  readonly id: string
  readonly size: number
  readonly questionType: string
  readonly band: Band
  // Orders units within a stratum, the same way every time.
  readonly hash: string
  // Decided before: in the Reserve or not; null when undecided.
  readonly reserve: boolean | null
}

const ReserveShare = 0.25

// Shares of a total, in whole units, that add up to it: each part's exact
// share rounded down, with what is left going to the largest remainders.
const apportion = (total: number, parts: ReadonlyArray<readonly [string, number]>) => {
  const whole = parts.reduce((sum, [, size]) => sum + size, 0)
  if (whole === 0) return new Map<string, number>()
  const exact = parts.map(([key, size]) => ({ key, share: total * size / whole }))
  const quotas = new Map(exact.map(({ key, share }) => [key, Math.floor(share)] as const))
  let left = total - [...quotas.values()].reduce((sum, quota) => sum + quota, 0)
  const byRemainder = exact.toSorted((a, b) =>
    (b.share - Math.floor(b.share)) - (a.share - Math.floor(a.share)) || a.key.localeCompare(b.key)
  )
  for (const { key } of byRemainder) {
    if (left <= 0) break
    quotas.set(key, quotas.get(key)! + 1)
    left -= 1
  }
  return quotas
}

const sum = (values: Iterable<number>) => [...values].reduce((total, value) => total + value, 0)

// The undecided units of one Book's Section, each with its decision. Only
// what is left of the quarter is shared out, among the strata still short of
// their share, so units decided before never push the Reserve past it.
export const reserveDecisions = (units: ReadonlyArray<ReserveUnit>): ReadonlyMap<string, boolean> => {
  const decisions = new Map<string, boolean>()
  const fitting = units.filter((unit) => fitsSlot(unit.questionType, unit.size))
  for (const unit of units) {
    if (unit.reserve === null && !fitsSlot(unit.questionType, unit.size)) decisions.set(unit.id, false)
  }
  const stratumOf = (unit: ReserveUnit) => `${unit.questionType}|${unit.band}`
  const sizes = new Map<string, number>()
  const held = new Map<string, number>()
  for (const unit of fitting) {
    const stratum = stratumOf(unit)
    sizes.set(stratum, (sizes.get(stratum) ?? 0) + unit.size)
    if (unit.reserve === true) held.set(stratum, (held.get(stratum) ?? 0) + unit.size)
  }
  const total = Math.round(sum(sizes.values()) * ReserveShare)
  const shares = apportion(total, [...sizes.entries()])
  const short = [...shares].map(([stratum, share]) => [stratum, Math.max(0, share - (held.get(stratum) ?? 0))] as const)
    .filter(([, missing]) => missing > 0)
  const left = Math.max(0, total - sum(held.values()))
  const quotas = apportion(Math.min(left, sum(short.map(([, missing]) => missing))), short)
  for (const stratum of sizes.keys()) {
    const quota = quotas.get(stratum) ?? 0
    const open = fitting.filter((unit) => stratumOf(unit) === stratum && unit.reserve === null)
      .toSorted((a, b) => a.hash.localeCompare(b.hash))
    let added = 0
    for (const unit of open) {
      const joins = added + unit.size <= quota
      if (joins) added += unit.size
      decisions.set(unit.id, joins)
    }
  }
  return decisions
}

// Decides the Reserve for a Book's published Questions not decided yet: the
// Questions the Book itself brought, not those it only added a Source to.
// Questions have no Stimulus yet, so each is a unit of its own.
export const assignReserve = (bookId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    return yield* db.transaction(() => decideReserve(bookId))
  })

const decideReserve = (bookId: string) =>
  Effect.gen(function*() {
    const db = yield* Db
    const now = yield* Clock.currentTimeMillis
    const rows = yield* db.select({
      id: questions.id,
      section: questions.section,
      questionType: questions.questionType,
      seed: questions.difficultySeed,
      hash: questions.normalizedHash,
      reserve: questions.reserve
    }).from(questions)
      .innerJoin(sources, and(eq(sources.questionId, questions.id), eq(sources.bookId, bookId), eq(sources.merged, false)))
      .where(eq(questions.status, "published"))
    const sections = new Map<string, Array<ReserveUnit>>()
    for (const row of rows) {
      const units = sections.get(row.section) ?? []
      units.push({
        id: row.id,
        size: 1,
        questionType: row.questionType,
        band: bandOf(row.seed ?? 0),
        hash: row.hash,
        reserve: row.reserve
      })
      sections.set(row.section, units)
    }
    let joined = 0
    for (const units of sections.values()) {
      for (const [id, reserve] of reserveDecisions(units)) {
        // A Question decided meanwhile keeps that decision.
        const decided = yield* db.update(questions).set({ reserve, reserveDecidedAt: now })
          .where(and(eq(questions.id, id), isNull(questions.reserve))).returning({ id: questions.id })
        if (reserve && decided.length > 0) joined += 1
      }
    }
    return joined
  })

// Decides the Reserve for every extracted Book with published Questions not
// decided yet, such as one another Book's run published.
export const assignUndecided = Effect.gen(function*() {
  const db = yield* Db
  const rows = yield* db.selectDistinct({ bookId: sources.bookId }).from(sources)
    .innerJoin(questions, eq(questions.id, sources.questionId))
    .innerJoin(books, eq(books.id, sources.bookId))
    .where(and(
      eq(sources.merged, false),
      eq(questions.status, "published"),
      isNull(questions.reserve),
      eq(books.status, "extracted")
    ))
  let joined = 0
  for (const row of rows) joined += yield* assignReserve(row.bookId)
  return joined
})
