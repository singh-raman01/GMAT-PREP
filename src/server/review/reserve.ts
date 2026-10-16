import { and, count, eq, inArray, isNotNull, isNull, ne, notInArray, or } from "drizzle-orm"
import { Clock, Effect } from "effect"
import { fitsSlot, groupOf } from "../../api/blueprint.ts"
import { bandOf, type DifficultyBand } from "../../api/difficulty.ts"
import { Db } from "../db/Database.ts"
import { books, jobs, questions, sources, stimuli } from "../db/schema.ts"

// The Mock Reserve (ADR 0008): a quarter of each Section's Questions from
// each Book, held back for Mocks. Membership is decided per unit, so an RC
// passage's or an MSR set's Questions stay together, and only units that fit
// a Section Blueprint slot can join. Each Question Type and Difficulty Band
// gets its share, and within one the units are taken in the order of their
// text's hash, so the same Book always gives the same Reserve. A unit is
// decided once; later Questions from the Book make up any shortfall. A
// passage's decision holds for its Questions from every Book, and a passage
// in the Reserve that no longer fits a slot is released.

export interface ReserveUnit {
  readonly id: string
  // Its Questions from the Book being decided, which count toward its share.
  readonly size: number
  // A passage's Questions from every Book, not withdrawn, which a Blueprint
  // slot would take; its size when absent.
  readonly whole?: number
  // The type of its Questions, or of one of them for a passage, whose
  // Questions differ in type within one Blueprint group.
  readonly questionType: string
  readonly band: DifficultyBand
  // Orders units within a stratum, the same way every time.
  readonly hash: string
  // Decided before: in the Reserve or not; null when undecided.
  readonly reserve: boolean | null
}

const ReserveShare = 0.25

// What a unit's share is counted by: a single Question's Question Type, or a
// passage's or set's Blueprint group, since a passage's Questions differ in
// type.
const shareOf = (unit: { readonly size: number; readonly questionType: string }) =>
  unit.size > 1 ? groupOf(unit.questionType)?.name ?? unit.questionType : unit.questionType

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
  const fits = (unit: ReserveUnit) => fitsSlot(unit.questionType, unit.whole ?? unit.size)
  const fitting = units.filter(fits)
  for (const unit of units) {
    if (unit.reserve === null && !fits(unit)) decisions.set(unit.id, false)
  }
  const stratumOf = (unit: ReserveUnit) => `${shareOf(unit)}|${unit.band}`
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
// A passage's published Questions are one unit, and one published after the
// passage was decided, in this Book or another, takes its decision.
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
      reserve: questions.reserve,
      stimulusId: questions.stimulusId,
      stimulusHash: stimuli.normalizedHash
    }).from(questions)
      .innerJoin(sources, and(eq(sources.questionId, questions.id), eq(sources.bookId, bookId), eq(sources.merged, false)))
      .leftJoin(stimuli, eq(stimuli.id, questions.stimulusId))
      .where(eq(questions.status, "published"))
    // Every Question about these passages, from any Book: a passage decided
    // anywhere keeps that decision, released or not, and a slot would take
    // all its Questions not withdrawn.
    const passageIds = [...new Set(rows.flatMap((row) => (row.stimulusId === null ? [] : [row.stimulusId])))]
    const onPassages = passageIds.length === 0 ? [] : yield* db.select({
      stimulusId: questions.stimulusId,
      status: questions.status,
      reserve: questions.reserve,
      releasedAt: questions.releasedAt
    }).from(questions).where(inArray(questions.stimulusId, passageIds))
    const passageDecision = new Map<string, { readonly reserve: boolean; readonly released: boolean }>()
    const passageSize = new Map<string, number>()
    for (const row of onPassages) {
      const id = row.stimulusId!
      if (row.status !== "withdrawn") passageSize.set(id, (passageSize.get(id) ?? 0) + 1)
      if (row.reserve !== null && !passageDecision.has(id)) {
        passageDecision.set(id, { reserve: row.reserve, released: row.releasedAt !== null })
      }
    }
    const members = Map.groupBy(rows, (row) => row.stimulusId ?? row.id)
    const sections = new Map<string, Array<ReserveUnit>>()
    let joined = 0
    const decide = (ids: ReadonlyArray<string>, reserve: boolean, released = false) =>
      Effect.gen(function*() {
        // A Question decided meanwhile keeps that decision.
        const decided = yield* db.update(questions)
          .set({ reserve, reserveDecidedAt: now, ...(released ? { releasedAt: now } : {}) })
          .where(and(inArray(questions.id, [...ids]), isNull(questions.reserve))).returning({ id: questions.id })
        if (reserve) joined += decided.length
      })
    for (const [id, unit] of members) {
      const first = unit[0]!
      const passage = first.stimulusId === null ? undefined : passageDecision.get(first.stimulusId)
      const reserve = passage?.reserve ?? unit.find((row) => row.reserve !== null)?.reserve ?? null
      // A passage decided before takes in the Questions published since.
      if (reserve !== null) {
        const undecided = unit.filter((row) => row.reserve === null).map((row) => row.id)
        if (undecided.length > 0) yield* decide(undecided, reserve, passage?.released ?? false)
      }
      const seed = unit.reduce((total, row) => total + (row.seed ?? 0), 0) / unit.length
      const units = sections.get(first.section) ?? []
      units.push({
        id,
        size: unit.length,
        ...(first.stimulusId === null ? {} : { whole: passageSize.get(first.stimulusId) ?? unit.length }),
        questionType: first.questionType,
        band: bandOf(seed),
        hash: first.stimulusHash ?? first.hash,
        reserve
      })
      sections.set(first.section, units)
    }
    for (const units of sections.values()) {
      for (const [id, reserve] of reserveDecisions(units)) {
        yield* decide(members.get(id)!.map((row) => row.id), reserve)
      }
    }
    yield* releaseUnfitting
    return joined
  })

