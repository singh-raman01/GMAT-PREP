import { describe, expect, test } from "bun:test"
import { Effect, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { Api } from "../src/api/Api.ts"
import type { PracticeChoice, PracticeView } from "../src/api/Practice.ts"
import { numbered, OtherPsSkill, PsSkill, seedBook } from "./fixtures/bank.ts"
import { seedExamBank, SmallBlueprint } from "./fixtures/examBank.ts"
import { openBrowser, runWithWorkers, tempDataDir, type WorkerTestServices } from "./harness.ts"

// The Learner's analytics through the API (docs/design.md, "Analytics").

// Noon UTC on 1 October 2026, so Study Days are whole days.
const Start = Date.UTC(2026, 9, 1, 12)
const run = <A, E>(effect: Effect.Effect<A, E, WorkerTestServices>) => runWithWorkers(effect, undefined, tempDataDir(), Start)

const learner = (name: string) =>
  Effect.gen(function*() {
    const jar = yield* Ref.make(Cookies.empty)
    const tab = yield* HttpApiClient.make(Api, {
      transformClient: (client) =>
        client.pipe(HttpClient.withCookiesRef(jar), HttpClient.mapRequest(HttpClientRequest.setHeader("x-gp-device", "tab-1")))
    })
    yield* tab.profiles.create({ payload: { name, timeZone: "UTC" } })
    return tab
  })
type Tab = Effect.Success<ReturnType<typeof learner>>

// A timed set of every Question the choice finds, each answered with the
// choice given after a minute; the set ends on its last answer.
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

const bySkill = (skill: string): PracticeChoice => ({ kind: "filters", status: "unseen", size: 12, skill, timed: true })

describe("Analytics", () => {
  test("rank a Skill answered wrong as a Weak Area with its Mistake Types and an untimed remedy", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(12, { seed: 0 }))
      yield* seedBook("Percents Review", numbered(12, { seed: 0, primarySkill: OtherPsSkill }))
      const asha = yield* learner("Asha")
      expect((yield* asha.analytics.weakAreas()).areas).toEqual([])
      yield* timedSet(asha, bySkill(PsSkill), "A")
      yield* timedSet(asha, bySkill(OtherPsSkill), "C")
      const weak = yield* asha.analytics.weakAreas()
      expect(weak).toMatchObject({ frequencyBasis: "official", ratedResponses: 24 })
      const [top] = weak.areas
      expect(top!.ability).toMatchObject({ kind: "skill", scope: { id: PsSkill }, evidence: 12, enough: true, slow: false })
      expect(top!.ability.gap).toBeGreaterThan(0)
      expect(top!.mix.map((each) => [each.kind.id, each.count])).toEqual([["trap", 12]])
      expect(top!.remedy).toEqual({ timed: false, choice: { kind: "filters", status: "any", size: 10, skill: PsSkill } })
      expect(weak.areas.some((area) => area.ability.scope.id === OtherPsSkill)).toBe(false)

      const map = yield* asha.analytics.skillMap()
      const quant = map.sections.find((section) => section.section.id === "quant")!
      expect(quant.ability).not.toBeNull()
      const skills = quant.topics.flatMap((topic) => topic.skills)
      expect(skills.find((each) => each.skill.id === PsSkill)!.scope!.gap).toBeGreaterThan(0)
      expect(skills.find((each) => each.skill.id === OtherPsSkill)!.scope!.gap).toBeLessThan(0)
      expect(skills.filter((each) => each.scope !== null)).toHaveLength(2)
      expect(map.sections.find((section) => section.section.id === "verbal")!.ability).toBeNull()
    })))

  test("time each Question Type and Strategy, count Mistakes per 100 Questions, and log each Study Day", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(4))
      const asha = yield* learner("Asha")
      yield* timedSet(asha, { kind: "filters", status: "unseen", size: 4, timed: true }, "B")
      const timing = yield* asha.analytics.timing()
      expect(timing.questionTypes.map((each) => [each.questionType.id, each.pace.answers])).toEqual([["quant.ps", 4]])
      expect(timing.questionTypes[0]!.pace.median).toBeCloseTo(60 / 129, 10)
      // The seeded Approaches: work backward in 60 seconds is the fastest.
      expect(timing.strategies.map((each) => each.strategy.id)).toEqual(["quant.strategy.work-backward"])
      expect(timing.ending).toEqual({ last: { right: 0, answered: 0 }, rest: { right: 0, answered: 0 } })

      const mistakes = yield* asha.analytics.mistakes()
      expect(mistakes.weeks.map((week) => [week.from, week.to, week.questions])).toEqual([["2026-09-25", "2026-10-01", 4]])
      expect(mistakes.weeks[0]!.mistakeTypes.map((each) => [each.kind.id, each.per100])).toEqual([["calculation-slip", 100]])

      const study = yield* asha.analytics.study()
      expect(study.days.map((day) => [day.day, day.minutes, day.questions, day.mocks])).toEqual([["2026-10-01", 4, 4, 0]])
      expect(study.days[0]!.sections).toEqual([{ section: { id: "quant", name: "Quantitative Reasoning" }, right: 0, answered: 4 }])

      // Another Profile sees none of it.
      const ben = yield* learner("Ben")
      expect((yield* ben.analytics.study()).days).toEqual([])
      expect((yield* ben.analytics.timing()).questionTypes).toEqual([])
    })), 30_000)

  test("draw the Score trend from the kept Score Estimates, a point a Study Day", () =>
    run(Effect.gen(function*() {
      yield* seedBook("Quant Review", numbered(6))
      const asha = yield* learner("Asha")
      yield* timedSet(asha, { kind: "filters", status: "unseen", size: 3, timed: true }, "C")
      const trend = yield* asha.scores.trend()
      expect(trend.sections.map((each) => [each.section.id, each.points.length])).toEqual([["quant", 1]])
      expect(trend.total).toEqual([])
      expect(trend.official).toEqual([])
    })), 30_000)
})

