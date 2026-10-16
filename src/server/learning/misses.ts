import type { Selection } from "../../api/Practice.ts"
import { TimePressure } from "../../api/taxonomyRules.ts"
import { isCorrect } from "../practice/history.ts"

// What enters the Error Log (docs/design.md, "Learning loop"): a Session's
// final Response to a Question that is wrong, slow or guessed. Everything
// here is worked out from Responses and the current keys, so a Key Override
// or a rebuild gives the same Error Log from the same facts (ADR 0005).

export type Reason = "wrong" | "slow" | "guessed"

export interface SessionFact {
  readonly id: string
  // practice, sectional or mock-section
  readonly kind: string
  // A timed Session's time limit.
  readonly limitMs: number | null
  // Whether the Session shows how its answers went yet: an untimed Practice
  // Set at once, a timed one when it ends, a Sectional when it closes, a
  // Mock's Section when the Mock is over.
  readonly shown: boolean
}

export interface ResponseFact {
  readonly id: string
  readonly sessionId: string
  // The Question as served.
  readonly questionId: string
  // first, edit or time-out
  readonly kind: string
  readonly seq: number
  readonly selection: Selection
  readonly timeSpentMs: number
  readonly guessed: boolean
  readonly at: number
}

export interface ServedFact {
  readonly sessionId: string
  readonly questionId: string
  // A timed Session's clock when the Question was served.
  readonly servedElapsedMs: number | null
}

export interface QuestionFact {
  readonly id: string
  // The RC passage or MSR set it is timed with, as a whole; null for a
  // Question timed alone. Its time and Target Time count as the unit's for
  // both slow and rushed answers.
  readonly unit: string | null
  readonly targetMs: number
  readonly parts: ReadonlyArray<{
    readonly position: number
    readonly key: string | null
    // Each wrong option's note, by the option's label; none while the notes
    // wait to be written again for a changed key.
    readonly notes: ReadonlyMap<string, { readonly mistakeType: string; readonly trapPattern: string | null }>
  }>
}

export interface MissedPart {
  readonly part: number
  // The option picked; null when none was, as at a time-out.
  readonly picked: string | null
  // As the app fills it in; null when the picked option has no note.
  readonly mistakeType: string | null
  readonly trapPattern: string | null
  // Where the app's Mistake Type came from: the answer's timing, the picked
  // option's note, or nowhere.
  readonly basis: "timing" | "option" | "none"
}

export interface Miss {
  readonly sessionId: string
  // The Question it counts for: a merged Question counts as the one it
  // became, and is judged by that one's key.
  readonly questionId: string
  // The Session's final Response to the Question.
  readonly responseId: string
  readonly at: number
  readonly reasons: ReadonlyArray<Reason>
  // The wrong Parts of a wrong answer.
  readonly parts: ReadonlyArray<MissedPart>
}

// Slow is over 1.5 times the Target Time.
export const SlowFactor = 1.5
// Time pressure: an answer in under a quarter of the Target Time, or in the
// last tenth of a timed Session.
export const RushedShare = 0.25
export const LastShare = 0.1

export const missesOf = (input: {
  readonly sessions: ReadonlyArray<SessionFact>
  readonly responses: ReadonlyArray<ResponseFact>
  readonly served: ReadonlyArray<ServedFact>
  readonly questions: ReadonlyArray<QuestionFact> | ReadonlyMap<string, QuestionFact>
  readonly resolve?: (questionId: string) => string
}): ReadonlyArray<Miss> => {
  const questions: ReadonlyMap<string, QuestionFact> = input.questions instanceof Map
    ? input.questions
    : new Map((input.questions as ReadonlyArray<QuestionFact>).map((question) => [question.id, question] as const))
  const resolve = input.resolve ?? ((questionId: string) => questionId)
  const bySession = Map.groupBy(input.responses, (response) => response.sessionId)
  const servedAt = new Map(input.served.map((row) => [`${row.sessionId}|${row.questionId}`, row.servedElapsedMs] as const))
  const misses: Array<Miss> = []
  for (const session of input.sessions) {
    if (!session.shown) continue
    // The groups are this function's own arrays, so they are sorted in place.
    const mine = (bySession.get(session.id) ?? []).sort((a, b) => a.seq - b.seq)
    const byQuestion = new Map<string, Array<ResponseFact>>()
    for (const response of mine) {
      const questionId = resolve(response.questionId)
      const given = byQuestion.get(questionId)
      if (given === undefined) byQuestion.set(questionId, [response])
      else given.push(response)
    }
    // Each Question's time: its first Response's, as the clock counted it.
    const timeOf = (questionId: string) => byQuestion.get(questionId)?.[0]?.timeSpentMs ?? 0
    // An RC passage's or MSR set's Questions in the Session are timed as a
    // whole, against the sum of their Target Times.
    const units = new Map<string, { spent: number; target: number }>()
    for (const questionId of byQuestion.keys()) {
      const question = questions.get(questionId)
      if (question?.unit == null) continue
      const found = units.get(question.unit) ?? { spent: 0, target: 0 }
      units.set(question.unit, { spent: found.spent + timeOf(questionId), target: found.target + question.targetMs })
    }
    const timingOf = (question: QuestionFact) =>
      question.unit === null ? { spent: timeOf(question.id), target: question.targetMs } : units.get(question.unit)!
    for (const [questionId, given] of byQuestion) {
      const question = questions.get(questionId)
      if (question === undefined) continue
      const first = given[0]!
      const final = given.at(-1)!
      const right = final.kind !== "time-out" && isCorrect(final.selection, question.parts)
      const edited = given.some((response) => response.kind === "edit")
      const timing = timingOf(question)
      const miss = { sessionId: session.id, questionId, responseId: final.id, at: final.at }
      if (!right) {
        const rushed = first.kind === "time-out" ||
          timing.spent < RushedShare * timing.target ||
          (session.limitMs !== null &&
            (servedAt.get(`${session.id}|${first.questionId}`) ?? 0) + first.timeSpentMs >= (1 - LastShare) * session.limitMs)
        const parts = question.parts.flatMap((part): Array<MissedPart> => {
          const picked = final.kind === "time-out"
            ? null
            : final.selection.find((choice) => choice.part === part.position)?.choice ?? null
          if (picked !== null && picked === part.key) return []
          const note = picked === null ? undefined : part.notes.get(picked)
          return [{
            part: part.position,
            picked,
            mistakeType: rushed ? TimePressure : note?.mistakeType ?? null,
            trapPattern: note?.trapPattern ?? null,
            basis: rushed ? "timing" : note === undefined ? "none" : "option"
          }]
        })
        misses.push({ ...miss, reasons: ["wrong"], parts })
        continue
      }
      // An answer fixed in Review & Edit stays out.
      if (edited) continue
      // Only a timed Session's clock says an answer was slow: an untimed
      // set's time runs while the Question sits open.
      const slow = session.limitMs !== null && timing.spent > SlowFactor * timing.target
      const guessed = session.kind === "practice" && final.guessed
      const reasons: Array<Reason> = [...(slow ? ["slow" as const] : []), ...(guessed ? ["guessed" as const] : [])]
      if (reasons.length > 0) misses.push({ ...miss, reasons, parts: [] })
    }
  }
  return misses
}
