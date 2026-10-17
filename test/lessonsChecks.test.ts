import { describe, expect, test } from "bun:test"
import { and, eq, inArray } from "drizzle-orm"
import { Effect, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { Api } from "../src/api/Api.ts"
import type { PlanSettingsInput, PlanView } from "../src/api/Plan.ts"
import type { PracticeView } from "../src/api/Practice.ts"
import { tagProblems } from "../src/api/taxonomyRules.ts"
import { Db } from "../src/server/db/Database.ts"
import { lessons, questions } from "../src/server/db/schema.ts"
import { LessonWriting } from "../src/server/lessons/write.ts"
import { FakeLlm, type TransportRequest } from "../src/server/llm/LlmTransport.ts"
import { ApiKeyStore } from "../src/server/settings/ApiKeyStore.ts"
import { Settings } from "../src/server/settings/Settings.ts"
import { parseTaxonomy } from "../src/server/taxonomy/Taxonomy.ts"
import { curatorBrowser } from "./bookFlow.ts"
import { numbered, OtherPsSkill, PsSkill, type SeedQuestion, seedBook } from "./fixtures/bank.ts"
import { SmallBlueprint } from "./fixtures/examBank.ts"
import { advanceUntil, runWithWorkers, tempDataDir, TestWorkers, type WorkerTestServices } from "./harness.ts"

// Lessons at the API seam beyond the plan's items: the check, what counts
// as finishing it, its estimate, and who may use the Curator's endpoints.
// Written for the review of ticket 17.

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
      rules: [{ title: "Read the question", text: "Find what is asked before you start." }],
      methods: [{ name: "Work it through", strategy: null, whenValid: "Always.", steps: "Read, plan, then answer." }],
      traps: [{ trapPattern: null, text: "Answering a question that was not asked." }],
      examples: Array.from({ length: examples }, (_, index) => ({ example: index + 1, walkthrough: `Example ${index + 1}: the key holds because the text says so.` }))
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
    return Object.assign(tab, { profileId: profile.id })
  })
type Tab = Effect.Success<ReturnType<typeof learner>>
type Curator = Effect.Success<typeof curatorBrowser>

const writeJob = (curator: Curator, subjects: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const job = yield* curator.api.curatorLessons.write({ payload: { subjects: [...subjects], spendCap: 1 } })
    return yield* advanceUntil(
      curator.api.jobs.list().pipe(Effect.map((all) => all.find((each) => each.id === job.id && each.status === "done"))),
      { step: "200 millis", maxSteps: 2000 }
    )
  })

const approveDraft = (curator: Curator, subject: string) =>
  Effect.gen(function*() {
    const row = (yield* curator.api.curatorLessons.overview()).rows.find((each) => each.subject.id === subject)!
    return yield* curator.api.curatorLessons.approve({ params: { id: row.draft!.id } })
  })

const takeSet = (tab: Tab, started: PracticeView, choice?: string, stopAfter?: number) =>
  Effect.gen(function*() {
    let view = started
    let answered = 0
    while (view.current !== null && view.status === "active") {
      if (stopAfter !== undefined && answered >= stopAfter) break
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
      answered += 1
      if (view.status !== "active") break
      if (stopAfter !== undefined && answered >= stopAfter) break
      if (!view.timed || view.current?.position === current.position) {
        view = current.position + 1 >= view.total
          ? yield* tab.practice.finish({ params: { id: view.id } })
          : yield* tab.practice.next({ params: { id: view.id }, payload: { position: current.position + 1 } })
      }
    }
    if (view.status === "active") view = yield* tab.practice.finish({ params: { id: view.id } })
    return view
  })

