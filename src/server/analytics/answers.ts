import type { ResponseFact } from "../learning/misses.ts"

// Each Question a Session served and the Profile answered: its first
// Response, which says how long it took, and its final one, which stands.
// A merged Question counts as the one it became.

export interface Answered {
  readonly sessionId: string
  // The Question it counts as.
  readonly questionId: string
  // The Question as served, which its served row names.
  readonly servedId: string
  readonly first: ResponseFact
  readonly final: ResponseFact
}

export const answeredOf = (
  responses: ReadonlyArray<ResponseFact>,
  resolve: (questionId: string) => string
): ReadonlyArray<Answered> => {
  const found = new Map<string, { first: ResponseFact; final: ResponseFact }>()
  for (const response of responses) {
    const key = `${response.sessionId}|${resolve(response.questionId)}`
    const kept = found.get(key)
    if (kept === undefined) found.set(key, { first: response, final: response })
    else {
      if (response.seq < kept.first.seq) kept.first = response
      if (response.seq > kept.final.seq) kept.final = response
    }
  }
  return [...found].map(([key, { first, final }]) => ({
    sessionId: first.sessionId,
    questionId: key.slice(key.indexOf("|") + 1),
    servedId: first.questionId,
    first,
    final
  }))
}
