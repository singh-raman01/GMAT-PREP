import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { Api } from "../src/api/Api.ts"
import type { PracticeView } from "../src/api/Practice.ts"
import { Db } from "../src/server/db/Database.ts"
import { lessons } from "../src/server/db/schema.ts"
import { lessonSubjects } from "../src/server/lessons/subjects.ts"
import { LessonWriting } from "../src/server/lessons/write.ts"
import { FakeLlm, type TransportRequest } from "../src/server/llm/LlmTransport.ts"
import { ApiKeyStore } from "../src/server/settings/ApiKeyStore.ts"
import { Settings } from "../src/server/settings/Settings.ts"
import { parseTaxonomy } from "../src/server/taxonomy/Taxonomy.ts"
import { curatorBrowser } from "./bookFlow.ts"
import { numbered, PsSkill, seedBook } from "./fixtures/bank.ts"
import { advanceUntil, runWithWorker } from "./harness.ts"

// Lessons (docs/design.md, decisions 93 to 102), through the API with a fake
// model.

// A Lesson for however many worked examples the request quotes.
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
    return Object.assign(tab, { profileId: profile.id })
  })

const run = <A, E>(effect: Parameters<typeof runWithWorker<A, E>>[0]) => runWithWorker(effect, [LessonWriting])

describe("Lesson subjects", () => {
  test("are every Skill and Question Type in the Taxonomy: 52 and 21", async () => {
    const taxonomy = await Effect.runPromise(parseTaxonomy(await Bun.file("taxonomy/v1.yaml").text()))
    const subjects = lessonSubjects(taxonomy)
    expect(subjects.filter((each) => each.kind === "skill").length).toBe(52)
    expect(subjects.filter((each) => each.kind === "questionType").length).toBe(21)
  })
})

describe("Writing and approving a Lesson", () => {
  test("the worker writes a draft from the subject's Questions outside the Reserve; Learners see it once approved", () =>
    run(Effect.gen(function*() {
      yield* configure
      const book = yield* seedBook("Algebra", [...numbered(10, { seed: 0 }), ...numbered(4, { reserve: true, seed: 0 }, 11)])
      const reserved = new Set([11, 12, 13, 14].map((number) => book.ids.get(number)!))
      const curator = yield* curatorBrowser
      let overview = yield* curator.api.curatorLessons.overview()
      const row = () => overview.rows.find((each) => each.subject.id === PsSkill)!
      expect(row()).toMatchObject({ approved: null, draft: null, questions: 10 })
      expect(overview.needed).toBeGreaterThanOrEqual(1)
      const job = yield* curator.api.curatorLessons.write({ payload: { subjects: [PsSkill], spendCap: 1 } })
      expect(job.label).toBe("Write the Lesson on Linear equations and systems")
      yield* advanceUntil(
        curator.api.jobs.list().pipe(Effect.map((jobs) => jobs.find((each) => each.id === job.id && each.status === "done"))),
        { step: "200 millis", maxSteps: 2000 }
      )
      overview = yield* curator.api.curatorLessons.overview()
      expect(row().draft).not.toBeNull()
      const draft = yield* curator.api.curatorLessons.lesson({ params: { id: row().draft!.id } })
      expect(draft.status).toBe("draft")
      expect(draft.body.examples.length).toBe(3)
      expect(draft.checkQuestions).toBe(5)
      // Nothing from the Mock Reserve teaches.
      const db = yield* Db
      const [stored] = yield* db.select().from(lessons).where(eq(lessons.id, draft.id)).pipe(Effect.orDie)
      const used = [...JSON.parse(stored!.examples), ...JSON.parse(stored!.checks)] as ReadonlyArray<string>
      expect(used.length).toBe(8)
      expect(used.some((id) => reserved.has(id))).toBe(false)

      const asha = yield* learner("Asha")
      expect(yield* asha.lessons.list()).toEqual([])
      const refused = yield* asha.lessons.open({ params: { subject: PsSkill }, payload: { part: "whole" } }).pipe(Effect.flip)
      expect(refused._tag).toBe("NoLesson")

      yield* curator.api.curatorLessons.approve({ params: { id: draft.id } })
      const listed = yield* asha.lessons.list()
      expect(listed.map((each) => each.subject.id)).toEqual([PsSkill])
      const again = yield* curator.api.curatorLessons.approve({ params: { id: draft.id } }).pipe(Effect.flip)
      expect(again._tag).toBe("LessonNotDraft")
    })), 60_000)
})