// Releases each passage in the Reserve whose Questions, from every Book and
// not withdrawn, no longer fit a Blueprint slot, as one that gained Questions
// from a later Book or lost one the Curator withdrew: no Mock could serve it.
export const releaseUnfitting = Effect.gen(function*() {
  const db = yield* Db
  const now = yield* Clock.currentTimeMillis
  const held = db.selectDistinct({ stimulusId: questions.stimulusId }).from(questions)
    .where(and(isNotNull(questions.stimulusId), eq(questions.reserve, true), isNull(questions.releasedAt)))
  const passages = yield* db.select({
    stimulusId: questions.stimulusId,
    questionType: questions.questionType,
    size: count()
  }).from(questions)
    .where(and(inArray(questions.stimulusId, held), ne(questions.status, "withdrawn")))
    .groupBy(questions.stimulusId)
  const unfitting = passages.filter((passage) => !fitsSlot(passage.questionType, passage.size))
    .map((passage) => passage.stimulusId!)
  if (unfitting.length > 0) {
    yield* db.update(questions).set({ releasedAt: now })
      .where(and(inArray(questions.stimulusId, unfitting), eq(questions.reserve, true), isNull(questions.releasedAt)))
  }
  return unfitting.length
})

// Decides the Reserve for every Book whose run has ended, finished or not,
// with published Questions not decided yet, such as one another Book's run
// or a refresh published. A Book whose run goes on decides at its end.
export const assignUndecided = Effect.gen(function*() {
  const db = yield* Db
  const rows = yield* db.selectDistinct({ bookId: sources.bookId }).from(sources)
    .innerJoin(questions, eq(questions.id, sources.questionId))
    .innerJoin(books, eq(books.id, sources.bookId))
    .leftJoin(jobs, eq(jobs.id, books.jobId))
    .where(and(
      eq(sources.merged, false),
      eq(questions.status, "published"),
      isNull(questions.reserve),
      or(eq(books.status, "extracted"), isNull(jobs.id), notInArray(jobs.status, ["queued", "running", "paused"]))
    ))
  let joined = 0
  for (const row of rows) joined += yield* assignReserve(row.bookId)
  yield* db.transaction(() => releaseUnfitting)
  return joined
})

// A held Reserve unit the Curator may release: one Question, or a passage's
// Questions together.
export interface HeldUnit {
  readonly id: string
  readonly size: number
  readonly questionType: string
  readonly band: DifficultyBand
  readonly hash: string
}

// Which held units to release, up to count Questions, so that what stays
// held keeps its spread across Question Types and Difficulty Bands: each
// comes from the stratum holding the most Questions, and within it, the last
// in hash order. A passage is released whole, so one with more Questions than
// are left to release is passed over.
export const releaseOrder = (held: ReadonlyArray<HeldUnit>, count: number): ReadonlyArray<string> => {
  const strata = new Map<string, Array<HeldUnit>>()
  for (const unit of held) {
    const key = `${shareOf(unit)}|${unit.band}`
    strata.set(key, [...(strata.get(key) ?? []), unit])
  }
  for (const members of strata.values()) members.sort((a, b) => b.hash.localeCompare(a.hash))
  const keys = [...strata.keys()].toSorted()
  const questionsIn = (members: ReadonlyArray<HeldUnit>) => members.reduce((total, unit) => total + unit.size, 0)
  const picked: Array<string> = []
  let left = count
  while (left > 0) {
    let fullest: string | undefined
    for (const key of keys) {
      const members = strata.get(key)!
      if (members.some((unit) => unit.size <= left) && questionsIn(members) > questionsIn(strata.get(fullest ?? "") ?? [])) {
        fullest = key
      }
    }
    if (fullest === undefined) break
    const members = strata.get(fullest)!
    const unit = members.find((each) => each.size <= left)!
    strata.set(fullest, members.filter((each) => each !== unit))
    picked.push(unit.id)
    left -= unit.size
  }
  return picked
}
