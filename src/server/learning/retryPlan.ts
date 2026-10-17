import type { PoolQuestion } from "../practice/selection.ts"
import type { Step } from "./ladder.ts"
import type { RetryItem } from "./retryConfig.ts"
import { pickSibling, type SiblingTarget } from "./siblings.ts"

// What a retry set serves for the steps due (docs/design.md, "Learning
// loop"): step 1 serves the entry's own Question, unless it cannot be served
// now; a Sibling step serves an unseen Sibling, none twice in the set, and
// is skipped when none is left. Steps come longest waiting first, and the
// set stops at its size.

export interface DueStep {
  readonly step: Step
  // The entry's Question, with what a Sibling must share with it.
  readonly target: SiblingTarget
  // Whether the entry's Question is in the Question Bank to serve.
  readonly published: boolean
}

export interface RetryPlan {
  readonly items: ReadonlyArray<RetryItem>
  // Sibling steps with no Sibling left.
  readonly skipped: ReadonlyArray<DueStep>
  // Step 1s whose Question a running Section holds, or that is out of the
  // Question Bank, to wait.
  readonly waiting: ReadonlyArray<DueStep>
}

export const planRetries = (
  steps: ReadonlyArray<DueStep>,
  context: {
    readonly held: ReadonlySet<string>
    readonly seen: ReadonlySet<string>
    readonly pool: ReadonlyArray<PoolQuestion>
    readonly resolve: (questionId: string) => string
    // Varies the pick among equally near Siblings from one start to the next.
    readonly salt: string
    // The most steps a set serves.
    readonly size: number
  }
): RetryPlan => {
  const items: Array<RetryItem> = []
  const skipped: Array<DueStep> = []
  const waiting: Array<DueStep> = []
  for (const due of steps) {
    if (items.length >= context.size) break
    const entry = due.target.id
    if (due.step === 1) {
      if (!due.published || context.held.has(context.resolve(entry))) waiting.push(due)
      else items.push({ entry, step: 1, questionId: entry })
      continue
    }
    const taken = new Set([...context.seen, ...context.held, ...items.map((item) => item.questionId)])
    const sibling = pickSibling(context.pool, taken, due.target, `${entry}|${due.step}|${context.salt}`)
    if (sibling === undefined) skipped.push(due)
    else items.push({ entry, step: due.step, questionId: sibling.id })
  }
  return { items, skipped, waiting }
}
