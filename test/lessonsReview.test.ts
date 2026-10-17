import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { Api } from "../src/api/Api.ts"
import { LessonId } from "../src/api/Lessons.ts"
import type { PracticeView } from "../src/api/Practice.ts"
import { mayBePrimary, secondaryOnlySkills, tagProblems } from "../src/api/taxonomyRules.ts"
import { lessonPartFor } from "../src/server/analytics/weakAreas.ts"
import { Db } from "../src/server/db/Database.ts"
import { lessons, lessonViews, questions } from "../src/server/db/schema.ts"
import { LessonWriting } from "../src/server/lessons/write.ts"
import { FakeLlm, type TransportRequest } from "../src/server/llm/LlmTransport.ts"
import { seenBy, seenWithoutSessionsBy } from "../src/server/practice/history.ts"
import { ApiKeyStore } from "../src/server/settings/ApiKeyStore.ts"
import { Settings } from "../src/server/settings/Settings.ts"
import { parseTaxonomy } from "../src/server/taxonomy/Taxonomy.ts"
import { curatorBrowser } from "./bookFlow.ts"
import { numbered, OtherPsSkill, PsSkill, seedBook } from "./fixtures/bank.ts"
import { SmallBlueprint } from "./fixtures/examBank.ts"
import { advanceUntil, runWithWorker } from "./harness.ts"

// Lessons after the review of ticket 17: which Questions a subject teaches
// from, which worked examples a page shows and makes Seen, one Lesson job at
// a time, and the links to Lessons from Weak Areas and to every version.

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
type Tab = Effect.Success<ReturnType<typeof learner>>
type Curator = Effect.Success<typeof curatorBrowser>

const run = <A, E>(effect: Parameters<typeof runWithWorker<A, E>>[0]) => runWithWorker(effect, [LessonWriting])

// Queues a Lesson job and waits for it to finish.
const writeJob = (curator: Curator, subjects?: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const job = yield* curator.api.curatorLessons.write({
      payload: { spendCap: 1, ...(subjects === undefined ? {} : { subjects: [...subjects] }) }
    })
    return yield* advanceUntil(
      curator.api.jobs.list().pipe(Effect.map((all) => all.find((each) => each.id === job.id && each.status === "done"))),
      { step: "200 millis", maxSteps: 2000 }
    )
  })

const rowOf = (curator: Curator, subject: string) =>
  curator.api.curatorLessons.overview().pipe(Effect.map((view) => view.rows.find((each) => each.subject.id === subject)!))

// Writes the subject's Lesson and approves it; gives its stored row.
const approvedLesson = (curator: Curator, subject: string) =>
  Effect.gen(function*() {
    yield* writeJob(curator, [subject])
    yield* curator.api.curatorLessons.approve({ params: { id: (yield* rowOf(curator, subject)).draft!.id } })
    const db = yield* Db
    const [stored] = yield* db.select().from(lessons).where(eq(lessons.subjectId, subject)).pipe(Effect.orDie)
    return { id: LessonId.make(stored!.id), examples: JSON.parse(stored!.examples) as ReadonlyArray<string> }
  })

// Answers every Question of a set, finishing it; gives the set as it ended
// and the Questions it served.
const takeSet = (tab: Tab, started: PracticeView, choice = "C") =>
  Effect.gen(function*() {
    let view = started
    const served: Array<string> = []
    while (view.current !== null && view.status === "active") {
      const current = view.current
      served.push(current.question.id)
      yield* TestClock.adjust("60 seconds")
      view = yield* tab.practice.answer({
        params: { id: view.id },
        payload: { seq: view.nextSeq, questionId: current.question.id, selection: [{ part: 0, choice }], guessed: false }
      })
      if (view.status !== "active") break
      if (!view.timed || view.current?.position === current.position) {
        view = current.position + 1 >= view.total
          ? yield* tab.practice.finish({ params: { id: view.id } })
          : yield* tab.practice.next({ params: { id: view.id }, payload: { position: current.position + 1 } })
      }
    }
    if (view.status === "active") view = yield* tab.practice.finish({ params: { id: view.id } })
    return { view, served }
  })

