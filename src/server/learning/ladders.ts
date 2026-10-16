import { isCorrect } from "../practice/history.ts"
import { type Ladder, type LadderEvent, ladderOf, type Step } from "./ladder.ts"
import type { Miss, QuestionFact, Reason, ResponseFact } from "./misses.ts"
import { SlowFactor } from "./misses.ts"
import type { RetryItem } from "./retryConfig.ts"

// Each Error Log entry's Retry Ladder, from the facts (docs/design.md,
// "Learning loop"): its misses outside its own retries start it; the final
// Response to each retry Question, once its set shows how it went, is a
// step taken; a stored skip is a step with nothing to serve.

export interface RetrySession {
  readonly id: string
  readonly shown: boolean
  readonly retry: ReadonlyArray<RetryItem>
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
  const sessions = new Map(input.sessions.map((session) => [session.id, session] as const))
  // A miss of an entry's own Question in a retry set for that entry is the
  // step taken there, not a new miss.
  const isOwnRetry = (miss: Miss) =>
    sessions.get(miss.sessionId)?.retry.some((item) =>
      item.step === 1 && item.questionId === miss.questionId && input.resolve(item.entry) === input.resolve(miss.questionId)
    ) === true
  type Timed = { readonly at: number; readonly event: (reasons: ReadonlyArray<Reason>) => LadderEvent; readonly reasons?: ReadonlyArray<Reason> }
  const byEntry = new Map<string, Array<Timed>>()
  const add = (entry: string, item: Timed) => byEntry.set(entry, [...(byEntry.get(entry) ?? []), item])
  for (const miss of input.misses) {
    if (isOwnRetry(miss)) continue
    add(input.resolve(miss.questionId), {
      at: miss.at,
      reasons: miss.reasons,
      event: () => ({ kind: "miss", day: input.dayOf(miss.at), at: miss.at })
    })
  }
  for (const session of input.sessions) {
    if (!session.shown) continue
    const mine = input.responses.filter((response) => response.sessionId === session.id).toSorted((a, b) => a.seq - b.seq)
    for (const item of session.retry) {
      const given = mine.filter((response) => response.questionId === item.questionId)
      const final = given.at(-1)
      const question = input.questions.get(item.questionId)
      if (final === undefined || question === undefined) continue
      const keys = question.parts.map((part) => ({ position: part.position, key: part.key }))
      const right = final.kind !== "time-out" && isCorrect(final.selection, keys)
      const firstTime = given[0]!.timeSpentMs
      add(input.resolve(item.entry), {
        at: final.at,
        event: (reasons) => ({
          kind: "attempt",
          step: item.step,
          day: input.dayOf(final.at),
          at: final.at,
          passed: right &&
            (!reasons.includes("slow") || firstTime <= SlowFactor * question.targetMs) &&
            (!reasons.includes("guessed") || !final.guessed)
        })
      })
    }
  }
  for (const skip of input.skips) {
    add(input.resolve(skip.questionId), {
      at: skip.at,
      event: () => ({ kind: "skip", step: skip.step, day: input.dayOf(skip.at), at: skip.at, note: skip.note })
    })
  }
  const ladders = new Map<string, EntryLadder>()
  for (const [entry, items] of byEntry) {
    let reasons: ReadonlyArray<Reason> = []
    const events = items.toSorted((a, b) => a.at - b.at).map((item) => {
      if (item.reasons !== undefined) reasons = item.reasons
      return item.event(reasons)
    })
    const ladder = ladderOf(events)
    if (ladder !== null) ladders.set(entry, { ladder, reasons })
  }
  return ladders
}