describe("A Learner's Lesson", () => {
  test("makes its worked examples Seen once opened, so unseen practice leaves them out, and its check is an untimed set", () =>
    run(Effect.gen(function*() {
      yield* configure
      yield* seedBook("Algebra", numbered(10, { seed: 0 }))
      const curator = yield* curatorBrowser
      const job = yield* curator.api.curatorLessons.write({ payload: { subjects: [PsSkill], spendCap: 1 } })
      yield* advanceUntil(
        curator.api.jobs.list().pipe(Effect.map((jobs) => jobs.find((each) => each.id === job.id && each.status === "done"))),
        { step: "200 millis", maxSteps: 2000 }
      )
      const overview = yield* curator.api.curatorLessons.overview()
      const draftId = overview.rows.find((each) => each.subject.id === PsSkill)!.draft!.id
      yield* curator.api.curatorLessons.approve({ params: { id: draftId } })

      const asha = yield* learner("Asha")
      const lesson = yield* asha.lessons.open({ params: { subject: PsSkill }, payload: { part: "whole" } })
      const exampleIds = new Set(lesson.body.examples.map((each) => each.question.id as string))
      expect(exampleIds.size).toBe(3)
      expect(lesson.progress).toMatchObject({ check: null, read: null, methodsRead: null })

      // A timed set of unseen Questions takes the 7 left.
      let set: PracticeView = yield* asha.practice.start({
        payload: { choice: { kind: "filters", status: "unseen", size: 10, timed: true } }
      })
      expect(set.total).toBe(7)
      while (set.current !== null && set.status === "active") {
        expect(exampleIds.has(set.current.question.id)).toBe(false)
        yield* TestClock.adjust("60 seconds")
        set = yield* asha.practice.answer({
          params: { id: set.id },
          payload: { seq: set.nextSeq, questionId: set.current.question.id, selection: [{ part: 0, choice: "C" }], guessed: false }
        })
      }

      // The check: an untimed set of 5, none a worked example.
      let check = yield* asha.lessons.check({ params: { subject: PsSkill }, payload: {} })
      expect(check).toMatchObject({ timed: false, total: 5, title: "Lesson check: Linear equations and systems" })
      while (check.current !== null && check.status === "active") {
        const current = check.current
        expect(exampleIds.has(current.question.id)).toBe(false)
        check = yield* asha.practice.answer({
          params: { id: check.id },
          payload: { seq: check.nextSeq, questionId: current.question.id, selection: [{ part: 0, choice: "C" }], guessed: false }
        })
        // An untimed set shows each Debrief, then moves on when asked.
        check = current.position + 1 >= check.total
          ? yield* asha.practice.finish({ params: { id: check.id } })
          : yield* asha.practice.next({ params: { id: check.id }, payload: { position: current.position + 1 } })
      }
      const read = yield* asha.lessons.read({ params: { subject: PsSkill }, payload: { part: "methods" } })
      expect(read.progress!.check).toMatchObject({ id: check.id, right: 5, total: 5 })
      expect(read.progress!.check!.finishedAt).not.toBeNull()
      expect(read.progress!.methodsRead).not.toBeNull()
    })), 60_000)
})

describe("Marking for rewriting", () => {
  test("a Taxonomy change to the subject marks its Lesson, which a new version replaces once approved", () =>
    run(Effect.gen(function*() {
      yield* configure
      yield* seedBook("Algebra", numbered(10, { seed: 0 }))
      const curator = yield* curatorBrowser
      const write = Effect.gen(function*() {
        const job = yield* curator.api.curatorLessons.write({ payload: { spendCap: 1 } })
        yield* advanceUntil(
          curator.api.jobs.list().pipe(Effect.map((jobs) => jobs.find((each) => each.id === job.id && each.status === "done"))),
          { step: "200 millis", maxSteps: 2000 }
        )
        return job
      })
      const row = curator.api.curatorLessons.overview().pipe(
        Effect.map((view) => view.rows.find((each) => each.subject.id === PsSkill)!)
      )
      yield* write
      yield* curator.api.curatorLessons.approve({ params: { id: (yield* row).draft!.id } })
      expect((yield* row).marked).toBeNull()
      // As though the Taxonomy described the subject differently when it was written.
      const db = yield* Db
      yield* db.update(lessons).set({ basis: "{}" }).where(eq(lessons.subjectId, PsSkill)).pipe(Effect.orDie)
      expect((yield* row).marked).toBe("The Taxonomy changed how it describes the subject.")
      // Writing what is needed picks it up; the Curator turns the first try down.
      yield* write
      const second = (yield* row).draft!
      expect(second.version).toBe(2)
      yield* curator.api.curatorLessons.reject({ params: { id: second.id }, payload: { note: "Too short on the traps." } })
      expect(yield* row).toMatchObject({ draft: null, rejected: { version: 2, note: "Too short on the traps." }, approved: { version: 1 } })
      yield* write
      const third = (yield* row).draft!
      yield* curator.api.curatorLessons.approve({ params: { id: third.id } })
      expect(yield* row).toMatchObject({ approved: { version: 3 }, marked: null, rejected: null })
    })), 60_000)
})
