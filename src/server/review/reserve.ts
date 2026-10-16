import { and, eq } from "drizzle-orm"
import { Clock, Effect } from "effect"
import { fitsSlot } from "../../api/blueprint.ts"
import { type Band, bandOf } from "../../api/taxonomyRules.ts"
import { Db } from "../db/Database.ts"
import { questions, sources } from "../db/schema.ts"

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

// The undecided units of one Book's Section, each with its decision.
export const reserveDecisions = (units: ReadonlyArray<ReserveUnit>): ReadonlyMap<string, boolean> => {
  const decisions = new Map<string, boolean>()
  const fitting = units.filter((unit) => fitsSlot(unit.questionType, unit.size))
  for (const unit of units) {
    if (unit.reserve === null && !fitsSlot(unit.questionType, unit.size)) decisions.set(unit.id, false)
  }
  const stratumOf = (unit: ReserveUnit) => `${unit.questionType}|${unit.band}`
  const sizes = new Map<string, number>()
  for (const unit of fitting) sizes.set(stratumOf(unit), (sizes.get(stratumOf(unit)) ?? 0) + unit.size)
  const total = Math.round([...sizes.values()].reduce((sum, size) => sum + size, 0) * ReserveShare)
  const quotas = apportion(total, [...sizes.entries()])
  for (const [stratum, quota] of quotas) {
    const members = fitting.filter((unit) => stratumOf(unit) === stratum)
    let held = members.filter((unit) => unit.reserve === true).reduce((sum, unit) => sum + unit.size, 0)
    const open = members.filter((unit) => unit.reserve === null).toSorted((a, b) => a.hash.localeCompare(b.hash))
    for (const unit of open) {
      const joins = held + unit.size <= quota
      if (joins) held += unit.size
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
        yield* db.update(questions).set({ reserve, reserveDecidedAt: now }).where(eq(questions.id, id))
        if (reserve) joined += 1
      }
    }
    return joined
  })
