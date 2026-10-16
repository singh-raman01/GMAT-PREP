import { Clock, Context, Effect, Layer } from "effect"
import { PracticeView, SessionId } from "../../api/Practice.ts"
import { NoRetriesDue, RetriesRunning, RetriesView, RetryDue } from "../../api/Retries.ts"
import { Db } from "../db/Database.ts"
import { retrySkips } from "../db/schema.ts"
import { heldBySections, mergeTargets, publishedPool, seenBy } from "../practice/history.ts"
import { type Caller, Practice } from "../practice/Practice.ts"
import { ErrorLog, type RetryState } from "./ErrorLog.ts"
import type { Step } from "./ladder.ts"
import type { RetryItem } from "./retryConfig.ts"
import { pickSibling } from "./siblings.ts"

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
    if (entry.view.status !== "open" || ladder.step === null || ladder.dueDay === null) return []
    const timed = ladder.step > 1 || entry.ladder.reasons.includes("slow")
    return [{ ...entry, step: ladder.step, dueDay: ladder.dueDay, timed }]
  }).toSorted((a, b) => a.dueDay - b.dueDay || a.view.lastMissedAt - b.view.lastMissedAt)

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
      const run = <A, E>(effect: Effect.Effect<A, E, Db>) => effect.pipe(Effect.provideService(Db, db), Effect.orDie)

      const due = (profileId: string) =>
        Effect.gen(function*() {
          const state = yield* errorLog.retryState(profileId)
          const all = dueOf(state)
          const today = all.filter((each) => each.dueDay <= state.today)
          return new RetriesView({
            due: today.map((each) =>
              new RetryDue({
                questionId: each.view.questionId,
                step: each.step,
                questionType: each.view.questionType,
                primarySkill: each.view.primarySkill,
                reasons: each.ladder.reasons,
                timed: each.timed,
                dueOn: dayText(each.dueDay)
              })
            ),
            upcoming: Array.from({ length: Ahead }, (_, index) => state.today + 1 + index).map((day) => ({
              day: dayText(day),
              steps: all.filter((each) => each.dueDay === day).length
            })),
            running: state.running === undefined ? null : SessionId.make(state.running)
          })
        })

      // Starts a set of the steps due with the timing asked for. A Sibling
      // step picks its Sibling now, unseen and not already in this set; with
      // none left, the step is skipped with a note. A Question a running
      // Sectional or Mock holds waits for it to end.
      const start = (caller: Caller, timed: boolean) =>
        Effect.gen(function*() {
          const state = yield* errorLog.retryState(caller.profileId)
          if (state.running !== undefined) return yield* new RetriesRunning({ id: SessionId.make(state.running) })
          const wanted = dueOf(state).filter((each) => each.dueDay <= state.today && each.timed === timed)
          if (wanted.length === 0) return yield* new NoRetriesDue()
          const held = yield* run(heldBySections(caller.profileId))
          const seen = yield* run(seenBy(caller.profileId))
          const resolve = yield* run(mergeTargets)
          const pool = yield* run(publishedPool)
          const now = yield* Clock.currentTimeMillis
          const items: Array<RetryItem> = []
          for (const each of wanted) {
            const entry = each.view.questionId
            if (each.step === 1) {
              if (!held.has(resolve(entry))) items.push({ entry, step: 1, questionId: entry })
              continue
            }
            const taken = new Set([...seen, ...held, ...items.map((item) => item.questionId)])
            const sibling = pickSibling(pool, taken, {
              id: entry,
              questionType: each.question.questionType,
              primarySkill: each.question.primarySkill,
              secondarySkills: each.secondarySkills,
              difficulty: each.question.difficulty
            }, `${entry}|${each.step}|${now}`)
            if (sibling === undefined) {
              yield* run(db.insert(retrySkips).values({
                id: crypto.randomUUID(),
                profileId: caller.profileId,
                questionId: entry,
                step: each.step,
                note: NoSiblingNote,
                createdAt: now
              }))
              continue
            }
            items.push({ entry, step: each.step, questionId: sibling.id })
          }
          if (items.length === 0) return yield* new NoRetriesDue()
          return yield* practice.startRetries(caller, items, timed)
        })

      return Retries.of({ due, start })
    })
  )
}
