import { isCorrect } from "../practice/history.ts"
import { type Ladder, type LadderEvent, ladderOf, type Step } from "./ladder.ts"
import type { Miss, QuestionFact, Reason, ResponseFact } from "./misses.ts"
import { SlowFactor } from "./misses.ts"
import type { RetryItem } from "./retryConfig.ts"

// Each Error Log entry's Retry Ladder, from the facts (docs/design.md,
// "Learning loop"): its misses outside its own step-1 retries start it; a
// miss in one of those starts it when no run is open then, and is otherwise
// that run's step 1 taken; the final Response to each retry Question, once
// its set shows how it went, is a step taken, at most one a set; a stored
// skip is a step with nothing to serve.

export interface RetrySession {
  readonly id: string
  readonly shown: boolean
  readonly retry: ReadonlyArray<RetryItem>
  // When the set was made, and its steps planned.
  readonly createdAt: number
}

export interface SkipFact {
  // The entry, by its Question.
  readonly questionId: string
  readonly step: Step
  readonly at: number
  readonly note: string
}

export interface EntryLadder {
  readonly ladder: Ladder
  // Why the entry is in the Error Log, as the current run began.
  readonly reasons: ReadonlyArray<Reason>
}

export const laddersOf = (input: {
  readonly misses: ReadonlyArray<Miss>
  readonly sessions: ReadonlyArray<RetrySession>
  readonly responses: ReadonlyArray<ResponseFact>
  readonly questions: ReadonlyMap<string, QuestionFact>
  readonly skips: ReadonlyArray<SkipFact>
  readonly resolve: (questionId: string) => string
  readonly dayOf: (at: number) => number
}): ReadonlyMap<string, EntryLadder> => {
  const resolve = input.resolve
  const sessions = new Map(input.sessions.map((session) => [session.id, session] as const))
  // A miss of an entry's own Question in a retry set's step 1 for that entry
  // is that step taken, and starts a run only when none is open then. Ids
  // are compared as the Questions they count as, so a merge keeps the
  // ladder.
  const isOwnRetry = (miss: Miss) =>
    sessions.get(miss.sessionId)?.retry.some((item) =>
      item.step === 1 && resolve(item.questionId) === miss.questionId && resolve(item.entry) === miss.questionId
    ) === true
  const byEntry = new Map<string, Array<LadderEvent>>()
  const add = (entry: string, event: LadderEvent) => {
    const found = byEntry.get(entry)
    if (found === undefined) byEntry.set(entry, [event])
    else found.push(event)
  }
  for (const miss of input.misses) {
    const day = input.dayOf(miss.at)
    add(
      miss.questionId,
      isOwnRetry(miss)
        ? { kind: "own-miss", day, at: miss.at, reasons: miss.reasons, set: miss.sessionId }
        : { kind: "miss", day, at: miss.at, reasons: miss.reasons }
    )
  }
  const bySession = Map.groupBy(input.responses, (response) => response.sessionId)
  for (const session of input.sessions) {
    if (!session.shown) continue
    const mine = (bySession.get(session.id) ?? []).toSorted((a, b) => a.seq - b.seq)
    // Each item takes the Responses to the Question served for it; one
    // served in its place after a merge goes to an item none answered. Every
    // item is a step taken; the ladder lets the set take at most one step of
    // an entry, the first whose step is the one due, as two items can count
    // for one entry after a merge.
    const claimed = new Set<string>()
    const byItem = session.retry.map((item) => {
      const given = mine.filter((response) => response.questionId === item.questionId)
      for (const response of given) claimed.add(response.id)
      return given
    })
    for (const [index, item] of session.retry.entries()) {
      const entry = resolve(item.entry)
      // The Question served for the step, or the one it was merged into.
      const counted = resolve(item.questionId)
      const own = byItem[index]!
      const given = own.length > 0
        ? own
        : mine.filter((response) => !claimed.has(response.id) && resolve(response.questionId) === counted)
      for (const response of given) claimed.add(response.id)
      const final = given.at(-1)
      const question = input.questions.get(counted)
      if (final === undefined || question === undefined) continue
      const keys = question.parts.map((part) => ({ position: part.position, key: part.key }))
      const right = final.kind !== "time-out" && isCorrect(final.selection, keys)
      const firstTime = given[0]!.timeSpentMs
      add(entry, {
        kind: "attempt",
        step: item.step,
        day: input.dayOf(final.at),
        at: final.at,
        plannedAt: session.createdAt,
        set: session.id,
        // Judged by the reasons of the run it falls in.
        passed: (reasons) =>
          right &&
          (!reasons.includes("slow") || firstTime <= SlowFactor * question.targetMs) &&
          (!reasons.includes("guessed") || !final.guessed)
      })
    }
  }
  for (const skip of input.skips) {
    add(resolve(skip.questionId), { kind: "skip", step: skip.step, day: input.dayOf(skip.at), at: skip.at, note: skip.note })
  }
  const ladders = new Map<string, EntryLadder>()
  for (const [entry, events] of byEntry) {
    const ladder = ladderOf(events)
    if (ladder !== null) ladders.set(entry, { ladder, reasons: ladder.reasons as ReadonlyArray<Reason> })
  }
  return ladders
}
