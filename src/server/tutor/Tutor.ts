import { and, asc, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm"
import { Clock, Context, Effect, Fiber, Layer, Option, Schema, Semaphore } from "effect"
import { joinedKey } from "../../api/keys.ts"
import { QuestionId } from "../../api/Review.ts"
import {
  ProblemReportView,
  TutorCapReached,
  TutorExchange,
  TutorNotSetUp,
  TutorQuestionClosed,
  TutorRefused,
  TutorReplyInvalid,
  TutorSpendView,
  type TutorState,
  TutorUnavailable,
  TutorView
} from "../../api/Tutor.ts"
import { explanationFits, loadQuestion } from "../books/enrichment.ts"
import { Db } from "../db/Database.ts"
import {
  approaches,
  llmCalls,
  parts,
  problemReports,
  questions,
  responses,
  reviewItems,
  sessions,
  settings,
  tutorMessages
} from "../db/schema.ts"
import { ErrorLog, type LearningHistory } from "../learning/ErrorLog.ts"
import { LlmAdapter, SpendCapReached } from "../llm/LlmAdapter.ts"
import { namesOf } from "../practice/content.ts"
import { heldBySections, isCorrect, keysOf, mergeTargets } from "../practice/history.ts"
import { monthStart } from "../review/Overview.ts"
import { gatherReports, openReportItem } from "../review/reportItems.ts"
import { ApiKeyStore } from "../settings/ApiKeyStore.ts"
import { missingSettings, Settings } from "../settings/Settings.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import {
  KeptExchanges,
  messageKey,
  ReplyLimit,
  type TutorContext,
  TutorPromptVersion,
  TutorReply,
  tutorSystem,
  tutorUser
} from "./prompt.ts"

// Tutor Chat and Problem Reports (docs/design.md, decisions 103 to 108).

// Dollars a month Tutor Chat may spend until the Curator sets another cap.
export const DefaultTutorCap = 5
// A Learner waits for the reply, so a call down or rate limited is sent
// twice at most.
const TutorAttempts = 2
// The exchanges a view returns at once, the latest last.
export const TutorPage = 30
// About four characters a token, as the adapter counts when an API reports
// no usage.
const tokensOf = (characters: number) => Math.ceil(characters / 4)

const CapKey = "tutor-cap"
const decodeCap = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Number))

// A Session that shows how its answers went, as the Error Log reads them: an
// untimed Practice Set at once, a timed one once it ends, a Sectional once it
// closes, and a Mock's Section once the Mock is over.
const shownSession = or(
  and(eq(sessions.kind, "practice"), or(eq(sessions.timed, false), eq(sessions.status, "finished"))),
  and(eq(sessions.kind, "sectional"), eq(sessions.status, "finished")),
  and(
    eq(sessions.kind, "mock-section"),
    eq(sessions.status, "finished"),
    sql`exists (select 1 from sessions as mock where mock.id = json_extract(sessions.config, '$.mock.id') and mock.status = 'finished')`
  )
)

const messageRowid = sql<number>`${tutorMessages}.rowid`