const shownIds = (view: { readonly body: { readonly examples: ReadonlyArray<{ readonly question: { readonly id: string } }> } }) =>
  view.body.examples.map((example) => example.question.id as string)

const seenWithoutSessions = (profileId: string) =>
  seenWithoutSessionsBy(profileId).pipe(Effect.orDie, Effect.map((seen) => [...seen.keys()].toSorted()))

describe("A sufficiency Skill's Lesson", () => {
  test("the Skills no Question may have as its primary Skill are the two DS sufficiency Skills, by the Publish Gate's own rule", async () => {
    const taxonomy = await Effect.runPromise(parseTaxonomy(await Bun.file("taxonomy/v1.yaml").text()))
    expect([...secondaryOnlySkills(taxonomy)].toSorted()).toEqual(["di.sufficiency.value", "di.sufficiency.yes-no"])
    expect(mayBePrimary("di.ds", PsSkill)).toBe(true)
    expect(mayBePrimary("di.ds", "di.sufficiency.value")).toBe(false)
    // The table Skill fits DS too, but can be a Table Analysis Question's primary Skill.
    expect(mayBePrimary("di.ds", "di.displays.tables")).toBe(false)
    expect(mayBePrimary("di.ta", "di.displays.tables")).toBe(true)
    const tags = { questionType: "di.ds", secondarySkills: [], strategies: [], options: [] }
    expect(tagProblems(taxonomy, { ...tags, primarySkill: "di.sufficiency.value" }))
      .toContain("Its primary Skill is a sufficiency Skill, not its maths.")
    expect(tagProblems(taxonomy, { ...tags, primarySkill: "di.displays.tables" }))
      .toContain("Its primary Skill should be the maths it tests, a Quant Skill.")
  })

  test("is written from the DS Questions carrying it as a secondary Skill: the count, the pick, the check and marking", () =>
    run(Effect.gen(function*() {
      yield* configure
      // Tagged as decision 19 and the Publish Gate require: the maths as the
      // primary Skill, one sufficiency Skill as a secondary one.
      const ds = { questionType: "di.ds", primarySkill: PsSkill, seed: 0 }
      const book = yield* seedBook("DS Review", [
        ...numbered(10, { ...ds, secondarySkills: ["di.sufficiency.value"] }),
        ...numbered(3, { ...ds, secondarySkills: ["di.sufficiency.yes-no"] }, 11)
      ])
      const carrying = new Set(Array.from({ length: 10 }, (_, index) => book.ids.get(index + 1)!))
      const curator = yield* curatorBrowser
      expect((yield* rowOf(curator, "di.sufficiency.value")).questions).toBe(10)
      expect((yield* rowOf(curator, "di.sufficiency.yes-no")).questions).toBe(3)

      // "Write the Lessons needed" takes it up with the maths and DS Lessons.
      const job = yield* writeJob(curator)
      expect(job.result).toBe("Wrote 3 Lessons for the Curator to check.")
      const draft = yield* curator.api.curatorLessons.lesson({ params: { id: (yield* rowOf(curator, "di.sufficiency.value")).draft!.id } })
      expect(draft.body.examples.length).toBe(3)
      expect(shownIds(draft).every((id) => carrying.has(id))).toBe(true)
      expect(draft.checkQuestions).toBe(5)
      yield* curator.api.curatorLessons.approve({ params: { id: draft.id } })

      // Its check serves 5 of the Questions carrying it, none a worked example.
      const asha = yield* learner("Asha")
      const check = yield* takeSet(asha, yield* asha.lessons.check({ params: { subject: "di.sufficiency.value" }, payload: {} }))
      expect(new Set(check.served).size).toBe(5)
      expect(check.served.every((id) => carrying.has(id) && !shownIds(draft).includes(id))).toBe(true)

      // A worked example withdrawn marks it for rewriting.
      const db = yield* Db
      yield* db.update(questions).set({ status: "withdrawn" }).where(eq(questions.id, shownIds(draft)[0]!)).pipe(Effect.orDie)
      expect((yield* rowOf(curator, "di.sufficiency.value")).marked)
        .toBe("A worked example is no longer published with the subject outside the Mock Reserve.")
    })), 60_000)
})

