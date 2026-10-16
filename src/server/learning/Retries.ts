import { Clock, Context, Effect, Layer, Semaphore } from "effect"
import { PracticeView, SessionId } from "../../api/Practice.ts"
import { NoRetriesDue, RetriesRunning, RetriesView, RetryDue } from "../../api/Retries.ts"
import { QuestionId } from "../../api/Review.ts"
import { Db } from "../db/Database.ts"
import { retrySkips } from "../db/schema.ts"
import { heldBySections, mergeTargets, publishedPool, seenBy } from "../practice/history.ts"
import { namesOf } from "../practice/content.ts"
import { type Caller, Practice } from "../practice/Practice.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { ErrorLog, type RetryState } from "./ErrorLog.ts"
import type { Step } from "./ladder.ts"
import { planRetries } from "./retryPlan.ts"

// Retries (docs/design.md, "Learning loop"): the Retry Ladder steps due, and
// the Practice Sets that take them. Step 1 of a wrong or guessed entry is
// untimed; step 1 of a slow entry, and each Sibling step, are timed.

const DayMs = 24 * 60 * 60 * 1000
const dayText = (day: number) => new Date(day * DayMs).toISOString().slice(0, 10)

// How many Study Days ahead the due list looks.
const Ahead = 7

export const NoSiblingNote = "No unseen Sibling of its Question Type and Skill was left."

type Due = RetryState["entries"][number] & { readonly step: Step; readonly dueDay: number; readonly timed: boolean }

const dueOf = (state: RetryState): ReadonlyArray<Due> =>
  state.entries.flatMap((entry): Array<Due> => {
    const ladder = entry.ladder.ladder
    if (entry.status !== "open" || ladder.step === null || ladder.dueDay === null) return []
    const timed = ladder.step > 1 || entry.ladder.reasons.includes("slow")
    return [{ ...entry, step: ladder.step, dueDay: ladder.dueDay, timed }]
  }).toSorted((a, b) => a.dueDay - b.dueDay || a.lastMissedAt - b.lastMissedAt)

export class Retries extends Context.Service<Retries, {
  due(profileId: string): Effect.Effect<RetriesView>
  start(caller: Caller, timed: boolean): Effect.Effect<PracticeView, NoRetriesDue | RetriesRunning>
}>()("gmat-prep/server/Retries") {
  static readonly layer = Layer.effect(
    Retries,
    Effect.gen(function*() {
      const db = yield* Db
      const errorLog = yield* ErrorLog
      const practice = yield* Practice
      const names = namesOf((yield* Taxonomy).view)
      const run = <A, E>(effect: Effect.Effect<A, E, Db>) => effect.pipe(Effect.provideService(Db, db), Effect.orDie)
      // Two starts at once, from two tabs, make one set.
      const oneAtATime = (yield* Semaphore.make(1)).withPermits(1)

      const due = (profileId: string) =>
        Effect.gen(function*() {
          const state = yield* errorLog.retryState(profileId)
          const all = dueOf(state)
          const today = all.filter((each) => each.dueDay <= state.today)
          const held = today.length === 0 ? new Set<string>() : yield* run(heldBySections(profileId))
          const named = (id: string) => names.named(id)
          return new RetriesView({
            today: dayText(state.today),
            due: today.map((each) =>
              new RetryDue({
                questionId: QuestionId.make(each.questionId),
                step: each.step,
                questionType: named(each.question.questionType),
                primarySkill: each.question.primarySkill === null ? null : named(each.question.primarySkill),
                reasons: each.ladder.reasons,
                timed: each.timed,
                dueOn: dayText(each.dueDay),
                held: each.step === 1 && held.has(each.questionId)
              })
            ),
            upcoming: Array.from({ length: Ahead }, (_, index) => state.today + 1 + index).map((day) => ({
              day: dayText(day),
              steps: all.filter((each) => each.dueDay === day).length
            })),
            running: state.running === undefined ? null : SessionId.make(state.running)
          })
        })

      // Starts a set of the steps due with the timing asked for. Each Sibling
      // step picks its Sibling now; one with none left is skipped, stored
      // with a note.
      const start = (caller: Caller, timed: boolean) =>
        Effect.gen(function*() {
          const state = yield* errorLog.retryState(caller.profileId)
          if (state.running !== undefined) return yield* new RetriesRunning({ id: SessionId.make(state.running) })
          const wanted = dueOf(state).filter((each) => each.dueDay <= state.today && each.timed === timed)
          if (wanted.length === 0) return yield* new NoRetriesDue({ skipped: 0, held: 0 })
          const held = yield* run(heldBySections(caller.profileId))
          const seen = yield* run(seenBy(caller.profileId))
          const resolve = yield* run(mergeTargets)
          const pool = yield* run(publishedPool)
          const now = yield* Clock.currentTimeMillis
          const plan = planRetries(
            wanted.map((each) => ({
              step: each.step,
              target: {
                id: each.questionId,
                questionType: each.question.questionType,
                primarySkill: each.question.primarySkill,
                secondarySkills: each.question.secondarySkills,
                difficulty: each.question.difficulty
              }
            })),
            { held, seen, pool, resolve, salt: String(now) }
          )
          for (const skip of plan.skipped) {
            yield* run(db.insert(retrySkips).values({
              id: crypto.randomUUID(),
              profileId: caller.profileId,
              questionId: skip.target.id,
              step: skip.step,
              note: NoSiblingNote,
              createdAt: now
            }))
          }
          if (plan.items.length === 0) {
            return yield* new NoRetriesDue({ skipped: plan.skipped.length, held: plan.waiting.length })
          }
          return yield* practice.startRetries(caller, plan.items, timed)
        }).pipe(oneAtATime)

      return Retries.of({ due, start })
    })
  )
}
