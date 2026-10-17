import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { Api } from "../src/api/Api.ts"
import type { PracticeView } from "../src/api/Practice.ts"
import type { QuestionId } from "../src/api/Review.ts"
import { Db } from "../src/server/db/Database.ts"
import { questions, reviewItems } from "../src/server/db/schema.ts"
import { FakeLlm } from "../src/server/llm/LlmTransport.ts"
import { ApiKeyStore } from "../src/server/settings/ApiKeyStore.ts"
import { Settings } from "../src/server/settings/Settings.ts"
import { curatorBrowser } from "./bookFlow.ts"
import { numbered, seedBook } from "./fixtures/bank.ts"
import { runWithWorkers } from "./harness.ts"

// Tutor Chat and Problem Reports (docs/design.md, decisions 103 to 108),
// through the API with a fake model.

const configure = Effect.gen(function*() {
  yield* (yield* Settings).saveLlm({
    baseUrl: "https://api.example.com/v1",
    jsonMode: "json-schema",
    models: [{ task: "tutor-chat", model: "chat-model" }],
    prices: [{ model: "chat-model", inputPerMillion: 2, outputPerMillion: 8 }],
    readsImages: []
  })
  yield* (yield* ApiKeyStore).save("sk-test-12345678")
})

const reply = (text: string) => ({ content: JSON.stringify({ reply: text }) })

const learner = (name: string) =>
  Effect.gen(function*() {
    const jar = yield* Ref.make(Cookies.empty)
    const tab = yield* HttpApiClient.make(Api, {
      transformClient: (client) =>
        client.pipe(HttpClient.withCookiesRef(jar), HttpClient.mapRequest(HttpClientRequest.setHeader("x-gp-device", `tab-${name}`)))
    })
    yield* tab.profiles.create({ payload: { name, timeZone: "UTC" } })
    return tab
  })
type Tab = Effect.Success<ReturnType<typeof learner>>

// An untimed set of the given size, every answer B: wrong against key C.
const answerUntimed = (tab: Tab, size: number) =>
  Effect.gen(function*() {
    let view: PracticeView = yield* tab.practice.start({ payload: { choice: { kind: "filters", status: "unseen", size } } })
    const answered: Array<QuestionId> = []
    while (view.current !== null && view.status === "active") {
      const current = view.current
      answered.push(current.question.id)
      view = yield* tab.practice.answer({
        params: { id: view.id },
        payload: { seq: view.nextSeq, questionId: current.question.id, selection: [{ part: 0, choice: "B" }], guessed: false }
      })
      view = current.position + 1 >= view.total
        ? yield* tab.practice.finish({ params: { id: view.id } })
        : yield* tab.practice.next({ params: { id: view.id }, payload: { position: current.position + 1 } })
    }
    return answered
  })