describe("The worked examples a Lesson shows", () => {
  test("leave out one withdrawn since, for the Learner and the Curator alike, and only those shown become Seen", () =>
    run(Effect.gen(function*() {
      yield* configure
      yield* seedBook("Algebra", numbered(10, { seed: 0 }))
      const curator = yield* curatorBrowser
      const lesson = yield* approvedLesson(curator, PsSkill)
      expect(lesson.examples.length).toBe(3)
      const db = yield* Db
      yield* db.update(questions).set({ status: "withdrawn" }).where(eq(questions.id, lesson.examples[0]!)).pipe(Effect.orDie)

      const asha = yield* learner("Asha")
      const opened = yield* asha.lessons.open({ params: { subject: PsSkill }, payload: { part: "whole" } })
      // A marked Lesson stays readable, with fewer worked examples.
      expect(shownIds(opened)).toEqual(lesson.examples.slice(1))
      expect(opened.body.rules.length).toBe(1)
      expect(opened.body.examples.map((example) => example.walkthrough)).toEqual([
        "Example 2: subtract, then divide.",
        "Example 3: subtract, then divide."
      ])
      expect(yield* seenWithoutSessions(asha.profileId)).toEqual(lesson.examples.slice(1).toSorted())
      const preview = yield* curator.api.curatorLessons.lesson({ params: { id: lesson.id } })
      expect(shownIds(preview)).toEqual(lesson.examples.slice(1))
    })), 60_000)

  test("leave out one that joined the Mock Reserve, which opening the Lesson leaves unseen for Mocks", () =>
    run(Effect.gen(function*() {
      yield* configure
      yield* seedBook("Algebra", numbered(10, { seed: 0 }))
      const curator = yield* curatorBrowser
      const lesson = yield* approvedLesson(curator, PsSkill)
      // As a Blueprint change decides a passage again and takes it into the Reserve.
      const db = yield* Db
      yield* db.update(questions).set({ reserve: true }).where(eq(questions.id, lesson.examples[1]!)).pipe(Effect.orDie)

      const asha = yield* learner("Asha")
      const opened = yield* asha.lessons.open({ params: { subject: PsSkill }, payload: { part: "whole" } })
      expect(shownIds(opened)).toEqual([lesson.examples[0]!, lesson.examples[2]!])
      const seen = yield* seenBy(asha.profileId).pipe(Effect.orDie)
      expect(seen.has(lesson.examples[1]!)).toBe(false)
      expect(seen.has(lesson.examples[0]!) && seen.has(lesson.examples[2]!)).toBe(true)
    })), 60_000)

  test("leave out one a running Sectional holds, until it ends", () =>
    run(Effect.gen(function*() {
      yield* configure
      const curator = yield* curatorBrowser
      yield* curator.api.settings.saveBlueprint({ payload: { blueprint: SmallBlueprint } })
      yield* seedBook("Algebra", numbered(8, { seed: 0 }))
      // Held for Mocks, and Hard, so a Sectional starting at Medium serves an
      // unseen Medium Question outside the Reserve first.
      yield* seedBook("Quant Reserve", numbered(4, { reserve: true, seed: 2 }, 9))
      const lesson = yield* approvedLesson(curator, PsSkill)
      const asha = yield* learner("Asha")
      // The check makes its 5 Questions Seen, so only the worked examples are left unseen near Medium.
      yield* takeSet(asha, yield* asha.lessons.check({ params: { subject: PsSkill }, payload: {} }))
      const sectional = yield* asha.sectionals.start({ payload: { section: "quant" } })
      const held = sectional.current!.question.id as string
      expect(lesson.examples).toContain(held)

      const during = yield* asha.lessons.open({ params: { subject: PsSkill }, payload: { part: "whole" } })
      expect(shownIds(during)).toEqual(lesson.examples.filter((id) => id !== held))
      expect(yield* seenWithoutSessions(asha.profileId)).toEqual(lesson.examples.filter((id) => id !== held).toSorted())

      yield* asha.sectionals.finish({ params: { id: sectional.id } })
      const after = yield* asha.lessons.open({ params: { subject: PsSkill }, payload: { part: "whole" } })
      expect(shownIds(after)).toEqual([...lesson.examples])
    })), 60_000)

  test("are none on the methods part alone, which is sent only the methods and leaves every Question unseen", () =>
    run(Effect.gen(function*() {
      yield* configure
      yield* seedBook("Algebra", numbered(10, { seed: 0 }))
      const curator = yield* curatorBrowser
      yield* approvedLesson(curator, PsSkill)
      const asha = yield* learner("Asha")
      const methods = yield* asha.lessons.open({ params: { subject: PsSkill }, payload: { part: "methods" } })
      expect(methods.body.methods.map((method) => method.name)).toEqual(["Solve directly"])
      expect({ rules: methods.body.rules, traps: methods.body.traps, examples: methods.body.examples })
        .toEqual({ rules: [], traps: [], examples: [] })
      const read = yield* asha.lessons.read({ params: { subject: PsSkill }, payload: { part: "methods" } })
      expect(read.body.examples).toEqual([])
      expect(read.progress!.methodsRead).not.toBeNull()
      const preview = yield* asha.practice.preview({ payload: { choice: { kind: "filters", status: "unseen", size: 10 } } })
      expect(preview.questions).toBe(10)
    })), 60_000)

  test("count as before on views recorded before the shown examples were kept: an opened whole Lesson shows them all", () =>
    run(Effect.gen(function*() {
      yield* configure
      yield* seedBook("Algebra", numbered(10, { seed: 0 }))
      const curator = yield* curatorBrowser
      const lesson = yield* approvedLesson(curator, PsSkill)
      const asha = yield* learner("Asha")
      const ben = yield* learner("Ben")
      const db = yield* Db
      const older = (profileId: string, kind: string, part: string) => ({
        id: crypto.randomUUID(),
        profileId,
        lessonId: lesson.id,
        kind,
        part,
        planItemId: null,
        viewedAt: 1,
        shownExamples: null
      })
      yield* db.insert(lessonViews).values([
        older(asha.profileId, "opened", "whole"),
        older(ben.profileId, "opened", "methods"),
        older(ben.profileId, "read", "whole")
      ]).pipe(Effect.orDie)
      expect(yield* seenWithoutSessions(asha.profileId)).toEqual(lesson.examples.toSorted())
      expect(yield* seenWithoutSessions(ben.profileId)).toEqual([])
    })), 60_000)
})