describe("Timing after a Mock", () => {
  test("draws each Section's pacing against an even pace, and sets each Section's last 5 against the rest", () =>
    run(Effect.gen(function*() {
      const curator = yield* openBrowser
      yield* curator.curatorAccess.setPassphrase({ payload: { passphrase: "correct horse battery" } })
      yield* curator.settings.saveBlueprint({ payload: { blueprint: SmallBlueprint } })
      yield* seedExamBank()
      const asha = yield* learner("Asha")
      let mock = yield* asha.mocks.start({ payload: { order: ["quant", "verbal", "di"] } })
      for (let place = 1; place <= 3; place++) {
        const id = mock.sections.find((section) => section.place === mock.current)!.sessionId!
        let view = yield* asha.sectionals.get({ params: { id } })
        while (view.stage === "question") {
          yield* TestClock.adjust("90 seconds")
          const question = view.current!.question
          view = yield* asha.sectionals.answer({
            params: { id },
            payload: {
              seq: view.nextSeq,
              questionId: question.id,
              selection: question.parts.map((part) => ({ part: part.position, choice: part.options[0]!.label }))
            }
          })
        }
        yield* asha.sectionals.finish({ params: { id } })
        mock = yield* asha.mocks.get({ params: { id: mock.id } })
        // Nothing shows while the Mock runs.
        if (place < 3) expect((yield* asha.analytics.timing()).mocks).toEqual([])
        if (mock.stage === "break") mock = yield* asha.mocks.goOn({ params: { id: mock.id } })
      }
      const timing = yield* asha.analytics.timing()
      expect(timing.mocks).toHaveLength(1)
      expect(timing.mocks[0]!.sections.map((section) => section.section.id)).toEqual(["quant", "verbal", "di"])
      for (const section of timing.mocks[0]!.sections) {
        expect(section.points.length).toBe(section.questions)
        expect(section.points[0]).toMatchObject({ question: 1, usedMs: 90_000 })
        expect(section.points.at(-1)!.evenMs).toBe(section.limitMs)
      }
      const answered = timing.ending.last.answered + timing.ending.rest.answered
      expect(answered).toBe(timing.mocks[0]!.sections.reduce((sum, section) => sum + section.questions, 0))
    })), 60_000)
})