describe("Tutor Chat", () => {
  test("answers about a Question the Learner answered, with the key as correct, and reuses only that Profile's reply", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Algebra", numbered(4, { seed: 0 }))
      const asha = yield* learner("Asha")
      const answeredIds = yield* answerUntimed(asha, 2)
      const id = answeredIds[0]!
      // Not set up yet: the chat says so.
      expect((yield* asha.tutor.conversation({ params: { id } })).state).toBe("not-set-up")
      const refused = yield* asha.tutor.ask({ params: { id }, payload: { message: "Why is B wrong?" } }).pipe(Effect.flip)
      expect(refused._tag).toBe("TutorNotSetUp")
      yield* configure
      const fake = yield* FakeLlm
      yield* fake.reply(reply("You solved for \\(2x\\), but the question asks for \\(x\\)."))
      const answered = yield* asha.tutor.ask({ params: { id }, payload: { message: "Why is B wrong?" } })
      expect(answered.state).toBe("open")
      expect(answered.exchanges.map((each) => [each.message, each.reply, each.reused])).toEqual([
        ["Why is B wrong?", "You solved for \\(2x\\), but the question asks for \\(x\\).", false]
      ])
      const sent = (yield* fake.requests).at(-1)!
      const system = sent.messages[0]!.content as string
      const user = sent.messages[1]!.content as string
      expect(system).toContain("The answer key is correct.")
      expect(system).toContain("Report a problem")
      expect(user).toContain("Right answer: C")
      expect(user).toContain("- B: wrong")
      expect(user).toContain("Why is B wrong?")
      // The same message, spaced and cased differently: the stored reply.
      const again = yield* asha.tutor.ask({ params: { id }, payload: { message: "  why is b   WRONG? " } })
      expect(again.exchanges.map((each) => each.reused)).toEqual([false, true])
      expect((yield* fake.requests).length).toBe(1)
      // Another Profile asking the same gets its own reply.
      const ben = yield* learner("Ben")
      yield* answerUntimed(ben, 4)
      yield* fake.reply(reply("Check what the question asks for."))
      const bens = yield* ben.tutor.ask({ params: { id }, payload: { message: "Why is B wrong?" } })
      expect(bens.exchanges.map((each) => [each.reply, each.reused])).toEqual([["Check what the question asks for.", false]])
      expect((yield* fake.requests).length).toBe(2)
      // A Question not answered yet is closed to the chat.
      const db = yield* Db
      const unanswered = (yield* db.select({ id: questions.id }).from(questions).pipe(Effect.orDie))
        .map((row) => row.id as QuestionId).find((each) => !answeredIds.includes(each))!
      const closed = yield* asha.tutor.conversation({ params: { id: unanswered } }).pipe(Effect.flip)
      expect(closed._tag).toBe("TutorQuestionClosed")
    })))

  test("says when the monthly cap is reached, the API is down, or a reply fails twice, and practice goes on", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Algebra", numbered(4, { seed: 0 }))
      yield* configure
      const curator = yield* curatorBrowser
      const asha = yield* learner("Asha")
      const [id] = yield* answerUntimed(asha, 1)
      const fake = yield* FakeLlm
      // Down: a 503 that asks for more than a minute.
      yield* fake.reply({ status: 503, retryAfterMs: 120_000 })
      expect((yield* asha.tutor.ask({ params: { id: id! }, payload: { message: "Help?" } }).pipe(Effect.flip))._tag).toBe("TutorUnavailable")
      // A reply that fails its check twice.
      yield* fake.reply({ content: "{}" }, { content: "not json" })
      expect((yield* asha.tutor.ask({ params: { id: id! }, payload: { message: "Help again?" } }).pipe(Effect.flip))._tag).toBe(
        "TutorReplyInvalid"
      )
      // A cap of nothing: no call is made.
      const capped = yield* curator.api.curatorTutor.saveCap({ payload: { cap: 0 } })
      expect(capped.cap).toBe(0)
      const calls = (yield* fake.requests).length
      expect((yield* asha.tutor.ask({ params: { id: id! }, payload: { message: "Once more?" } }).pipe(Effect.flip))._tag).toBe(
        "TutorCapReached"
      )
      expect((yield* fake.requests).length).toBe(calls)
      expect((yield* asha.tutor.conversation({ params: { id: id! } })).state).toBe("cap-reached")
      // Practice still works.
      const next = yield* asha.practice.start({ payload: { choice: { kind: "filters", status: "unseen", size: 1 } } })
      expect(next.total).toBe(1)
    })))
})

describe("Problem Reports", () => {
  test("open one Review Queue item per Question with each Learner's words; the Question stays published until decided", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* seedBook("Algebra", numbered(3, { seed: 0 }))
      const curator = yield* curatorBrowser
      const asha = yield* learner("Asha")
      const [id] = yield* answerUntimed(asha, 1)
      const ben = yield* learner("Ben")
      yield* answerUntimed(ben, 3)
      yield* asha.tutor.report({ params: { id: id! }, payload: { text: "I think the key should be B." } })
      yield* ben.tutor.report({ params: { id: id! }, payload: { text: "Option B also works." } })
      const db = yield* Db
      const [question] = yield* db.select({ status: questions.status }).from(questions).where(eq(questions.id, id!)).pipe(Effect.orDie)
      expect(question!.status).toBe("published")
      const queue = yield* curator.api.review.list()
      const item = queue.find((each) => each.question?.id === id)!
      expect(item.reasons.map((reason) => [reason.code, reason.detail])).toEqual([
        ["problem-report", "I think the key should be B."],
        ["problem-report", "Option B also works."]
      ])
      // Kept as it is: each Learner sees the decision.
      yield* curator.api.review.dismiss({ params: { id: item.id } })
      const [stored] = yield* db.select().from(reviewItems).where(eq(reviewItems.id, item.id)).pipe(Effect.orDie)
      expect(stored!.decision).toBe("dismissed")
      const mine = yield* asha.tutor.reports()
      expect(mine.map((each) => [each.text, each.decision])).toEqual([["I think the key should be B.", "dismissed"]])
      const [after] = yield* db.select({ status: questions.status }).from(questions).where(eq(questions.id, id!)).pipe(Effect.orDie)
      expect(after!.status).toBe("published")
    })))
})
