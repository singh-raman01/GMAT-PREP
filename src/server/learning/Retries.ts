import { Clock, Context, Effect, Layer, Semaphore } from "effect"
import { targetSecondsFor } from "../../api/targetTimes.ts"
import { Analytics } from "../analytics/Analytics.ts"
import { DebriefShare } from "../plans/build.ts"
import { Settings } from "../settings/Settings.ts"
import { PracticeView, SessionId } from "../../api/Practice.ts"
import { NoRetriesDue, RetriesRunning, RetriesView, RetryDue, RetrySetMax } from "../../api/Retries.ts"
import { QuestionId } from "../../api/Review.ts"
import { Db } from "../db/Database.ts"
import { retrySkips } from "../db/schema.ts"
import { heldBySections, mergeTargets, publishedPool, seenBy } from "../practice/history.ts"
import { namesOf } from "../practice/content.ts"
import { type Caller, Practice } from "../practice/Practice.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { ErrorLog, type RetryState } from "./ErrorLog.ts"
import type { Step } from "./ladder.ts"
import { SlowFactor } from "./misses.ts"
import { planRetries } from "./retryPlan.ts"

// Retries (docs/design.md, "Learning loop"): the Retry Ladder steps due, and
// the Practice Sets that take them. Step 1 of a wrong or guessed entry is
// untimed; step 1 of a slow entry, and each Sibling step, are timed.

const DayMs = 24 * 60 * 60 * 1000
const dayText = (day: number) => new Date(day * DayMs).toISOString().slice(0, 10)

// How many Study Days ahead the upcoming counts look.
const Ahead = 7

export const NoSiblingNote = "No unseen Sibling of its Question Type and Skill was left."

type Due = RetryState["entries"][number] & { readonly step: Step; readonly dueDay: number; readonly timed: boolean }

// A step the Study Plan counts on (decision 86): its Study Day, timing,
// minutes with its Debrief, and the Priority of the Weak Area of its
// Question's primary Skill, 0 for none.
export interface RetryForecast {
  readonly questionId: string
  readonly dueDay: number
  readonly timed: boolean
  readonly minutes: number
  readonly priority: number
}

const dueOf = (state: RetryState): ReadonlyArray<Due> =>
  state.entries.flatMap((entry): Array<Due> => {
    const ladder = entry.ladder.ladder
    if (entry.status !== "open" || ladder.step === null || ladder.dueDay === null) return []
    const timed = ladder.step > 1 || entry.ladder.reasons.includes("slow")
    return [{ ...entry, step: ladder.step, dueDay: ladder.dueDay, timed }]
  }).toSorted((a, b) => a.dueDay - b.dueDay || a.lastMissedAt - b.lastMissedAt)

// A step waits while a running Sectional or Mock holds the entry's
// Question, as the Error Log leaves the entry out then; a step 1 also while
// its Question is out of the Question Bank for a check.
const waits = (due: Due, held: ReadonlySet<string>) =>
  held.has(due.questionId) || (due.step === 1 && due.question.status !== "published")

export interface RetryStart {
  // At most this many steps; RetrySetMax at most.
  readonly limit?: number
  // The Study Plan item it is started from.
  readonly planItemId?: string
}

