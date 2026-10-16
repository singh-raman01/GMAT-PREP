import { and, count, eq, inArray, isNotNull, isNull, ne, notInArray, or } from "drizzle-orm"
import { Clock, Effect } from "effect"
import { type Blueprint, DefaultBlueprint, fitsSlot, groupOf } from "../../api/blueprint.ts"
import { bandOf, type DifficultyBand } from "../../api/difficulty.ts"
import { Db } from "../db/Database.ts"
import { books, generationBatches, jobs, questions, sources, stimuli } from "../db/schema.ts"
import { loadBlueprint, storeBlueprint } from "../settings/blueprint.ts"

// The Mock Reserve (ADR 0008): a quarter of each Section's Questions from
// each Book and each generation batch, held back for Mocks. Membership is decided per unit, so an RC
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
  // A passage's Questions from every Book that a Blueprint slot would take
  // (see countsInPassage); its size when absent.
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
export const reserveDecisions = (
  units: ReadonlyArray<ReserveUnit>,
  blueprint: Blueprint = DefaultBlueprint
): ReadonlyMap<string, boolean> => {
  const decisions = new Map<string, boolean>()
  const fits = (unit: ReserveUnit) => fitsSlot(unit.questionType, unit.whole ?? unit.size, blueprint)
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
      // A unit joins when that brings its stratum nearer its share, so a set
      // of three can fill a share of two rather than leave it empty.
      const joins = Math.abs(added + unit.size - quota) < Math.abs(added - quota)
      if (joins) added += unit.size
      decisions.set(unit.id, joins)
    }
  }
  return decisions
}

// Where the Questions being decided came from: a Book, or a generation batch.
export type ReserveOrigin = { readonly bookId: string } | { readonly batchId: string }

// Decides the Reserve for a Book's published Questions not decided yet: the
// Questions the Book itself brought, not those it only added a Source to.
// A passage's published Questions are one unit, and one published after the
// passage was decided, in this Book or another, takes its decision. A
// generation batch's Questions are shared out with every batch's decided
// before, so small batches add up to a quarter.
export const assignReserve = (bookId: string) => assignReserveFor({ bookId })

// The same for a Book's or a generation batch's Questions.
export const assignReserveFor = (origin: ReserveOrigin) =>
  Effect.gen(function*() {
    const db = yield* Db
    return yield* db.transaction(() => decideReserve(origin))
  })