describe("The Lesson job", () => {
  test("is one at a time: a second Write while one waits is refused, and each subject gets one draft", () =>
    run(Effect.gen(function*() {
      yield* configure
      yield* seedBook("Algebra", numbered(10, { seed: 0 }))
      yield* seedBook("Percents", numbered(10, { seed: 0, primarySkill: OtherPsSkill }))
      const curator = yield* curatorBrowser
      const first = yield* curator.api.curatorLessons.write({ payload: { spendCap: 1 } })
      expect(first.stepsTotal).toBe(3)
      const again = yield* curator.api.curatorLessons.write({ payload: { spendCap: 1 } }).pipe(Effect.flip)
      expect(again._tag).toBe("LessonJobRunning")
      const named = yield* curator.api.curatorLessons.write({ payload: { subjects: [PsSkill], spendCap: 1 } }).pipe(Effect.flip)
      expect(named._tag).toBe("LessonJobRunning")
      yield* advanceUntil(
        curator.api.jobs.list().pipe(Effect.map((all) => all.find((each) => each.id === first.id && each.status === "done"))),
        { step: "200 millis", maxSteps: 2000 }
      )
      const db = yield* Db
      const written = yield* db.select({ subject: lessons.subjectId }).from(lessons).pipe(Effect.orDie)
      expect(written.map((row) => row.subject).toSorted()).toEqual([PsSkill, "quant.ps", OtherPsSkill].toSorted())
      expect((yield* curator.api.jobs.list()).filter((each) => each.kind === LessonWriting.kind).length).toBe(1)
      // Once it is done, another can be queued.
      const next = yield* curator.api.curatorLessons.write({ payload: { subjects: [PsSkill], spendCap: 1 } })
      expect(next.status).toBe("queued")
      yield* advanceUntil(
        curator.api.jobs.list().pipe(Effect.map((all) => all.find((each) => each.id === next.id && each.status === "done"))),
        { step: "200 millis", maxSteps: 2000 }
      )
    })), 60_000)
})