export class Retries extends Context.Service<Retries, {
  due(profileId: string): Effect.Effect<RetriesView>
  start(caller: Caller, timed: boolean, options?: RetryStart): Effect.Effect<PracticeView, NoRetriesDue | RetriesRunning>
  // Each open entry's next step, for the Study Plan.
  forecast(profileId: string): Effect.Effect<ReadonlyArray<RetryForecast>>
}>()("gmat-prep/server/Retries") {
  static readonly layer = Layer.effect(
    Retries,
    Effect.gen(function*() {
      const db = yield* Db
      const errorLog = yield* ErrorLog
      const practice = yield* Practice
      const analytics = yield* Analytics
      const settings = yield* Settings
      const names = namesOf((yield* Taxonomy).view)
      const run = <A, E>(effect: Effect.Effect<A, E, Db>) => effect.pipe(Effect.provideService(Db, db), Effect.orDie)
      // Two starts at once, from two tabs, make one set.
      const oneAtATime = (yield* Semaphore.make(1)).withPermits(1)

      // The Priority of each Skill that is a Weak Area.
      const prioritiesOf = (profileId: string) =>
        analytics.planAnalytics(profileId).pipe(
          Effect.map((found) =>
            new Map(found.weakAreas.filter((area) => area.kind === "skill").map((area) => [area.id, area.priority] as const))
          )
        )
      // Steps due go by the Priority of the Weak Area of their Question's
      // primary Skill, those with none last, then the longest waiting first.
      const byPriority = (due: ReadonlyArray<Due>, priorities: ReadonlyMap<string, number>) => {
        const priority = (each: Due) => priorities.get(each.question.primarySkill ?? "") ?? -1
        return due.map((each, index) => ({ each, index }))
          .toSorted((a, b) => priority(b.each) - priority(a.each) || a.index - b.index)
          .map(({ each }) => each)
      }

      const due = (profileId: string) =>
        Effect.gen(function*() {
          const state = yield* errorLog.retryState(profileId)
          const all = byPriority(dueOf(state), yield* prioritiesOf(profileId))
          const today = all.filter((each) => each.dueDay <= state.today)
          const held = today.length === 0 ? new Set<string>() : yield* run(heldBySections(profileId))
          // Waiting steps are only counted, so the list never names a
          // Question a running Section holds.
          const ready = today.filter((each) => !waits(each, held))
          const untimed = ready.filter((each) => !each.timed)
          const timed = ready.filter((each) => each.timed)
          const shown = new Set([...untimed.slice(0, RetrySetMax), ...timed.slice(0, RetrySetMax)])
          const named = (id: string) => names.named(id)
          return new RetriesView({
            today: dayText(state.today),
            due: ready.filter((each) => shown.has(each)).map((each) =>
              new RetryDue({
                questionId: QuestionId.make(each.questionId),
                step: each.step,
                questionType: named(each.question.questionType),
                primarySkill: each.question.primarySkill === null ? null : named(each.question.primarySkill),
                reasons: each.ladder.reasons,
                timed: each.timed,
                dueOn: dayText(each.dueDay)
              })
            ),
            untimed: untimed.length,
            timed: timed.length,
            waiting: today.length - ready.length,
            upcoming: Array.from({ length: Ahead }, (_, index) => state.today + 1 + index).map((day) => ({
              day: dayText(day),
              steps: all.filter((each) => each.dueDay === day).length
            })),
            running: state.running === undefined ? null : SessionId.make(state.running)
          })
        })

      // Starts a set of the steps due with the timing asked for, the longest
      // waiting first, up to the set's size. Each Sibling step picks its
      // Sibling now; one with none left is skipped, stored with a note.
      const start = (caller: Caller, timed: boolean, options: RetryStart = {}) =>
        Effect.gen(function*() {
          const state = yield* errorLog.retryState(caller.profileId)
          if (state.running !== undefined) return yield* new RetriesRunning({ id: SessionId.make(state.running) })
          const held = yield* run(heldBySections(caller.profileId))
          // A held entry's later steps wait too; step 1s that wait are kept
          // for the plan to count.
          const wanted = byPriority(dueOf(state), yield* prioritiesOf(caller.profileId)).filter((each) =>
            each.dueDay <= state.today && each.timed === timed && (each.step === 1 || !held.has(each.questionId))
          )
          if (wanted.length === 0) return yield* new NoRetriesDue({ skipped: 0 })
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
                difficulty: each.question.difficulty,
                stimulusId: each.question.stimulusId
              },
              published: each.question.status === "published"
            })),
            { held, seen, pool, resolve, salt: String(now), size: Math.max(1, Math.min(RetrySetMax, options.limit ?? RetrySetMax)) }
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
          if (plan.items.length === 0) return yield* new NoRetriesDue({ skipped: plan.skipped.length })
          // A slow entry's steps pass within 1.5 times the Target Time, so its
          // Questions get that long on the set's clock.
          const slow = new Set(wanted.filter((each) => each.ladder.reasons.includes("slow")).map((each) => each.questionId))
          return yield* practice.startRetries(caller, plan.items, timed, slow, options.planItemId)
        }).pipe(oneAtATime)

      const forecast = (profileId: string) =>
        Effect.gen(function*() {
          const state = yield* errorLog.retryState(profileId)
          const priorities = yield* prioritiesOf(profileId)
          const held = yield* run(heldBySections(profileId))
          const overrides = yield* settings.targetTimes
          return dueOf(state).filter((each) => !waits(each, held)).map((each): RetryForecast => {
            const slow = each.ladder.reasons.includes("slow")
            const seconds = targetSecondsFor(each.question.questionType, overrides) * (slow ? SlowFactor : 1)
            return {
              questionId: each.questionId,
              dueDay: each.dueDay,
              timed: each.timed,
              minutes: Math.ceil((seconds * (1 + DebriefShare)) / 60),
              priority: priorities.get(each.question.primarySkill ?? "") ?? 0
            }
          })
        })

      return Retries.of({ due, start, forecast })
    })
  )
}
