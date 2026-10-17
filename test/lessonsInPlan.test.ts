import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { type Duration, Effect, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { Api } from "../src/api/Api.ts"
import type { PlanSettingsInput, PlanView } from "../src/api/Plan.ts"
import type { PracticeView } from "../src/api/Practice.ts"
import { Db } from "../src/server/db/Database.ts"
import { jobs, lessons } from "../src/server/db/schema.ts"
import { LessonWriting } from "../src/server/lessons/write.ts"
import { FakeLlm, type TransportRequest } from "../src/server/llm/LlmTransport.ts"
import { ApiKeyStore } from "../src/server/settings/ApiKeyStore.ts"
import { Settings } from "../src/server/settings/Settings.ts"
import { curatorBrowser } from "./bookFlow.ts"
import { numbered, OtherPsSkill, PsSkill, seedBook } from "./fixtures/bank.ts"
import { advanceUntil, runWithWorkers, tempDataDir, TestWorkers, type WorkerTestServices } from "./harness.ts"

// Lesson items in the Study Plan at the API seam (decision 101): placed,
// started and done as the Lesson is, wherever it was done from, and only
// from a real Lesson item. Written for the review of ticket 17.

// Noon UTC on Monday 2 November 2026.
const Start = Date.UTC(2026, 10, 2, 12)
const run = <A, E>(effect: Effect.Effect<A, E, WorkerTestServices>) =>
  runWithWorkers(
    Effect.gen(function*() {
      yield* (yield* TestWorkers).start
      return yield* effect
    }),
    [LessonWriting],
    tempDataDir(),
    Start
  )

const lessonReply = (request: TransportRequest) => {
  const user = request.messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n")
  const examples = [...user.matchAll(/^Worked example (\d+):$/gm)].length
  return {
    content: JSON.stringify({
      rules: [{ title: "Isolate the unknown", text: "Do the same thing to both sides, so \\(2x + 3 = 7\\) gives \\(x = 2\\)." }],
      methods: [{ name: "Solve directly", strategy: null, whenValid: "When the equation is linear.", steps: "Move the constants, then divide." }],
      traps: [{ trapPattern: null, text: "Answering for \\(2x\\) when the question asks for \\(x\\)." }],
      examples: Array.from({ length: examples }, (_, index) => ({ example: index + 1, walkthrough: `Example ${index + 1}: subtract, then divide.` }))
    })
  }
}

const configure = Effect.gen(function*() {
  yield* (yield* Settings).saveLlm({
    baseUrl: "https://api.example.com/v1",
    jsonMode: "json-schema",
    models: [{ task: "lessons", model: "text-model" }],
    prices: [{ model: "text-model", inputPerMillion: 2, outputPerMillion: 8 }],
    readsImages: []
  })
  yield* (yield* ApiKeyStore).save("sk-test-12345678")
  yield* (yield* FakeLlm).respondWith(lessonReply)
})

const learner = (name: string) =>
  Effect.gen(function*() {
    const jar = yield* Ref.make(Cookies.empty)
    const tab = yield* HttpApiClient.make(Api, {
      transformClient: (client) =>
        client.pipe(HttpClient.withCookiesRef(jar), HttpClient.mapRequest(HttpClientRequest.setHeader("x-gp-device", "tab-1")))
    })
    const profile = yield* tab.profiles.create({ payload: { name, timeZone: "UTC" } })
    const later = (duration: Duration.Input) =>
      Effect.gen(function*() {
        yield* TestClock.adjust(duration)
        yield* tab.profiles.unlock({ params: { id: profile.id }, payload: {} })
      })
    return Object.assign(tab, { profileId: profile.id, later })
  })
type Tab = Effect.Success<ReturnType<typeof learner>>

const settings = (overrides: Partial<PlanSettingsInput> = {}): PlanSettingsInput => ({
  testDate: null,
  targetTotal: 655,
  weeklyMinutes: 600,
  daysOff: [0],
  timeZone: "UTC",
  rolloverHour: 4,
  ...overrides
})

const today = (view: PlanView) => view.plan.find((day) => day.day === view.today)!
const lessonItems = (view: PlanView) => today(view).items.filter((item) => item.kind === "lesson")

// Writes the subject's Lesson with the worker, and approves it unless asked not to.
const writeLesson = (curator: Effect.Success<typeof curatorBrowser>, subject: string, approve = true) =>
  Effect.gen(function*() {
    const job = yield* curator.api.curatorLessons.write({ payload: { subjects: [subject], spendCap: 1 } })
    yield* advanceUntil(
      curator.api.jobs.list().pipe(Effect.map((all) => all.find((each) => each.id === job.id && each.status === "done"))),
      { step: "200 millis", maxSteps: 2000 }
    )
    const row = (yield* curator.api.curatorLessons.overview()).rows.find((each) => each.subject.id === subject)!
    if (approve) yield* curator.api.curatorLessons.approve({ params: { id: row.draft!.id } })
    return row.draft!.id
  })

// Answers every Question of a set with the first option, finishing an untimed one.
const takeSet = (tab: Tab, started: PracticeView, choice?: string) =>
  Effect.gen(function*() {
    let view = started
    while (view.current !== null && view.status === "active") {
      const current = view.current
      yield* TestClock.adjust("60 seconds")
      view = yield* tab.practice.answer({
        params: { id: view.id },
        payload: {
          seq: view.nextSeq,
          questionId: current.question.id,
          selection: current.question.parts.map((part) => ({ part: part.position, choice: choice ?? part.options[0]!.label })),
          guessed: false
        }
      })
      if (view.status !== "active") break
      if (!view.timed || view.current?.position === current.position) {
        view = current.position + 1 >= view.total
          ? yield* tab.practice.finish({ params: { id: view.id } })
          : yield* tab.practice.next({ params: { id: view.id }, payload: { position: current.position + 1 } })
      }
    }
    if (view.status === "active") view = yield* tab.practice.finish({ params: { id: view.id } })
    return view
  })

// A Weak Area on PsSkill whose misses the Learner labels with the Mistake Type
// given, and a strong OtherPsSkill, from two timed sets of 12.
const weakArea = (tab: Tab, mistakeType: string) =>
  Effect.gen(function*() {
    const missed = yield* takeSet(
      tab,
      yield* tab.practice.start({ payload: { choice: { kind: "filters", status: "unseen", size: 12, skill: PsSkill, timed: true } } }),
      "A"
    )
    for (let position = 0; position < missed.total; position++) {
      const served = yield* tab.practice.review({ params: { id: missed.id, position } })
      const mistakes = served.mistakes!
      yield* tab.errorLog.setMistakeType({
        params: { questionId: mistakes.questionId },
        payload: { responseId: mistakes.responseId, part: 0, mistakeType }
      })
    }
    yield* takeSet(
      tab,
      yield* tab.practice.start({ payload: { choice: { kind: "filters", status: "unseen", size: 12, skill: OtherPsSkill, timed: true } } }),
      "C"
    )
    const weak = yield* tab.analytics.weakAreas()
    expect(weak.areas[0]!.ability.scope.id).toBe(PsSkill)
    expect(weak.areas[0]!.mix[0]!.kind.id).toBe(mistakeType)
  })

const bank = Effect.gen(function*() {
  yield* configure
  yield* seedBook("Algebra", numbered(24, { seed: 0 }))
  yield* seedBook("Percents", numbered(14, { seed: 0, primarySkill: OtherPsSkill }))
})

describe("a whole Lesson item in the Study Plan", () => {
  test("control: opened from the item and checked from its page, the item is started, then done, and not planned again today", () =>
    run(Effect.gen(function*() {
      yield* bank
      const curator = yield* curatorBrowser
      yield* writeLesson(curator, PsSkill)
      const asha = yield* learner("Asha")
      yield* weakArea(asha, "concept-gap")
      const plan = yield* asha.plan.saveSettings({ payload: settings() })
      const [item] = lessonItems(plan)
      expect(item).toMatchObject({ status: "planned", lesson: { subject: { id: PsSkill }, part: "whole" } })
      yield* asha.lessons.open({ params: { subject: PsSkill }, payload: { part: "whole", planItemId: item!.id } })
      expect(lessonItems(yield* asha.plan.view())[0]).toMatchObject({ id: item!.id, status: "started" })
      const check = yield* asha.lessons.check({ params: { subject: PsSkill }, payload: { planItemId: item!.id } })
      yield* takeSet(asha, check)
      const after = yield* asha.plan.view()
      expect(after.version).toBeGreaterThan(plan.version!)
      const items = today(after).items
      expect(items.filter((each) => each.kind === "lesson").map((each) => [each.id, each.status])).toEqual([[item!.id, "done"]])
      // Followed by its Weak Area's set.
      const at = items.findIndex((each) => each.id === item!.id)
      expect(items[at + 1]).toMatchObject({ kind: "practice", status: "planned", weakArea: { scope: { id: PsSkill } } })
    })), 120_000)

  test("done as the Lesson is, even when its check was taken without the item, as from the Lessons list", () =>
    run(Effect.gen(function*() {
      yield* bank
      const curator = yield* curatorBrowser
      yield* writeLesson(curator, PsSkill)
      const asha = yield* learner("Asha")
      yield* weakArea(asha, "concept-gap")
      const plan = yield* asha.plan.saveSettings({ payload: settings() })
      const [item] = lessonItems(plan)
      // Opened from the item: started.
      yield* asha.lessons.open({ params: { subject: PsSkill }, payload: { part: "whole", planItemId: item!.id } })
      // The check taken from the Lessons list page (no item), and finished.
      const check = yield* asha.lessons.check({ params: { subject: PsSkill }, payload: {} })
      const finished = yield* takeSet(asha, check)
      expect(finished.status).toBe("finished")
      // The Lesson is done: the plan was built again and plans no Lesson.
      const after = yield* asha.plan.view()
      expect(after.version).toBeGreaterThan(plan.version!)
      const lesson = yield* asha.lessons.open({ params: { subject: PsSkill }, payload: { part: "whole" } })
      expect(lesson.progress!.check!.finishedAt).not.toBeNull()
      // Its item, still on today's list, should read done.
      const shown = lessonItems(after).map((each) => [each.id, each.status])
      const log = (yield* asha.plan.dailyLog()).days.find((day) => day.day === after.today)!
      const logged = log.items.filter((each) => each.kind === "lesson").map((each) => [each.id, each.status])
      expect({ shown, logged }).toEqual({ shown: [[item!.id, "done"]], logged: [[item!.id, "done"]] })
    })), 120_000)
})

describe("a whole Lesson item done entirely away from the item", () => {
  test("the item reads done, rather than leaving today's list and the Daily Log", () =>
    run(Effect.gen(function*() {
      yield* bank
      const curator = yield* curatorBrowser
      yield* writeLesson(curator, PsSkill)
      const asha = yield* learner("Asha")
      yield* weakArea(asha, "concept-gap")
      const plan = yield* asha.plan.saveSettings({ payload: settings() })
      const [item] = lessonItems(plan)
      expect(item).toMatchObject({ status: "planned", lesson: { part: "whole" } })
      // The Lesson read from the Lessons list, and its check taken from there.
      yield* asha.lessons.open({ params: { subject: PsSkill }, payload: { part: "whole" } })
      yield* takeSet(asha, yield* asha.lessons.check({ params: { subject: PsSkill }, payload: {} }))
      const after = yield* asha.plan.view()
      const log = (yield* asha.plan.dailyLog()).days.find((day) => day.day === after.today)!
      const shown = today(after).items.filter((each) => each.kind === "lesson").map((each) => each.status)
      const logged = log.items.filter((each) => each.kind === "lesson").map((each) => each.status)
      expect({ shown, logged }).toEqual({ shown: ["done"], logged: ["done"] })
    })), 120_000)
})

describe("a methods Lesson item in the Study Plan", () => {
  test("done once any part is marked read, as on the whole Lesson the methods page links to", () =>
    run(Effect.gen(function*() {
      yield* bank
      const curator = yield* curatorBrowser
      yield* writeLesson(curator, PsSkill)
      const asha = yield* learner("Asha")
      yield* weakArea(asha, "wrong-approach")
      const plan = yield* asha.plan.saveSettings({ payload: settings() })
      const [item] = lessonItems(plan)
      expect(item).toMatchObject({ status: "planned", lesson: { part: "methods" } })
      // The item's link opens the methods page with ?item=...
      yield* asha.lessons.open({ params: { subject: PsSkill }, payload: { part: "methods", planItemId: item!.id } })
      // "Read the whole Lesson" links to the Lesson's own page, without the item.
      yield* asha.lessons.open({ params: { subject: PsSkill }, payload: { part: "whole" } })
      const read = yield* asha.lessons.read({ params: { subject: PsSkill }, payload: { part: "whole" } })
      expect(read.progress!.read).not.toBeNull()
      const after = yield* asha.plan.view()
      // The methods are done (decision 101), so the plan was built again...
      expect(after.version).toBeGreaterThan(plan.version!)
      // ...and the item, still on today's list, should read done.
      expect(lessonItems(after).map((each) => [each.id, each.status])).toEqual([[item!.id, "done"]])
    })), 120_000)
})

describe("approving a Lesson builds the plan again", () => {
  test("a plan made before the Lesson was approved gains its Lesson item once it is", () =>
    run(Effect.gen(function*() {
      yield* bank
      const curator = yield* curatorBrowser
      const draftId = yield* writeLesson(curator, PsSkill, false)
      const asha = yield* learner("Asha")
      yield* weakArea(asha, "concept-gap")
      const before = yield* asha.plan.saveSettings({ payload: settings() })
      expect(lessonItems(before)).toEqual([])
      yield* curator.api.curatorLessons.approve({ params: { id: draftId as never } })
      const after = yield* asha.plan.view()
      expect(after.version).toBe(before.version! + 1)
      expect(lessonItems(after).map((each) => each.lesson!.part)).toEqual(["whole"])
      // Another Profile's Lesson work leaves Asha's plan as it is.
      const ben = yield* learner("Ben")
      yield* ben.lessons.open({ params: { subject: PsSkill }, payload: { part: "whole" } })
      yield* takeSet(ben, yield* ben.lessons.check({ params: { subject: PsSkill }, payload: {} }))
      yield* asha.profiles.unlock({ params: { id: asha.profileId }, payload: {} })
      const again = yield* asha.plan.view()
      expect(again.version).toBe(after.version)
      expect(lessonItems(again).map((each) => each.status)).toEqual(["planned"])
    })), 120_000)
})

describe("a plan item named when a Lesson opens", () => {
  test("is taken as given: another kind of item, a practice set's, reads started though nothing started", () =>
    run(Effect.gen(function*() {
      yield* bank
      const curator = yield* curatorBrowser
      yield* writeLesson(curator, PsSkill)
      const asha = yield* learner("Asha")
      yield* weakArea(asha, "concept-gap")
      const plan = yield* asha.plan.saveSettings({ payload: settings() })
      const practiceItem = today(plan).items.find((each) => each.kind === "practice" && each.weakArea === null)!
      expect(practiceItem.status).toBe("planned")
      yield* asha.lessons.open({ params: { subject: PsSkill }, payload: { part: "whole", planItemId: practiceItem.id } })
      const after = yield* asha.plan.view()
      const shown = today(after).items.find((each) => each.id === practiceItem.id)
      // Should still be planned: no set was started from it.
      expect({ status: shown?.status, sessionId: shown?.sessionId }).toEqual({ status: "planned", sessionId: null })
    })), 120_000)
})