describe("the check", () => {
  test("replaces a check Question no longer published, never with a worked example (sound)", () =>
    run(Effect.gen(function*() {
      yield* configure
      yield* seedBook("Algebra", numbered(10, { seed: 0 }))
      const curator = yield* curatorBrowser
      yield* writeJob(curator, [PsSkill])
      yield* approveDraft(curator, PsSkill)
      const db = yield* Db
      const [stored] = yield* db.select().from(lessons).where(eq(lessons.subjectId, PsSkill)).pipe(Effect.orDie)
      const examples = JSON.parse(stored!.examples) as ReadonlyArray<string>
      const checks = JSON.parse(stored!.checks) as ReadonlyArray<string>
      yield* db.update(questions).set({ status: "withdrawn" }).where(eq(questions.id, checks[0]!)).pipe(Effect.orDie)
      const asha = yield* learner("Asha")
      const check = yield* asha.lessons.check({ params: { subject: PsSkill }, payload: {} })
      const served = new Set<string>()
      let view = check
      while (view.current !== null && view.status === "active") {
        served.add(view.current.question.id)
        const position = view.current.position
        view = yield* asha.practice.answer({
          params: { id: view.id },
          payload: { seq: view.nextSeq, questionId: view.current.question.id, selection: [{ part: 0, choice: "C" }], guessed: false }
        })
        view = position + 1 >= view.total
          ? yield* asha.practice.finish({ params: { id: view.id } })
          : yield* asha.practice.next({ params: { id: view.id }, payload: { position: position + 1 } })
      }
      expect({ timed: check.timed, total: check.total }).toEqual({ timed: false, total: 5 })
      expect(served.has(checks[0]!)).toBe(false)
      expect([...served].some((id) => examples.includes(id))).toBe(false)
    })), 60_000)
})

describe("Curator-only endpoints", () => {
  test("refuse a Learner, and a Learner sees no draft (sound)", () =>
    run(Effect.gen(function*() {
      yield* configure
      yield* seedBook("Algebra", numbered(10, { seed: 0 }))
      const curator = yield* curatorBrowser
      yield* writeJob(curator, [PsSkill])
      const draftId = (yield* curator.api.curatorLessons.overview()).rows.find((each) => each.subject.id === PsSkill)!.draft!.id
      const asha = yield* learner("Asha")
      const tags = [
        (yield* asha.curatorLessons.overview().pipe(Effect.flip))._tag,
        (yield* asha.curatorLessons.write({ payload: { spendCap: 1 } }).pipe(Effect.flip))._tag,
        (yield* asha.curatorLessons.lesson({ params: { id: draftId } }).pipe(Effect.flip))._tag,
        (yield* asha.curatorLessons.approve({ params: { id: draftId } }).pipe(Effect.flip))._tag,
        (yield* asha.curatorLessons.reject({ params: { id: draftId }, payload: { note: "no" } }).pipe(Effect.flip))._tag
      ]
      expect(tags).toEqual(["CuratorNotUnlocked", "CuratorNotUnlocked", "CuratorNotUnlocked", "CuratorNotUnlocked", "CuratorNotUnlocked"])
      expect((yield* asha.lessons.open({ params: { subject: PsSkill }, payload: { part: "whole" } }).pipe(Effect.flip))._tag).toBe("NoLesson")
      expect((yield* asha.lessons.check({ params: { subject: PsSkill }, payload: {} }).pipe(Effect.flip))._tag).toBe("NoLesson")
      expect(yield* asha.lessons.list()).toEqual([])
    })), 60_000)
})

const settings = (overrides: Partial<PlanSettingsInput> = {}): PlanSettingsInput => ({
  testDate: null,
  targetTotal: 655,
  weeklyMinutes: 600,
  daysOff: [0],
  timeZone: "UTC",
  rolloverHour: 4,
  ...overrides
})
const todayOf = (view: PlanView) => view.plan.find((day) => day.day === view.today)!

