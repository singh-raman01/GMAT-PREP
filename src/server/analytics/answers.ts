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
  const answered: Array<{ sessionId: string; questionId: string; servedId: string; first: ResponseFact; final: ResponseFact }> = []
  // A whole history runs through here, so each Session's Questions are kept
  // in a small map of their own.
  for (const given of Map.groupBy(responses, (response) => response.sessionId).values()) {
    const found = new Map<string, (typeof answered)[number]>()
    for (const response of given) {
      const questionId = resolve(response.questionId)
      const kept = found.get(questionId)
      if (kept === undefined) {
        const entry = { sessionId: response.sessionId, questionId, servedId: response.questionId, first: response, final: response }
        found.set(questionId, entry)
        answered.push(entry)
        continue
      }
      if (response.seq < kept.first.seq) {
        kept.first = response
        kept.servedId = response.questionId
      }
      if (response.seq > kept.final.seq) kept.final = response
    }
  }
  return answered
}