export class Tutor extends Context.Service<Tutor, {
  conversation(profileId: string, questionId: string, before?: string): Effect.Effect<TutorView, TutorQuestionClosed>
  ask(
    profileId: string,
    questionId: string,
    message: string
  ): Effect.Effect<
    TutorView,
    TutorQuestionClosed | TutorCapReached | TutorNotSetUp | TutorUnavailable | TutorRefused | TutorReplyInvalid
  >
  myReport(profileId: string, questionId: string): Effect.Effect<ProblemReportView | null>
  report(profileId: string, questionId: string, text: string): Effect.Effect<ProblemReportView, TutorQuestionClosed>
  reports(profileId: string): Effect.Effect<ReadonlyArray<ProblemReportView>>
  readonly spend: Effect.Effect<TutorSpendView>
  saveCap(cap: number): Effect.Effect<TutorSpendView>
}>()("gmat-prep/server/Tutor") {
  static readonly layer = Layer.effect(
    Tutor,
    Effect.gen(function*() {
      const db = yield* Db
      const llm = yield* LlmAdapter
      const settingsService = yield* Settings
      const keys = yield* ApiKeyStore
      const errorLog = yield* ErrorLog
      const names = namesOf((yield* Taxonomy).view)
      // Model calls run in fibers of the server's own, which last as long as it does.
      const scope = yield* Effect.scope
      const run = <A, E>(effect: Effect.Effect<A, E, Db>) => effect.pipe(Effect.provideService(Db, db), Effect.orDie)

      const cap = Effect.gen(function*() {
        const [row] = yield* db.select().from(settings).where(eq(settings.key, CapKey)).pipe(Effect.orDie)
        return row === undefined ? DefaultTutorCap : Option.getOrElse(decodeCap(row.value), () => DefaultTutorCap)
      })

      // Spent on Tutor Chat this calendar month in the app's time zone, from
      // the recorded calls.
      const month = Effect.gen(function*() {
        const from = monthStart(yield* Clock.currentTimeMillis)
        const [row] = yield* db.select({ spent: sql<number | null>`sum(${llmCalls.cost})` }).from(llmCalls)
          .where(and(eq(llmCalls.task, "tutor-chat"), gte(llmCalls.createdAt, from))).pipe(Effect.orDie)
        return { cap: yield* cap, spent: Number(row?.spent ?? 0), from }
      })

      const spend = Effect.gen(function*() {
        const now = yield* month
        // A refusal stands until a later call goes through.
        const [latest] = yield* db.select({ outcome: llmCalls.outcome, detail: llmCalls.detail, at: llmCalls.createdAt })
          .from(llmCalls)
          .where(and(eq(llmCalls.task, "tutor-chat"), inArray(llmCalls.outcome, ["ok", "invalid", "refused"])))
          .orderBy(desc(llmCalls.createdAt), desc(sql`${llmCalls}.rowid`)).limit(1).pipe(Effect.orDie)
        return new TutorSpendView({
          cap: now.cap,
          spent: now.spent,
          monthFrom: now.from,
          refused: latest?.outcome === "refused" ? { at: latest.at, detail: latest.detail ?? "" } : null
        })
      })

      const saveCap = (value: number) =>
        Effect.gen(function*() {
          const updatedAt = yield* Clock.currentTimeMillis
          yield* db.insert(settings).values({ key: CapKey, value: JSON.stringify(value), updatedAt })
            .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(value), updatedAt } })
            .pipe(Effect.orDie)
          return yield* spend
        })

      const setupNow = Effect.gen(function*() {
        const missing = missingSettings(yield* settingsService.llm, Option.isSome(yield* keys.read), "tutor-chat")
        if (missing.length > 0) return { state: "not-set-up" as TutorState, missing }
        const now = yield* month
        return { state: (now.spent >= now.cap ? "cap-reached" : "open") as TutorState, missing: [] as ReadonlyArray<string> }
      })

      // Calls in flight, each at the estimate it started with: a call starts
      // only while the month's spend, with these, is under the cap, so
      // messages sent together cannot all start below it (decision 106).
      const inFlight = new Map<string, number>()
      const reserved = (besides?: string) => {
        let total = 0
        for (const [id, estimate] of inFlight) if (id !== besides) total += estimate
        return total
      }
      const admission = yield* Semaphore.make(1)
      const admit = (estimate: number) =>
        admission.withPermits(1)(Effect.gen(function*() {
          const now = yield* month
          if (now.spent + reserved() >= now.cap) return yield* new TutorCapReached()
          const id = crypto.randomUUID()
          yield* Effect.sync(() => inFlight.set(id, estimate))
          return id
        }))
      // The retry after an invalid reply starts on the same terms, with the
      // first reply now in the spend.
      const retryCheck = (id: string) =>
        admission.withPermits(1)(Effect.gen(function*() {
          const now = yield* month
          if (now.spent + reserved(id) >= now.cap) return yield* new SpendCapReached({ spend: now.spent, cap: now.cap })
        }))
      const release = (id: string) => Effect.sync(() => inFlight.delete(id))

      // A call's prompt at its length, and the longest reply allowed.
      const estimateOf = (user: string) =>
        Effect.gen(function*() {
          const configured = yield* settingsService.llm
          const model = configured.models["tutor-chat"]
          const price = model === undefined ? undefined : configured.prices[model]
          if (price === undefined) return 0
          return (tokensOf(tutorSystem.length + user.length) * price.input + tokensOf(ReplyLimit) * price.output) / 1_000_000
        })

      // The Question the Profile asks about, as the one it counts as after a
      // merge, once a Session that shows how it went holds the Profile's
      // answer to it and no running Sectional or Mock holds it. It reads only
      // those answers, not the Profile's whole history.
      const access = (profileId: string, questionId: string) =>
        Effect.gen(function*() {
          const resolve = yield* run(mergeTargets)
          const target = resolve(questionId)
          const merged = yield* db.select({ id: questions.id }).from(questions).where(isNotNull(questions.mergedInto))
            .pipe(Effect.orDie)
          const counted = [target, ...merged.map((row) => row.id).filter((id) => id !== target && resolve(id) === target)]
          const [answered] = yield* db.select({ id: responses.id }).from(responses)
            .innerJoin(sessions, eq(sessions.id, responses.sessionId))
            .where(and(eq(responses.profileId, profileId), inArray(responses.questionId, counted), shownSession))
            .limit(1).pipe(Effect.orDie)
          if (answered === undefined) return yield* new TutorQuestionClosed({ reason: "not-answered" })
          if ((yield* run(heldBySections(profileId))).has(target)) return yield* new TutorQuestionClosed({ reason: "held" })
          const [question] = yield* db.select({ status: questions.status }).from(questions).where(eq(questions.id, target))
            .pipe(Effect.orDie)
          return { target, withdrawn: question?.status === "withdrawn" }
        })

      const keyOf = (target: string) =>
        db.select({ key: parts.key }).from(parts).where(eq(parts.questionId, target)).orderBy(asc(parts.position)).pipe(
          Effect.orDie,
          Effect.map((rows) => joinedKey(rows.map((row) => row.key)))
        )

      const mine = (profileId: string, target: string) =>
        and(eq(tutorMessages.profileId, profileId), eq(tutorMessages.questionId, target))

      // The latest exchanges, or those before one of them, the latest last.
      const pageOf = (profileId: string, target: string, before: string | undefined) =>
        Effect.gen(function*() {
          const [cursor] = before === undefined ? [undefined] : yield* db.select({
            askedAt: tutorMessages.askedAt,
            rowid: messageRowid
          }).from(tutorMessages).where(and(mine(profileId, target), eq(tutorMessages.id, before))).pipe(Effect.orDie)
          if (before !== undefined && cursor === undefined) return { rows: [], earlier: false }
          const rows = yield* db.select().from(tutorMessages)
            .where(and(
              mine(profileId, target),
              cursor === undefined ? undefined : sql`(${tutorMessages.askedAt}, ${messageRowid}) < (${cursor.askedAt}, ${cursor.rowid})`
            ))
            .orderBy(desc(tutorMessages.askedAt), desc(messageRowid)).limit(TutorPage + 1).pipe(Effect.orDie)
          return { rows: rows.slice(0, TutorPage).reverse(), earlier: rows.length > TutorPage }
        })

      const viewOf = (profileId: string, target: string, withdrawn: boolean, before?: string) =>
        Effect.gen(function*() {
          const page = yield* pageOf(profileId, target, before)
          const key = yield* keyOf(target)
          const setup = withdrawn ? { state: "withdrawn" as TutorState, missing: [] } : yield* setupNow
          return new TutorView({
            questionId: QuestionId.make(target),
            exchanges: page.rows.map((row) =>
              new TutorExchange({
                id: row.id,
                message: row.message,
                reply: row.reply,
                at: row.askedAt,
                reused: row.repeats > 0 || row.reusedFrom !== null,
                oldKey: row.answerKey !== null && row.answerKey !== key ? row.answerKey : null
              })
            ),
            earlier: page.earlier,
            state: setup.state,
            missing: setup.missing
          })
        })

      const conversation = (profileId: string, questionId: string, before?: string) =>
        Effect.gen(function*() {
          const { target, withdrawn } = yield* access(profileId, questionId)
          return yield* viewOf(profileId, target, withdrawn, before)
        })

      // What the model is told about the Question and this Learner.
      const contextOf = (
        history: LearningHistory,
        target: string,
        earlier: ReadonlyArray<{ readonly message: string; readonly reply: string }>
      ) =>
        Effect.gen(function*() {
          const loaded = yield* loadQuestion(target).pipe(Effect.provideService(Db, db), Effect.orDie)
          if (loaded === undefined) return undefined
          const partKeys = (yield* run(keysOf([target]))).get(target) ?? []
          const key = loaded.text.key
          // Only the Approaches that reach the current key, fastest first, as
          // the Debrief shows them.
          const ways = (yield* db.select({
            strategy: approaches.strategy,
            steps: approaches.steps,
            validWhen: approaches.validWhen,
            answer: approaches.answer,
            expectedSeconds: approaches.expectedSeconds
          }).from(approaches).where(eq(approaches.questionId, target)).orderBy(asc(approaches.position)).pipe(Effect.orDie))
            .filter((way) => key !== null && way.answer === key)
            .toSorted((a, b) => a.expectedSeconds - b.expectedSeconds)
          const answered = history.responses.filter((response) =>
            history.resolve(response.questionId) === target && history.sessions.get(response.sessionId)?.shown === true
          )
          const bySession = Map.groupBy(answered, (response) => response.sessionId)
          const finals = [...bySession.values()].map((each) => each.toSorted((a, b) => b.seq - a.seq)[0]!)
            .toSorted((a, b) => a.at - b.at)
          const mistakesOf = new Map(history.misses.map((each) => [each.miss.responseId, each.mistakeTypes] as const))
          const answers = finals.map((final) => ({
            answer: final.kind === "time-out"
              ? "no answer, time ran out"
              : final.selection.length === 1
              ? final.selection[0]!.choice
              : final.selection.map((choice) => `part ${choice.part + 1} ${choice.choice}`).join(", "),
            correct: final.kind !== "time-out" && isCorrect(final.selection, partKeys),
            mistakes: (mistakesOf.get(final.id) ?? []).flatMap((type) => (type === null ? [] : [names.named(type).name]))
          }))
          const skillId = history.summaries.get(target)?.primarySkill ?? null
          const counts = new Map<string, number>()
          if (skillId !== null) {
            for (const each of history.misses) {
              if (history.summaries.get(each.miss.questionId)?.primarySkill !== skillId) continue
              for (const type of each.mistakeTypes) {
                const name = type === null ? "not yet labelled" : names.named(type).name
                counts.set(name, (counts.get(name) ?? 0) + 1)
              }
            }
          }
          const context: TutorContext = {
            // The Book's explanation teaches the old answer once the key changed.
            question: explanationFits(loaded) ? loaded.text : { ...loaded.text, explanation: null },
            approaches: ways.map((way) => ({ strategy: names.named(way.strategy).name, steps: way.steps, validWhen: way.validWhen })),
            answers,
            skill: skillId === null
              ? null
              : { name: names.named(skillId).name, misses: [...counts].map(([mistake, count]) => ({ mistake, count })) },
            earlier
          }
          return context
        })

      // One call for a message, and its reply stored with the key it was
      // written against.
      const answer = (
        id: string,
        asked: {
          readonly profileId: string
          readonly target: string
          readonly text: string
          readonly messageKey: string
          readonly key: string | null
          readonly user: string
        }
      ) =>
        Effect.gen(function*() {
          const reply = yield* llm.call({
            task: "tutor-chat",
            promptVersion: TutorPromptVersion,
            system: tutorSystem,
            user: asked.user,
            output: TutorReply,
            attempts: TutorAttempts,
            retryCheck: retryCheck(id)
          }).pipe(
            Effect.catchTags({
              LlmInvalidReply: () => Effect.fail(new TutorReplyInvalid()),
              LlmUnavailable: () => Effect.fail(new TutorUnavailable()),
              LlmRefused: () => Effect.fail(new TutorRefused()),
              LlmNotConfigured: (failure) => Effect.fail(new TutorNotSetUp({ missing: failure.missing })),
              SpendCapReached: () => Effect.fail(new TutorCapReached())
            })
          )
          const at = yield* Clock.currentTimeMillis
          yield* db.insert(tutorMessages).values({
            id: crypto.randomUUID(),
            profileId: asked.profileId,
            questionId: asked.target,
            message: asked.text,
            messageKey: asked.messageKey,
            reply: reply.value.reply.trim(),
            answerKey: asked.key,
            reusedFrom: null,
            repeats: 0,
            askedAt: at,
            model: reply.model,
            promptVersion: reply.promptVersion,
            tokensIn: reply.tokensIn,
            tokensOut: reply.tokensOut,
            cost: reply.cost,
            createdAt: at
          }).pipe(Effect.orDie)
        })

      const ask = (profileId: string, questionId: string, message: string) =>
        Effect.gen(function*() {
          const { target, withdrawn } = yield* access(profileId, questionId)
          if (withdrawn) return yield* new TutorQuestionClosed({ reason: "withdrawn" })
          const text = message.trim()
          const asked = messageKey(text)
          const key = yield* keyOf(target)
          // The same message asked before about the same key, under this
          // prompt, gets its stored reply with no call, and moves to now.
          const [before] = key === null ? [] : yield* db.select({ id: tutorMessages.id }).from(tutorMessages)
            .where(and(
              mine(profileId, target),
              eq(tutorMessages.messageKey, asked),
              eq(tutorMessages.answerKey, key),
              eq(tutorMessages.promptVersion, TutorPromptVersion)
            ))
            .orderBy(asc(tutorMessages.createdAt)).limit(1).pipe(Effect.orDie)
          if (before !== undefined) {
            const now = yield* Clock.currentTimeMillis
            yield* db.update(tutorMessages).set({ repeats: sql`${tutorMessages.repeats} + 1`, askedAt: now })
              .where(eq(tutorMessages.id, before.id)).pipe(Effect.orDie)
            return yield* viewOf(profileId, target, false)
          }
          const setup = yield* setupNow
          if (setup.state === "not-set-up") return yield* new TutorNotSetUp({ missing: setup.missing })
          if (setup.state === "cap-reached") return yield* new TutorCapReached()
          // Exchanges written for a key the Curator has since replaced argue
          // for the old answer, so only those about this key go back to the model.
          const earlier = key === null ? [] : (yield* db.select({ message: tutorMessages.message, reply: tutorMessages.reply })
            .from(tutorMessages).where(and(mine(profileId, target), eq(tutorMessages.answerKey, key)))
            .orderBy(desc(tutorMessages.askedAt), desc(messageRowid)).limit(KeptExchanges).pipe(Effect.orDie)).toReversed()
          const context = yield* contextOf(yield* errorLog.history(profileId), target, earlier)
          if (context === undefined) return yield* new TutorQuestionClosed({ reason: "not-answered" })
          const user = tutorUser(context, text)
          const estimate = yield* estimateOf(user)
          // The call and its record run outside the request, so a Learner who
          // closes the tab or reloads cannot cut off a call the API has
          // taken: its cost is recorded and its reply shows next time.
          const answering = yield* Effect.forkIn(
            Effect.acquireUseRelease(
              admit(estimate),
              (id) => answer(id, { profileId, target, text, messageKey: asked, key, user }),
              release
            ),
            scope
          )
          yield* Fiber.join(answering)
          return yield* viewOf(profileId, target, false)
        })

      const reportView = (
        row: typeof problemReports.$inferSelect,
        stem: string,
        item: { readonly decision: string | null; readonly decidedAt: number | null } | undefined
      ) =>
        new ProblemReportView({
          id: row.id,
          questionId: QuestionId.make(row.questionId),
          stem,
          text: row.text,
          at: row.createdAt,
          decision: item?.decision ?? null,
          decidedAt: item?.decidedAt ?? null
        })

      // The Profile's report on the Question that waits for the Curator.
      const myReport = (profileId: string, questionId: string) =>
        Effect.gen(function*() {
          const target = (yield* run(mergeTargets))(questionId)
          const [row] = yield* db.select({ report: problemReports, stem: questions.stem }).from(problemReports)
            .innerJoin(reviewItems, eq(reviewItems.id, problemReports.reviewItemId))
            .innerJoin(questions, eq(questions.id, reviewItems.questionId))
            .where(and(eq(problemReports.profileId, profileId), eq(reviewItems.questionId, target), eq(reviewItems.status, "open")))
            .orderBy(desc(problemReports.createdAt)).limit(1).pipe(Effect.orDie)
          return row === undefined ? null : reportView(row.report, row.stem, undefined)
        })

      // A report joins the Question's open report item, or opens one; the
      // Question stays as it is until the Curator decides (decision 107).
      // While the item is open, the Profile's new words replace its earlier
      // ones, so each Learner has one report there.
      const report = (profileId: string, questionId: string, text: string) =>
        Effect.gen(function*() {
          const { target, withdrawn } = yield* access(profileId, questionId)
          if (withdrawn) return yield* new TutorQuestionClosed({ reason: "withdrawn" })
          const words = text.trim()
          const now = yield* Clock.currentTimeMillis
          const id = yield* db.transaction(() =>
            Effect.gen(function*() {
              const open = yield* openReportItem(target)
              const itemId = open ?? crypto.randomUUID()
              if (open === undefined) {
                yield* db.insert(reviewItems).values({
                  id: itemId,
                  questionId: target,
                  bookId: null,
                  page: null,
                  reasons: "[]",
                  relatedQuestionId: null,
                  status: "open",
                  decision: null,
                  kind: "report",
                  createdAt: now,
                  decidedAt: null
                })
              }
              const [earlier] = yield* db.select({ id: problemReports.id }).from(problemReports)
                .where(and(eq(problemReports.profileId, profileId), eq(problemReports.reviewItemId, itemId))).limit(1)
              const reportId = earlier?.id ?? crypto.randomUUID()
              if (earlier === undefined) {
                yield* db.insert(problemReports).values({
                  id: reportId,
                  profileId,
                  questionId: target,
                  text: words,
                  reviewItemId: itemId,
                  createdAt: now
                })
              } else {
                yield* db.update(problemReports).set({ text: words, createdAt: now }).where(eq(problemReports.id, reportId))
              }
              yield* gatherReports(itemId)
              return reportId
            }).pipe(Effect.provideService(Db, db))
          ).pipe(Effect.orDie)
          const [row] = yield* db.select({ report: problemReports, stem: questions.stem }).from(problemReports)
            .innerJoin(questions, eq(questions.id, problemReports.questionId))
            .where(eq(problemReports.id, id)).pipe(Effect.orDie)
          return reportView(row!.report, row!.stem, undefined)
        })

      const reports = (profileId: string) =>
        Effect.gen(function*() {
          const rows = yield* db.select({
            report: problemReports,
            stem: questions.stem,
            decision: reviewItems.decision,
            decidedAt: reviewItems.decidedAt
          }).from(problemReports)
            .innerJoin(questions, eq(questions.id, problemReports.questionId))
            .leftJoin(reviewItems, eq(reviewItems.id, problemReports.reviewItemId))
            .where(eq(problemReports.profileId, profileId))
            .orderBy(desc(problemReports.createdAt), desc(sql`${problemReports}.rowid`)).pipe(Effect.orDie)
          return rows.map((row) => reportView(row.report, row.stem, { decision: row.decision, decidedAt: row.decidedAt }))
        })

      return Tutor.of({ conversation, ask, myReport, report, reports, spend, saveCap })
    })
  )
}
