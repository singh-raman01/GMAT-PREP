import { describe, expect, test } from "bun:test"
import { Effect, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { Api } from "../src/api/Api.ts"
import type { MockView } from "../src/api/Mocks.ts"
import type { PracticeChoice, PracticeView } from "../src/api/Practice.ts"
import { Db } from "../src/server/db/Database.ts"
import { books, sources } from "../src/server/db/schema.ts"
import { numbered, PsSkill, seedBook } from "./fixtures/bank.ts"
import { seedExamBank, SmallBlueprint } from "./fixtures/examBank.ts"
import { openBrowser, runWithWorkers, tempDataDir, type WorkerTestServices } from "./harness.ts"
import { eq } from "drizzle-orm"

// The ticket 15 review's findings, each as the case that showed it
// (docs/design.md, decisions 72, 75 and 76).

const Start = Date.UTC(2026, 9, 1, 12)
const run = <A, E>(effect: Effect.Effect<A, E, WorkerTestServices>) => runWithWorkers(effect, undefined, tempDataDir(), Start)

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

const timedSet = (tab: Tab, choice: PracticeChoice, answer: string) =>
  Effect.gen(function*() {
    let view: PracticeView = yield* tab.practice.start({ payload: { choice } })
    while (view.current !== null && view.status === "active") {
      yield* TestClock.adjust("60 seconds")
      view = yield* tab.practice.answer({
        params: { id: view.id },
        payload: { seq: view.nextSeq, questionId: view.current.question.id, selection: [{ part: 0, choice: answer }], guessed: false }
      })
    }
    return view
  })

const finishSection = (tab: Tab, id: NonNullable<MockView["sections"][number]["sessionId"]>) =>
  Effect.gen(function*() {
    let view = yield* tab.sectionals.get({ params: { id } })
    while (view.stage === "question") {
      const question = view.current!.question
      view = yield* tab.sectionals.answer({
        params: { id },
        payload: {
          seq: view.nextSeq,
          questionId: question.id,
          selection: question.parts.map((part) => ({ part: part.position, choice: part.options[0]!.label }))
        }
      })
    }
    if (view.stage === "review") view = yield* tab.sectionals.finish({ params: { id } })
    return view
  })

const sectionNow = (view: MockView) => view.sections.find((section) => section.place === view.current)!.sessionId!

describe("Timing after the review", () => {
  test("a Mock Section that ran out of time is drawn against an even pace over all its Questions, its time-out left out", () =>
    run(Effect.gen(function*() {
      const curator = yield* openBrowser
      yield* curator.curatorAccess.setPassphrase({ payload: { passphrase: "correct horse battery" } })
      // Quant takes 4 Questions a Mock here.
      yield* curator.settings.saveBlueprint({ payload: { blueprint: { ...SmallBlueprint, ps: 4 } } })
      yield* seedExamBank()
      yield* seedBook("More Quant", numbered(4, { reserve: true, seed: 0 }))
      const asha = yield* learner("Asha")
      let mock = yield* asha.mocks.start({ payload: { order: ["quant", "verbal", "di"] } })
      const quantId = sectionNow(mock)
      let quant = yield* asha.sectionals.get({ params: { id: quantId } })
      // Q1 is answered after a minute; Q2 sits on screen until time runs out.
      yield* TestClock.adjust("1 minute")
      quant = yield* asha.sectionals.answer({
        params: { id: quantId },
        payload: { seq: quant.nextSeq, questionId: quant.current!.question.id, selection: [{ part: 0, choice: "C" }] }
      })
      yield* TestClock.adjust("45 minutes")
      quant = yield* asha.sectionals.get({ params: { id: quantId } })
      expect(quant).toMatchObject({ stage: "finished", endedBy: "time" })
      mock = yield* asha.mocks.get({ params: { id: mock.id } })
      if (mock.stage === "break") mock = yield* asha.mocks.goOn({ params: { id: mock.id } })
      for (let place = 2; place <= 3; place++) {
        yield* finishSection(asha, sectionNow(mock))
        mock = yield* asha.mocks.get({ params: { id: mock.id } })
        if (mock.stage === "break") mock = yield* asha.mocks.goOn({ params: { id: mock.id } })
      }
      expect(mock.stage).toBe("finished")
      const timing = yield* asha.analytics.timing()
      const section = timing.mocks[0]!.sections.find((each) => each.section.id === "quant")!
      expect(section.questions).toBe(4)
      // An even pace through 4 Questions in 45 minutes reaches Q1 at 11.25.
      expect(section.points.map((point) => [point.question, point.usedMs, point.evenMs])).toEqual([[1, 60_000, 675_000]])
      expect(timing.timeZone).toBe("UTC")
      // The Quant time-out is not counted in how Sections end.
      const answered = timing.ending.last.answered + timing.ending.rest.answered
      const served = timing.mocks[0]!.sections.reduce((sum, each) => sum + each.points.length, 0)
      expect(answered).toBe(served)
    })), 60_000)
})

describe("Exam frequency after the review", () => {
  test("an official Book's item merged into a Question already in the Bank makes it official", () =>
    run(Effect.gen(function*() {
      const prep = yield* seedBook("Prep Book", numbered(10))
      const db = yield* Db
      yield* db.update(books).set({ official: false }).where(eq(books.id, prep.bookId)).pipe(Effect.orDie)
      const guide = yield* seedBook("Official Guide", [])
      yield* db.update(books).set({ official: true }).where(eq(books.id, guide.bookId)).pipe(Effect.orDie)
      for (const [number, questionId] of prep.ids) {
        yield* db.insert(sources).values({
          id: crypto.randomUUID(),
          questionId,
          bookId: guide.bookId,
          set: "Problem Solving",
          number,
          page: number,
          bookKey: "C",
          explanation: null,
          explanationAnswer: null,
          merged: true,
          mapVersion: 1,
          createdAt: Start
        }).pipe(Effect.orDie)
      }
      const asha = yield* learner("Asha")
      expect((yield* asha.analytics.weakAreas()).frequencyBasis).toBe("official")
    })))
})

describe("Mistakes after the review", () => {
  test("go back to the first week with an answer, however long ago", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(20))
      const asha = yield* learner("Asha")
      yield* timedSet(asha, { kind: "filters", status: "unseen", size: 5, timed: true }, "A")
      // 20 weeks later, five more.
      yield* TestClock.adjust("140 days")
      yield* asha.profiles.unlock({ params: { id: asha.profileId }, payload: {} })
      yield* timedSet(asha, { kind: "filters", status: "unseen", size: 5, timed: true }, "A")
      const weeks = (yield* asha.analytics.mistakes()).weeks
      expect(weeks.length).toBe(21)
      expect(weeks[0]!.questions).toBe(5)
      expect(weeks.at(-1)!.questions).toBe(5)
    })))
})

