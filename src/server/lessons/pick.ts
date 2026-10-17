import { bandOf, type DifficultyBand } from "../../api/difficulty.ts"

// The Questions a Lesson teaches from (docs/design.md, decision 96): its
// worked examples and its 5-Question check, picked by code from the
// published Questions that carry the subject outside the Mock Reserve, the
// same way each time for the same Bank.

export const ExampleCount = 3
export const CheckCount = 5
// A Lesson needs its check and at least one worked example.
export const FewestQuestions = CheckCount + 1

export interface LessonCandidate {
  readonly id: string
  readonly difficulty: number
  readonly hasApproach: boolean
  readonly hasExplanation: boolean
  // The passage or data it shares with other Questions, if any.
  readonly stimulusId: string | null
}

const Bands: ReadonlyArray<DifficultyBand> = ["medium", "easy", "hard"]

// How well a Question serves as a worked example: one with an Approach and
// an explanation to draw on first.
const exampleRank = (candidate: LessonCandidate) => (candidate.hasApproach ? 2 : 0) + (candidate.hasExplanation ? 1 : 0)

const byId = (a: LessonCandidate, b: LessonCandidate) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// Takes up to count, one at a time: the best by rank, then one whose
// Stimulus none taken shares, then from the band taken least (Medium, Easy,
// Hard on a tie), then by id. So Questions spread over the bands and over
// passages, and the same pool always gives the same pick.
const pickSpread = (
  pool: ReadonlyArray<LessonCandidate>,
  count: number,
  rank: (candidate: LessonCandidate) => number
): ReadonlyArray<LessonCandidate> => {
  const taken: Array<LessonCandidate> = []
  const perBand = new Map<DifficultyBand, number>()
  const stimuli = new Set<string>()
  const keyOf = (candidate: LessonCandidate) => {
    const band = bandOf(candidate.difficulty)
    return [
      rank(candidate),
      candidate.stimulusId === null || !stimuli.has(candidate.stimulusId) ? 1 : 0,
      -(perBand.get(band) ?? 0),
      -Bands.indexOf(band)
    ]
  }
  const better = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => {
    for (const [index, value] of a.entries()) if (value !== b[index]) return value > b[index]!
    return false
  }
  const left = pool.toSorted(byId)
  while (taken.length < count) {
    let best: LessonCandidate | undefined
    let bestKey: ReadonlyArray<number> = []
    for (const candidate of left) {
      if (taken.includes(candidate)) continue
      const key = keyOf(candidate)
      if (best === undefined || better(key, bestKey)) {
        best = candidate
        bestKey = key
      }
    }
    if (best === undefined) break
    taken.push(best)
    const band = bandOf(best.difficulty)
    perBand.set(band, (perBand.get(band) ?? 0) + 1)
    if (best.stimulusId !== null) stimuli.add(best.stimulusId)
  }
  return taken
}

export interface LessonPick {
  readonly examples: ReadonlyArray<string>
  readonly checks: ReadonlyArray<string>
}

// The worked examples and the check, or none when the subject has too few
// Questions. Each set is in the order picked.
export const pickLessonQuestions = (candidates: ReadonlyArray<LessonCandidate>): LessonPick | undefined => {
  const unique = [...new Map(candidates.map((each) => [each.id, each] as const)).values()]
  if (unique.length < FewestQuestions) return undefined
  const examples = pickSpread(unique, Math.min(ExampleCount, unique.length - CheckCount), exampleRank)
  const checks = pickSpread(unique.filter((each) => !examples.includes(each)), CheckCount, () => 0)
  return { examples: examples.map((each) => each.id), checks: checks.map((each) => each.id) }
}

// The check's Questions now: those picked that can still be served, any
// gone replaced from the subject's other Questions, never a worked example.
// Fewer than 5 when the subject has run short.
export const checkQuestionsNow = (
  picked: ReadonlyArray<string>,
  examples: ReadonlyArray<string>,
  candidates: ReadonlyArray<LessonCandidate>
): ReadonlyArray<string> => {
  const available = new Map(candidates.map((each) => [each.id, each] as const))
  const kept = picked.filter((id) => available.has(id))
  if (kept.length >= CheckCount) return kept.slice(0, CheckCount)
  const others = pickSpread(
    [...available.values()].filter((each) => !kept.includes(each.id) && !examples.includes(each.id)),
    CheckCount - kept.length,
    () => 0
  )
  return [...kept, ...others.map((each) => each.id)]
}
