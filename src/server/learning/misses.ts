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
  // Question timed alone.
  readonly unit: string | null
  readonly targetMs: number
  readonly parts: ReadonlyArray<{
    readonly position: number
    readonly key: string | null
    // Its options' labels, in order.
    readonly labels: ReadonlyArray<string>
    // Each wrong option's note, by the option's position.
    readonly notes: ReadonlyMap<number, { readonly mistakeType: string; readonly trapPattern: string | null }>
  }>
}

export interface MissedPart {
  readonly part: number
  // The option picked; null when none was, as at a time-out.
  readonly picked: string | null
  // As the app fills it in; null when the picked option has no note.
  readonly mistakeType: string | null
  readonly trapPattern: string | null
}

export interface Miss {
  readonly sessionId: string
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
  readonly questions: ReadonlyArray<QuestionFact>
}): ReadonlyArray<Miss> => {
  const questions = new Map(input.questions.map((question) => [question.id, question] as const))
  const misses: Array<Miss> = []
  for (const session of input.sessions) {
    if (!session.shown) continue
    const mine = input.responses.filter((response) => response.sessionId === session.id).toSorted((a, b) => a.seq - b.seq)
    const byQuestion = Map.groupBy(mine, (response) => response.questionId)
    // Each Question's time: its first Response's, as the clock counted it.
    const timeOf = (questionId: string) => byQuestion.get(questionId)?.[0]?.timeSpentMs ?? 0
    // A passage or set is slow when its Questions in the Session took over
    // 1.5 times their Target Times together.
    const slowUnits = new Set<string>()
    for (const [unit, members] of Map.groupBy(
      [...byQuestion.keys()].flatMap((id) => {
        const question = questions.get(id)
        return question?.unit == null ? [] : [{ unit: question.unit, question }]
      }),
      (member) => member.unit
    )) {
      const spent = members.reduce((sum, member) => sum + timeOf(member.question.id), 0)
      const target = members.reduce((sum, member) => sum + member.question.targetMs, 0)
      if (spent > SlowFactor * target) slowUnits.add(unit)
    }
    for (const [questionId, given] of byQuestion) {
      const question = questions.get(questionId)
      if (question === undefined) continue
      const first = given[0]!
      const final = given.at(-1)!
      const keys = question.parts.map((part) => ({ position: part.position, key: part.key }))
      const right = final.kind !== "time-out" && isCorrect(final.selection, keys)
      const edited = given.some((response) => response.kind === "edit")
      const miss = { sessionId: session.id, questionId, responseId: final.id, at: final.at }
      if (!right) {
        const served = input.served.find((row) => row.sessionId === session.id && row.questionId === questionId)
        const rushed = first.kind === "time-out" ||
          first.timeSpentMs < RushedShare * question.targetMs ||
          (session.limitMs !== null && (served?.servedElapsedMs ?? 0) + first.timeSpentMs >= (1 - LastShare) * session.limitMs)
        const parts = question.parts.flatMap((part): Array<MissedPart> => {
          const picked = final.kind === "time-out"
            ? null
            : final.selection.find((choice) => choice.part === part.position)?.choice ?? null
          if (picked !== null && picked === part.key) return []
          const note = picked === null ? undefined : part.notes.get(part.labels.indexOf(picked))
          return [{
            part: part.position,
            picked,
            mistakeType: rushed ? TimePressure : note?.mistakeType ?? null,
            trapPattern: note?.trapPattern ?? null
          }]
        })
        misses.push({ ...miss, reasons: ["wrong"], parts })
        continue
      }
      // An answer fixed in Review & Edit stays out.
      if (edited) continue
      const slow = question.unit === null ? timeOf(questionId) > SlowFactor * question.targetMs : slowUnits.has(question.unit)
      const guessed = session.kind === "practice" && final.guessed
      const reasons: Array<Reason> = [...(slow ? ["slow" as const] : []), ...(guessed ? ["guessed" as const] : [])]
      if (reasons.length > 0) misses.push({ ...miss, reasons, parts: [] })
    }
  }
  return misses
}