describe("The Skill map after the review", () => {
  test("a Quant Skill answered only on Data Sufficiency has its row, though Quant has no Section Ability", () =>
    run(Effect.gen(function*() {
      yield* seedBook("DS Book", numbered(10, { questionType: "di.ds", primarySkill: PsSkill, secondarySkills: ["di.sufficiency.value"], seed: 0 }))
      const asha = yield* learner("Asha")
      yield* timedSet(asha, { kind: "filters", status: "unseen", size: 10, timed: true, section: "di" }, "A")
      const map = yield* asha.analytics.skillMap()
      const quant = map.sections.find((section) => section.section.id === "quant")!
      const skill = quant.topics.flatMap((topic) => topic.skills).find((each) => each.skill.id === PsSkill)!
      // The page shows a Section's rows whenever one has a scope (SkillMap.tsx).
      expect(quant.ability).toBeNull()
      expect(skill.scope).toMatchObject({ enough: true })
    })))
})

describe("Analytics kept between reads", () => {
  test("a view read again is the same until something is written, then read anew", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(20))
      const asha = yield* learner("Asha")
      yield* timedSet(asha, { kind: "filters", status: "unseen", size: 10, timed: true }, "A")
      const first = yield* asha.analytics.study()
      expect(yield* asha.analytics.study()).toEqual(first)
      yield* timedSet(asha, { kind: "filters", status: "unseen", size: 5, timed: true }, "C")
      const after = yield* asha.analytics.study()
      expect(after.days[0]!.questions).toBe(first.days[0]!.questions + 5)
    })))
})