describe("The Curator's Lessons page", () => {
  test("lists every version of a subject, so a turned-down one and earlier ones open", () =>
    run(Effect.gen(function*() {
      yield* configure
      yield* seedBook("Algebra", numbered(10, { seed: 0 }))
      const curator = yield* curatorBrowser
      yield* approvedLesson(curator, PsSkill)
      const db = yield* Db
      const markIt = db.update(lessons).set({ basis: "{}" }).where(eq(lessons.subjectId, PsSkill)).pipe(Effect.orDie)
      yield* markIt
      yield* writeJob(curator)
      const second = (yield* rowOf(curator, PsSkill)).draft!
      yield* curator.api.curatorLessons.reject({ params: { id: second.id }, payload: { note: "Too short on the traps." } })
      const row = yield* rowOf(curator, PsSkill)
      expect(row.rejected).toMatchObject({ id: second.id, version: 2, note: "Too short on the traps." })
      expect(row.versions.map((each) => [each.version, each.status])).toEqual([[2, "rejected"], [1, "approved"]])
      const turnedDown = yield* curator.api.curatorLessons.lesson({ params: { id: row.rejected!.id } })
      expect(turnedDown).toMatchObject({ version: 2, status: "rejected" })
      expect(turnedDown.body.examples.length).toBe(3)

      // A third version approved: the turned-down and first ones are earlier versions.
      yield* writeJob(curator)
      yield* curator.api.curatorLessons.approve({ params: { id: (yield* rowOf(curator, PsSkill)).draft!.id } })
      const later = yield* rowOf(curator, PsSkill)
      expect({ approved: later.approved?.version, rejected: later.rejected }).toEqual({ approved: 3, rejected: null })
      expect(later.versions.map((each) => [each.version, each.status])).toEqual([[3, "approved"], [2, "rejected"], [1, "approved"]])
      const first = yield* curator.api.curatorLessons.lesson({ params: { id: later.versions[2]!.id } })
      expect(first).toMatchObject({ version: 1, status: "approved" })
    })), 60_000)
})

describe("A Weak Area's Lesson", () => {
  test("is the whole Lesson for a Concept gap and its methods for a Wrong approach", () => {
    expect([lessonPartFor("concept-gap"), lessonPartFor("wrong-approach"), lessonPartFor("trap"), lessonPartFor(null)])
      .toEqual(["whole", "methods", null, null])
  })

  test("is named with the Weak Area, from its most common Mistake Type", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Algebra", numbered(24, { seed: 0 }))
      yield* seedBook("Percents", numbered(14, { seed: 0, primarySkill: OtherPsSkill }))
      const asha = yield* learner("Asha")
      const { view: missed } = yield* takeSet(
        asha,
        yield* asha.practice.start({ payload: { choice: { kind: "filters", status: "unseen", size: 12, skill: PsSkill, timed: true } } }),
        "A"
      )
      const label = (mistakeType: string) =>
        Effect.gen(function*() {
          for (let position = 0; position < missed.total; position++) {
            const mistakes = (yield* asha.practice.review({ params: { id: missed.id, position } })).mistakes!
            yield* asha.errorLog.setMistakeType({
              params: { questionId: mistakes.questionId },
              payload: { responseId: mistakes.responseId, part: 0, mistakeType }
            })
          }
        })
      yield* label("concept-gap")
      yield* takeSet(
        asha,
        yield* asha.practice.start({ payload: { choice: { kind: "filters", status: "unseen", size: 12, skill: OtherPsSkill, timed: true } } })
      )
      const top = () => asha.analytics.weakAreas().pipe(Effect.map((view) => view.areas[0]!))
      expect(yield* top()).toMatchObject({ ability: { scope: { id: PsSkill } }, lesson: "whole" })
      yield* label("wrong-approach")
      expect(yield* top()).toMatchObject({ ability: { scope: { id: PsSkill } }, lesson: "methods" })
    })), 60_000)
})
