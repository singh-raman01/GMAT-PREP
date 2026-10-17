import { and, asc, desc, eq, gte, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { joinedKey } from "../../api/keys.ts"
import { QuestionId } from "../../api/Review.ts"
import {
  ProblemReportView,
  TutorCapReached,
  TutorExchange,
  TutorNotSetUp,
  TutorQuestionClosed,
  TutorReplyInvalid,
  TutorSpendView,
  type TutorState,
  TutorUnavailable,
  TutorView
} from "../../api/Tutor.ts"
import { loadQuestion } from "../books/enrichment.ts"
import { Db } from "../db/Database.ts"
import { approaches, llmCalls, problemReports, reviewItems, settings, tutorMessages } from "../db/schema.ts"
import { ErrorLog } from "../learning/ErrorLog.ts"
import { LlmAdapter } from "../llm/LlmAdapter.ts"
import { namesOf } from "../practice/content.ts"
import { heldBySections, isCorrect, keysOf } from "../practice/history.ts"
import { monthStart } from "../review/Overview.ts"
import { ApiKeyStore } from "../settings/ApiKeyStore.ts"
import { missingSettings, Settings } from "../settings/Settings.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"
import { KeptExchanges, messageKey, type TutorContext, TutorPromptVersion, TutorReply, tutorSystem, tutorUser } from "./prompt.ts"

// Tutor Chat and Problem Reports (docs/design.md, decisions 103 to 108).

// Dollars a month Tutor Chat may spend until the Curator sets another cap.
export const DefaultTutorCap = 5
// A Learner waits for the reply, so a call down or rate limited is sent
// twice at most.
const TutorAttempts = 2

const CapKey = "tutor-cap"
const decodeCap = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Number))

export class Tutor extends Context.Service<Tutor, {
  conversation(profileId: string, questionId: string): Effect.Effect<TutorView, TutorQuestionClosed>
  ask(
    profileId: string,
    questionId: string,
    message: string
  ): Effect.Effect<TutorView, TutorQuestionClosed | TutorCapReached | TutorNotSetUp | TutorUnavailable | TutorReplyInvalid>
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
      const run = <A, E>(effect: Effect.Effect<A, E, Db>) => effect.pipe(Effect.provideService(Db, db), Effect.orDie)

      const cap = Effect.gen(function*() {
        const [row] = yield* db.select().from(settings).where(eq(settings.key, CapKey)).pipe(Effect.orDie)
        return row === undefined ? DefaultTutorCap : Option.getOrElse(decodeCap(row.value), () => DefaultTutorCap)
      })

      const spend = Effect.gen(function*() {
        const from = monthStart(yield* Clock.currentTimeMillis)
        const [row] = yield* db.select({ spent: sql<number | null>`sum(${llmCalls.cost})` }).from(llmCalls)
          .where(and(eq(llmCalls.task, "tutor-chat"), gte(llmCalls.createdAt, from))).pipe(Effect.orDie)
        return new TutorSpendView({ cap: yield* cap, spent: Number(row?.spent ?? 0), monthFrom: from })
      })