const decideReserve = (origin: ReserveOrigin) =>
  Effect.gen(function*() {
    const db = yield* Db
    const now = yield* Clock.currentTimeMillis
    const fields = {
      id: questions.id,
      section: questions.section,
      questionType: questions.questionType,
      seed: questions.difficultySeed,
      hash: questions.normalizedHash,
      reserve: questions.reserve,
      stimulusId: questions.stimulusId,
      stimulusHash: stimuli.normalizedHash
    }
    const rows = "bookId" in origin
      ? yield* db.select(fields).from(questions)
        .innerJoin(
          sources,
          and(eq(sources.questionId, questions.id), eq(sources.bookId, origin.bookId), eq(sources.merged, false))
        )
        .leftJoin(stimuli, eq(stimuli.id, questions.stimulusId))
        .where(eq(questions.status, "published"))
      : yield* db.select(fields).from(questions)
        .leftJoin(stimuli, eq(stimuli.id, questions.stimulusId))
        .where(and(
          isNotNull(questions.batchId),
          eq(questions.status, "published"),
          or(eq(questions.batchId, origin.batchId), isNotNull(questions.reserve))
        ))
    // Every Question about these passages, from any Book: a passage decided
    // anywhere keeps that decision, released or not, and a slot would take
    // the Questions that count in it.
    const passageIds = [...new Set(rows.flatMap((row) => (row.stimulusId === null ? [] : [row.stimulusId])))]
    const onPassages = passageIds.length === 0 ? [] : yield* db.select({
      stimulusId: questions.stimulusId,
      status: questions.status,
      reserve: questions.reserve,
      releasedAt: questions.releasedAt,
      batchId: questions.batchId
    }).from(questions).where(inArray(questions.stimulusId, passageIds))
    const passageDecision = new Map<string, { readonly reserve: boolean; readonly released: boolean }>()
    const passageSize = new Map<string, number>()
    // A Question still in the Bank decides for its passage before a withdrawn one.
    for (const row of onPassages.toSorted((a, b) => Number(a.status === "withdrawn") - Number(b.status === "withdrawn"))) {
      const id = row.stimulusId!
      if (countsInPassage(row)) passageSize.set(id, (passageSize.get(id) ?? 0) + 1)
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
    const blueprint = yield* loadBlueprint
    for (const units of sections.values()) {
      for (const [id, reserve] of reserveDecisions(units, blueprint)) {
        yield* decide(members.get(id)!.map((row) => row.id), reserve)
      }
    }
    yield* releaseUnfitting
    return joined
  })

// The Questions a passage's size counts: those published, and those decided
// before that are being checked again, as after a Key Override. A Question
// waiting for its first decision, such as a near match the Curator has not
// settled, counts once it is published. A generated set is written whole, so
// its Questions count until withdrawn, as an inference held for the Curator.
const countsInPassage = (
  row: { readonly status: string; readonly reserve: boolean | null; readonly batchId: string | null }
) => row.status === "published" || (row.status !== "withdrawn" && (row.reserve !== null || row.batchId !== null))

// Releases each passage in the Reserve whose Questions, from every Book, no
// longer fit a Blueprint slot, as one that gained Questions from a later
// Book, lost one the Curator withdrew, or lost its slot size when the
// Curator changed the Blueprint: no Mock could serve it.
export const releaseUnfitting = Effect.gen(function*() {
  const db = yield* Db
  const now = yield* Clock.currentTimeMillis
  const blueprint = yield* loadBlueprint
  const held = db.selectDistinct({ stimulusId: questions.stimulusId }).from(questions)
    .where(and(isNotNull(questions.stimulusId), eq(questions.reserve, true), isNull(questions.releasedAt)))
  const passages = yield* db.select({
    stimulusId: questions.stimulusId,
    questionType: questions.questionType,
    size: count()
  }).from(questions)
    .where(and(
      inArray(questions.stimulusId, held),
      or(
        eq(questions.status, "published"),
        and(ne(questions.status, "withdrawn"), or(isNotNull(questions.reserve), isNotNull(questions.batchId)))
      )
    ))
    .groupBy(questions.stimulusId)
  const unfitting = passages.filter((passage) => !fitsSlot(passage.questionType, passage.size, blueprint))
    .map((passage) => passage.stimulusId!)
  if (unfitting.length > 0) {
    yield* db.update(questions).set({ releasedAt: now })
      .where(and(inArray(questions.stimulusId, unfitting), eq(questions.reserve, true), isNull(questions.releasedAt)))
  }
  return unfitting.length
})

// Passages and sets kept out of the Reserve because no slot of the old
// Blueprint took their size, which a slot of the new one takes: their
// decision is undone, so the next decision can take them in. Returns how
// many.
const reopenFitting = (before: Blueprint, after: Blueprint) =>
  Effect.gen(function*() {
    const db = yield* Db
    const outside = db.selectDistinct({ stimulusId: questions.stimulusId }).from(questions)
      .where(and(isNotNull(questions.stimulusId), eq(questions.reserve, false)))
    const passages = yield* db.select({
      stimulusId: questions.stimulusId,
      questionType: questions.questionType,
      size: count()
    }).from(questions)
      .where(and(
        inArray(questions.stimulusId, outside),
        or(eq(questions.status, "published"), and(ne(questions.status, "withdrawn"), isNotNull(questions.reserve)))
      ))
      .groupBy(questions.stimulusId)
    const reopened = passages.filter((passage) =>
      !fitsSlot(passage.questionType, passage.size, before) && fitsSlot(passage.questionType, passage.size, after)
    ).map((passage) => passage.stimulusId!)
    if (reopened.length > 0) {
      yield* db.update(questions).set({ reserve: null, reserveDecidedAt: null })
        .where(and(inArray(questions.stimulusId, reopened), eq(questions.reserve, false)))
    }
    return reopened.length
  })

// Saves the Curator's Blueprint. Passages and sets in the Reserve that fit
// none of its slots now are released; those kept out only because no slot
// took their size are decided again. Returns how many were released, and how
// many Questions joined the Reserve.
export const changeBlueprint = (blueprint: Blueprint) =>
  Effect.gen(function*() {
    const db = yield* Db
    const { released, reopened } = yield* db.transaction(() =>
      Effect.gen(function*() {
        const before = yield* loadBlueprint
        yield* storeBlueprint(blueprint)
        const released = yield* releaseUnfitting
        return { released, reopened: yield* reopenFitting(before, blueprint) }
      })
    )
    return { released, joined: reopened === 0 ? 0 : yield* assignUndecided }
  })

// Decides the Reserve for every Book whose run has ended, finished or not,
// and every generation batch whose job has, with published Questions not
// decided yet, such as one another Book's run or a refresh published. A
// Book whose run goes on, or a batch, decides at its end.
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
  // And for every generation batch whose job has ended.
  const batches = yield* db.selectDistinct({ batchId: generationBatches.id }).from(questions)
    .innerJoin(generationBatches, eq(generationBatches.id, questions.batchId))
    .leftJoin(jobs, eq(jobs.id, generationBatches.jobId))
    .where(and(
      eq(questions.status, "published"),
      isNull(questions.reserve),
      or(isNull(jobs.id), notInArray(jobs.status, ["queued", "running", "paused"]))
    ))
  for (const batch of batches) joined += yield* assignReserveFor({ batchId: batch.batchId })
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