// A Concept gap Weak Area on the Skill or Question Type given, by a timed set
// of 12 answered wrong and labelled, beside a set answered right.
const conceptGap = (tab: Tab, weak: Record<string, string>, strong: Record<string, string>) =>
  Effect.gen(function*() {
    const missed = yield* takeSet(
      tab,
      yield* tab.practice.start({ payload: { choice: { kind: "filters", status: "unseen", size: 12, timed: true, ...weak } } }),
      "A"
    )
    for (let position = 0; position < missed.total; position++) {
      const mistakes = (yield* tab.practice.review({ params: { id: missed.id, position } })).mistakes!
      yield* tab.errorLog.setMistakeType({
        params: { questionId: mistakes.questionId },
        payload: { responseId: mistakes.responseId, part: 0, mistakeType: "concept-gap" }
      })
    }
    yield* takeSet(
      tab,
      yield* tab.practice.start({ payload: { choice: { kind: "filters", status: "unseen", size: 12, timed: true, ...strong } } }),
      "C"
    )
  })

describe("what makes a whole Lesson done", () => {
  test("a check ended after one answer of five counts as finishing it: the plan never sets the Lesson again", () =>
    run(Effect.gen(function*() {
      yield* configure
      yield* seedBook("Algebra", numbered(24, { seed: 0 }))
      yield* seedBook("Percents", numbered(14, { seed: 0, primarySkill: OtherPsSkill }))
      const curator = yield* curatorBrowser
      yield* writeJob(curator, [PsSkill])
      yield* approveDraft(curator, PsSkill)
      const asha = yield* learner("Asha")
      yield* conceptGap(asha, { skill: PsSkill }, { skill: OtherPsSkill })
      const plan = yield* asha.plan.saveSettings({ payload: settings() })
      const item = todayOf(plan).items.find((each) => each.kind === "lesson")!
      yield* asha.lessons.open({ params: { subject: PsSkill }, payload: { part: "whole", planItemId: item.id } })
      const check = yield* asha.lessons.check({ params: { subject: PsSkill }, payload: { planItemId: item.id } })
      // One answer, then the set's End.
      const ended = yield* takeSet(asha, check, "C", 1)
      const lesson = yield* asha.lessons.open({ params: { subject: PsSkill }, payload: { part: "whole" } })
      const after = yield* asha.plan.view()
      const status = todayOf(after).items.find((each) => each.id === item.id)?.status
      // Four of the five check Questions were never answered; the Lesson should not count as done.
      expect({ total: lesson.progress!.check!.total, itemStatus: status }).toEqual({ total: 1, itemStatus: "started" })
    })), 120_000)
})

describe("a Question Type's Lesson in the plan", () => {
  test("is estimated at the Question Type's own Target Time, as its Weak Area's set is (decisions 84 and 101)", () =>
    run(Effect.gen(function*() {
      yield* configure
      const cr = { questionType: "verbal.cr-weaken", primarySkill: "verbal.arguments.causal", seed: 0 }
      const rcd = { questionType: "verbal.rc-detail", primarySkill: "verbal.reading.stated-info", seed: 0 }
      yield* seedBook("CR Review", numbered(24, cr))
      yield* seedBook("RC Review", numbered(14, rcd))
      const curator = yield* curatorBrowser
      yield* curator.api.settings.saveTargetTimes({ payload: { times: [{ questionType: "verbal.cr-weaken", seconds: 240 }] } })
      yield* writeJob(curator, ["verbal.cr-weaken"])
      yield* approveDraft(curator, "verbal.cr-weaken")
      const asha = yield* learner("Asha")
      yield* conceptGap(asha, { questionType: "verbal.cr-weaken" }, { questionType: "verbal.rc-detail" })
      const plan = yield* asha.plan.saveSettings({ payload: settings({ weeklyMinutes: 900 }) })
      const items = plan.plan.flatMap((day) => day.items).filter((each) => each.weakArea?.scope.id === "verbal.cr-weaken")
      const lessonItem = items.find((each) => each.kind === "lesson")!
      const set = items.find((each) => each.kind === "practice")!
      const view = yield* asha.lessons.open({ params: { subject: "verbal.cr-weaken" }, payload: { part: "whole" } })
      // Its words at 200 a minute, plus 5 check Questions at 240 seconds and 20% (24 minutes).
      const wanted = view.minutes + Math.ceil((5 * 240 * 1.2) / 60)
      expect(lessonItem.minutes).toBe(wanted)
    })), 120_000)
})