      const saveCap = (value: number) =>
        Effect.gen(function*() {
          const updatedAt = yield* Clock.currentTimeMillis
          yield* db.insert(settings).values({ key: CapKey, value: JSON.stringify(value), updatedAt })
            .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(value), updatedAt } })
            .pipe(Effect.orDie)
          return yield* spend
        })

      const stateNow = Effect.gen(function*() {
        const missing = missingSettings(yield* settingsService.llm, Option.isSome(yield* keys.read), "tutor-chat")
        if (missing.length > 0) return "not-set-up" as TutorState
        const now = yield* spend
        return (now.spent >= now.cap ? "cap-reached" : "open") as TutorState
      })

      // The Question the Profile asks about, as the one it counts as, once
      // a Session that shows how it went holds an answer to it and no
      // running Sectional or Mock holds it.
      const access = (profileId: string, questionId: string) =>
        Effect.gen(function*() {
          const history = yield* errorLog.history(profileId)
          const target = history.resolve(questionId)
          const answered = history.responses.filter((response) =>
            history.resolve(response.questionId) === target && history.sessions.get(response.sessionId)?.shown === true
          )
          if (answered.length === 0) return yield* new TutorQuestionClosed()
          if ((yield* run(heldBySections(profileId))).has(target)) return yield* new TutorQuestionClosed()
          return { history, target, answered }
        })

      const exchangesOf = (profileId: string, target: string) =>
        db.select().from(tutorMessages)
          .where(and(eq(tutorMessages.profileId, profileId), eq(tutorMessages.questionId, target)))
          .orderBy(asc(tutorMessages.createdAt), asc(sql`${tutorMessages}.rowid`)).pipe(Effect.orDie)

      const viewOf = (profileId: string, target: string) =>
        Effect.gen(function*() {
          const rows = yield* exchangesOf(profileId, target)
          return new TutorView({
            questionId: QuestionId.make(target),
            exchanges: rows.map((row) =>
              new TutorExchange({ id: row.id, message: row.message, reply: row.reply, at: row.createdAt, reused: row.reusedFrom !== null })
            ),
            state: yield* stateNow
          })
        })

      const conversation = (profileId: string, questionId: string) =>
        Effect.gen(function*() {
          const { target } = yield* access(profileId, questionId)
          return yield* viewOf(profileId, target)
        })

      // What the model is told about the Question and this Learner.
      const contextOf = (
        found: Effect.Success<ReturnType<typeof access>>,
        earlier: ReadonlyArray<{ readonly message: string; readonly reply: string }>
      ) =>
        Effect.gen(function*() {
          const { history, target, answered } = found
          const loaded = yield* loadQuestion(target).pipe(Effect.provideService(Db, db), Effect.orDie)
          if (loaded === undefined) return undefined
          const partKeys = (yield* run(keysOf([target]))).get(target) ?? []
          // Only the Approaches that reach the current key, as the Debrief shows.
          const key = joinedKey(partKeys.map((part) => part.key))
          const ways = (yield* db.select({
            strategy: approaches.strategy,
            steps: approaches.steps,
            validWhen: approaches.validWhen,
            answer: approaches.answer
          }).from(approaches).where(eq(approaches.questionId, target)).orderBy(asc(approaches.position)).pipe(Effect.orDie))
            .filter((way) => key !== null && way.answer === key)
          const bySession = Map.groupBy(answered, (response) => response.sessionId)
          const finals = [...bySession.values()].map((responses) => responses.toSorted((a, b) => b.seq - a.seq)[0]!)
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
            question: loaded.text,
            approaches: ways.map((way) => ({ strategy: names.named(way.strategy).name, steps: way.steps, validWhen: way.validWhen })),
            answers,
            skill: skillId === null
              ? null
              : { name: names.named(skillId).name, misses: [...counts].map(([mistake, count]) => ({ mistake, count })) },
            earlier
          }
          return context
        })

      const ask = (profileId: string, questionId: string, message: string) =>
        Effect.gen(function*() {
          const found = yield* access(profileId, questionId)
          const { target } = found
          const text = message.trim()
          const key = messageKey(text)
          const now = yield* Clock.currentTimeMillis
          // The same message asked before gets its stored reply.
          const [asked] = yield* db.select().from(tutorMessages)
            .where(and(eq(tutorMessages.profileId, profileId), eq(tutorMessages.questionId, target), eq(tutorMessages.messageKey, key)))
            .orderBy(asc(tutorMessages.createdAt)).limit(1).pipe(Effect.orDie)
          if (asked !== undefined) {
            yield* db.insert(tutorMessages).values({
              id: crypto.randomUUID(),
              profileId,
              questionId: target,
              message: text,
              messageKey: key,
              reply: asked.reply,
              reusedFrom: asked.reusedFrom ?? asked.id,
              model: asked.model,
              promptVersion: asked.promptVersion,
              tokensIn: 0,
              tokensOut: 0,
              cost: 0,
              createdAt: now
            }).pipe(Effect.orDie)
            return yield* viewOf(profileId, target)
          }
          const state = yield* stateNow
          if (state === "not-set-up") return yield* new TutorNotSetUp()
          if (state === "cap-reached") return yield* new TutorCapReached()
          const earlier = (yield* exchangesOf(profileId, target)).slice(-KeptExchanges)
            .map((row) => ({ message: row.message, reply: row.reply }))
          const context = yield* contextOf(found, earlier)
          if (context === undefined) return yield* new TutorQuestionClosed()
          const reply = yield* llm.call({
            task: "tutor-chat",
            promptVersion: TutorPromptVersion,
            system: tutorSystem,
            user: tutorUser(context, text),
            output: TutorReply,
            attempts: TutorAttempts
          }).pipe(
            Effect.catchTags({
              LlmInvalidReply: () => Effect.fail(new TutorReplyInvalid()),
              LlmUnavailable: () => Effect.fail(new TutorUnavailable()),
              LlmRefused: () => Effect.fail(new TutorUnavailable()),
              LlmNotConfigured: () => Effect.fail(new TutorNotSetUp()),
              SpendCapReached: () => Effect.fail(new TutorCapReached())
            })
          )
          yield* db.insert(tutorMessages).values({
            id: crypto.randomUUID(),
            profileId,
            questionId: target,
            message: text,
            messageKey: key,
            reply: reply.value.reply.trim(),
            reusedFrom: null,
            model: reply.model,
            promptVersion: reply.promptVersion,
            tokensIn: reply.tokensIn,
            tokensOut: reply.tokensOut,
            cost: reply.cost,
            createdAt: yield* Clock.currentTimeMillis
          }).pipe(Effect.orDie)
          return yield* viewOf(profileId, target)
        })

      const reportView = (row: typeof problemReports.$inferSelect, item: { readonly decision: string | null; readonly decidedAt: number | null } | undefined) =>
        new ProblemReportView({
          id: row.id,
          questionId: QuestionId.make(row.questionId),
          text: row.text,
          at: row.createdAt,
          decision: item?.decision ?? null,
          decidedAt: item?.decidedAt ?? null
        })

      // A report joins the Question's open review item for reports, or
      // opens one; the Question stays published (decision 107).
      const report = (profileId: string, questionId: string, text: string) =>
        Effect.gen(function*() {
          const { target } = yield* access(profileId, questionId)
          const now = yield* Clock.currentTimeMillis
          const id = crypto.randomUUID()
          const itemId = yield* db.transaction(() =>
            Effect.gen(function*() {
              const open = yield* db.select().from(reviewItems)
                .where(and(eq(reviewItems.questionId, target), eq(reviewItems.status, "open")))
              const reported = open.find((item) =>
                (JSON.parse(item.reasons) as ReadonlyArray<{ readonly code: string }>).some((reason) => reason.code === "problem-report")
              )
              const reason = { code: "problem-report", detail: text.trim() }
              if (reported !== undefined) {
                const reasons = [...(JSON.parse(reported.reasons) as ReadonlyArray<unknown>), reason]
                yield* db.update(reviewItems).set({ reasons: JSON.stringify(reasons) }).where(eq(reviewItems.id, reported.id))
                return reported.id
              }
              const created = crypto.randomUUID()
              yield* db.insert(reviewItems).values({
                id: created,
                questionId: target,
                bookId: null,
                page: null,
                reasons: JSON.stringify([reason]),
                relatedQuestionId: null,
                status: "open",
                decision: null,
                createdAt: now,
                decidedAt: null
              })
              return created
            })
          ).pipe(Effect.orDie)
          yield* db.insert(problemReports).values({
            id,
            profileId,
            questionId: target,
            text: text.trim(),
            reviewItemId: itemId,
            createdAt: now
          }).pipe(Effect.orDie)
          const [row] = yield* db.select().from(problemReports).where(eq(problemReports.id, id)).pipe(Effect.orDie)
          return reportView(row!, undefined)
        })

      const reports = (profileId: string) =>
        Effect.gen(function*() {
          const rows = yield* db.select({ report: problemReports, item: reviewItems }).from(problemReports)
            .leftJoin(reviewItems, eq(reviewItems.id, problemReports.reviewItemId))
            .where(eq(problemReports.profileId, profileId))
            .orderBy(desc(problemReports.createdAt), desc(sql`${problemReports}.rowid`)).pipe(Effect.orDie)
          return rows.map((row) => reportView(row.report, row.item === null ? undefined : row.item))
        })

      return Tutor.of({ conversation, ask, report, reports, spend, saveCap })
    })
  )
}
