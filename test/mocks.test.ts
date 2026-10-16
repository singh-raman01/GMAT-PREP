import { describe, expect, test } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Clock, Effect, Ref } from "effect"
import { Cookies, HttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { Api } from "../src/api/Api.ts"
import { BookId } from "../src/api/Books.ts"
import type { MockView } from "../src/api/Mocks.ts"
import { SessionId } from "../src/api/Practice.ts"
import { Db } from "../src/server/db/Database.ts"
import { difficulty, parts, scoreEstimates, sessions } from "../src/server/db/schema.ts"
import { totalScore } from "../src/server/ratings/scale.ts"
import { NewMock } from "../src/server/sections/mockFlow.ts"
import { seedExamBank, SmallBlueprint } from "./fixtures/examBank.ts"
import { advanceUntil, openBrowser, runWithWorkers } from "./harness.ts"

// One tab of a browser that names itself as a device.
const learner = (name: string) =>
  Effect.gen(function*() {
    const jar = yield* Ref.make(Cookies.empty)
    const tab = yield* HttpApiClient.make(Api, {
      transformClient: (client) =>
        client.pipe(HttpClient.withCookiesRef(jar), HttpClient.mapRequest(HttpClientRequest.setHeader("x-gp-device", "tab-1")))
    })
    yield* tab.profiles.create({ payload: { name } })
    return tab
  })
type Tab = Effect.Success<ReturnType<typeof learner>>

const smallBlueprint = Effect.gen(function*() {
  const curator = yield* openBrowser
  yield* curator.curatorAccess.setPassphrase({ payload: { passphrase: "correct horse battery" } })
  yield* curator.settings.saveBlueprint({ payload: { blueprint: SmallBlueprint } })
})

// Answers every Question of the Section, each Part with its first option,
// and finishes it from Review & Edit.
const finishSection = (tab: Tab, id: SessionId) =>
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

describe("Starting a Mock", () => {
  test("needs every Section to pass the start check, takes them in the order chosen, and runs alone", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* smallBlueprint
      const asha = yield* learner("Asha")
      yield* seedExamBank()
      const options = yield* asha.mocks.options()
      expect(options).toMatchObject({ ready: true, sectionMinutes: 45, breakMinutes: 10, running: null, sectional: null })
      const badOrder = yield* asha.mocks.start({ payload: { order: ["quant", "quant", "di"] } }).pipe(Effect.flip)
      expect(badOrder).toMatchObject({ _tag: "MockOrderInvalid", problems: ["The order leaves out Verbal Reasoning."] })
      const started = yield* asha.mocks.start({ payload: { order: ["verbal", "quant", "di"] } })
      expect(started.stage).toBe("section")
      expect(started.current).toBe(1)
      expect(started.sections.map((section) => [section.section.id, section.status])).toEqual([
        ["verbal", "running"],
        ["quant", "waiting"],
        ["di", "waiting"]
      ])
      const first = yield* asha.sectionals.get({ params: { id: sectionNow(started) } })
      expect(first).toMatchObject({ section: { id: "verbal" }, mock: { id: started.id, place: 1 }, stage: "question" })
      expect(yield* asha.sectionals.start({ payload: { section: "quant" } }).pipe(Effect.flip)).toMatchObject({
        _tag: "MockRunning",
        id: started.id
      })
      expect(yield* asha.mocks.start({ payload: { order: ["quant", "verbal", "di"] } }).pipe(Effect.flip)).toMatchObject({
        _tag: "MockRunning"
      })
      expect((yield* asha.sectionals.options()).mock).toBe(started.id)
      // A Mock's Sections are not Sectionals.
      expect(yield* asha.sectionals.list()).toEqual([])
    })))

  test("is refused while any Section's Reserve is short, and says which", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* smallBlueprint
      yield* seedExamBank()
      const asha = yield* learner("Asha")
      // Asha did the quant book on paper, so its Questions are Seen.
      const quant = (yield* asha.practice.options()).books.find((book) => book.title === "Quant Review")!
      yield* asha.paperMarks.add({ payload: { bookId: BookId.make(quant.id), firstPage: null, lastPage: null } })
      expect((yield* asha.mocks.options()).ready).toBe(false)
      const refused = yield* asha.mocks.start({ payload: { order: ["quant", "verbal", "di"] } }).pipe(Effect.flip)
      expect(refused._tag).toBe("MockReserveTooSmall")
      const short = refused._tag === "MockReserveTooSmall" ? refused.sections.filter((section) => !section.ready) : []
      expect(short.map((section) => section.section.id)).toEqual(["quant"])
    })))
})

describe("Taking a Mock", () => {
  test("offers the break after Section 1, keeps it for after Section 2 when skipped, then starts Section 3 when it runs out", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* smallBlueprint
      yield* seedExamBank()
      const asha = yield* learner("Asha")
      let mock = yield* asha.mocks.start({ payload: { order: ["quant", "verbal", "di"] } })
      const first = sectionNow(mock)
      yield* finishSection(asha, first)
      mock = yield* asha.mocks.get({ params: { id: mock.id } })
      expect(mock).toMatchObject({ stage: "break", current: null, breakAfter: null })
      expect(mock.break).toMatchObject({ after: 1, remainingMs: 600_000, keepsBreak: true })
      // The closed Section shows nothing until the Mock is over.
      const closed = yield* asha.sectionals.get({ params: { id: first } })
      expect(closed).toMatchObject({ stage: "finished", report: null })
      expect(yield* asha.sectionals.question({ params: { id: first, position: 0 } }).pipe(Effect.flip)).toMatchObject({
        _tag: "SectionalOutOfStep",
        reason: "finished"
      })
      // Going on at once keeps the break.
      mock = yield* asha.mocks.goOn({ params: { id: mock.id } })
      expect(mock).toMatchObject({ stage: "section", current: 2, breakAfter: null })
      expect(yield* asha.mocks.goOn({ params: { id: mock.id } }).pipe(Effect.flip)).toMatchObject({
        _tag: "MockOutOfStep",
        reason: "not-on-break"
      })
      yield* finishSection(asha, sectionNow(mock))
      mock = yield* asha.mocks.get({ params: { id: mock.id } })
      expect(mock.break).toMatchObject({ after: 2, keepsBreak: false })
      // Left to run out, the break ends and Section 3 starts on its own.
      yield* TestClock.adjust("9 minutes")
      expect((yield* asha.mocks.get({ params: { id: mock.id } })).stage).toBe("break")
      const third = yield* advanceUntil(
        asha.mocks.get({ params: { id: mock.id } }).pipe(Effect.map((view) => (view.current === 3 ? view : undefined)))
      )
      expect(third).toMatchObject({ stage: "section", breakAfter: 2 })
      const done = yield* finishSection(asha, sectionNow(third))
      expect(done.stage).toBe("finished")
      const over = yield* asha.mocks.get({ params: { id: mock.id } })
      expect(over.stage).toBe("finished")
      const report = over.report!
      expect(report.sections.map((section) => section.section.id)).toEqual(["quant", "verbal", "di"])
      const scores = Object.fromEntries(report.sections.map((section) => [section.section.id, section.report.score]))
      expect(report.total.score).toBe(totalScore([scores.quant!, scores.verbal!, scores.di!]))
      expect(report.total.low).toBeLessThanOrEqual(report.total.score)
      expect(report.total.high).toBeGreaterThanOrEqual(report.total.score)
      expect(report).toMatchObject({ interruptions: 0, repeats: 0, paperRepeats: 0, rescored: false, total: { calibrated: false } })
      // Now the Sections' own reports show.
      expect((yield* asha.sectionals.get({ params: { id: first } })).report).not.toBeNull()
      const [summary] = yield* asha.mocks.list()
      expect(summary).toMatchObject({ finished: true, total: { score: report.total.score } })
    })))

  test("goes on to the next Section at once when the break was taken, and holds closed Sections from Practice until it ends", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* smallBlueprint
      const banks = yield* seedExamBank()
      const asha = yield* learner("Asha")
      let mock = yield* asha.mocks.start({ payload: { order: ["quant", "verbal", "di"] } })
      yield* finishSection(asha, sectionNow(mock))
      const quantBook = { kind: "book" as const, bookId: BookId.make(banks.quant.bookId) }
      expect((yield* asha.practice.preview({ payload: { choice: quantBook } })).inSection).toBe(2)
      // Two minutes into the break, going on ends it.
      yield* TestClock.adjust("2 minutes")
      mock = yield* asha.mocks.goOn({ params: { id: mock.id } })
      expect(mock).toMatchObject({ current: 2, breakAfter: 1 })
      yield* finishSection(asha, sectionNow(mock))
      mock = yield* asha.mocks.get({ params: { id: mock.id } })
      expect(mock).toMatchObject({ stage: "section", current: 3, break: null })
      yield* finishSection(asha, sectionNow(mock))
      expect((yield* asha.mocks.get({ params: { id: mock.id } })).stage).toBe("finished")
      expect((yield* asha.practice.preview({ payload: { choice: quantBook } })).inSection).toBe(0)
    })))

  test("re-scores its report when a key changes, and says so", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* smallBlueprint
      yield* seedExamBank()
      const asha = yield* learner("Asha")
      let mock = yield* asha.mocks.start({ payload: { order: ["quant", "verbal", "di"] } })
      for (let place = 1; place <= 3; place++) {
        yield* finishSection(asha, sectionNow(mock))
        mock = yield* asha.mocks.get({ params: { id: mock.id } })
        if (mock.stage === "break") mock = yield* asha.mocks.goOn({ params: { id: mock.id } })
      }
      const before = mock.report!
      expect(before.rescored).toBe(false)
      // Every single-option answer was A against the key C: make the first
      // quant Question's key A.
      const quantResult = before.sections.find((section) => section.section.id === "quant")!.report.results[0]!
      expect(quantResult.correct).toBe(false)
      const db = yield* Db
      yield* db.update(parts).set({ key: "A" }).where(eq(parts.questionId, quantResult.questionId)).pipe(Effect.orDie)
      const after = (yield* asha.mocks.get({ params: { id: mock.id } })).report!
      expect(after.rescored).toBe(true)
      expect(after.sections.find((section) => section.section.id === "quant")!.report.score)
        .toBeGreaterThan(before.sections.find((section) => section.section.id === "quant")!.report.score)
      expect(after.total.score).toBeGreaterThanOrEqual(before.total.score)
      expect((yield* asha.mocks.list())[0]).toMatchObject({ rescored: true })
    })))
})

// Two tabs of one browser, each its own device, sharing the unlock.
const twoTabs = (name: string) =>
  Effect.gen(function*() {
    const jar = yield* Ref.make(Cookies.empty)
    const tab = (device: string) =>
      HttpApiClient.make(Api, {
        transformClient: (client) =>
          client.pipe(HttpClient.withCookiesRef(jar), HttpClient.mapRequest(HttpClientRequest.setHeader("x-gp-device", device)))
      })
    const first = yield* tab("tab-1")
    const second = yield* tab("tab-2")
    const profile = yield* first.profiles.create({ payload: { name } })
    return { first, second, profileId: profile.id }
  })

describe("While a Mock runs", () => {
  test("the Score Estimates say nothing of a closed Section; when it ends, its Sections move them in order", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* smallBlueprint
      yield* seedExamBank()
      const asha = yield* learner("Asha")
      let mock = yield* asha.mocks.start({ payload: { order: ["quant", "verbal", "di"] } })
      yield* finishSection(asha, sectionNow(mock))
      expect((yield* asha.mocks.get({ params: { id: mock.id } })).stage).toBe("break")
      expect((yield* asha.scores.estimates()).sections).toEqual([])
      expect(yield* asha.practice.scores()).toEqual([])
      const db = yield* Db
      expect(yield* db.select().from(difficulty).pipe(Effect.orDie)).toEqual([])
      mock = yield* asha.mocks.goOn({ params: { id: mock.id } })
      for (let place = 2; place <= 3; place++) {
        yield* finishSection(asha, sectionNow(mock))
        mock = yield* asha.mocks.get({ params: { id: mock.id } })
        if (place === 2) expect((yield* asha.scores.estimates()).sections).toEqual([])
        // The break was kept for after Section 2.
        if (mock.stage === "break") mock = yield* asha.mocks.goOn({ params: { id: mock.id } })
      }
      expect(mock.stage).toBe("finished")
      const after = yield* asha.scores.estimates()
      expect(after.sections.map((each) => each.section.id)).toEqual(["quant", "verbal", "di"])
      expect(after.sections.every((each) => each.ratedResponses > 0)).toBe(true)
      expect(after.total).not.toBeNull()
      // The kept Score Estimates are written once, when the Mock ends.
      const kept = yield* db.select({ at: scoreEstimates.at }).from(scoreEstimates).pipe(Effect.orDie)
      expect(new Set(kept.map((row) => row.at))).toEqual(new Set([mock.finishedAt!]))
      expect((yield* db.select().from(difficulty).pipe(Effect.orDie)).length).toBeGreaterThan(0)
    })))

  test("taking over its Section takes over the Mock, so the device taken over from cannot go on", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* smallBlueprint
      yield* seedExamBank()
      const asha = yield* twoTabs("Asha")
      const mock = yield* asha.first.mocks.start({ payload: { order: ["quant", "verbal", "di"] } })
      const first = sectionNow(mock)
      yield* asha.second.sectionals.claim({ params: { id: first } })
      expect((yield* asha.first.sectionals.get({ params: { id: first } })).heldHere).toBe(false)
      yield* finishSection(asha.second, first)
      expect((yield* asha.second.mocks.get({ params: { id: mock.id } })).heldHere).toBe(true)
      expect(yield* asha.first.mocks.goOn({ params: { id: mock.id } }).pipe(Effect.flip)).toMatchObject({
        _tag: "MockHeldElsewhere"
      })
      // The break runs out: Section 2 starts on the device that took over.
      yield* TestClock.adjust("10 minutes")
      const second = yield* advanceUntil(
        asha.second.mocks.get({ params: { id: mock.id } }).pipe(Effect.map((view) => (view.current === 2 ? view : undefined)))
      )
      expect((yield* asha.second.sectionals.get({ params: { id: sectionNow(second) } })).heldHere).toBe(true)
    })))

  test("a stop between beginning a Section and saving the Mock is mended: the Section is taken up, not begun twice", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* smallBlueprint
      yield* seedExamBank()
      const asha = yield* learner("Asha")
      const db = yield* Db
      let mock = yield* asha.mocks.start({ payload: { order: ["quant", "verbal", "di"] } })
      yield* finishSection(asha, sectionNow(mock))
      mock = yield* asha.mocks.goOn({ params: { id: mock.id } })
      const begun = sectionNow(mock)
      // As a stop leaves it after Section 2 began: the Mock's config still
      // says the break, now run out.
      const [row] = yield* db.select({ config: sessions.config }).from(sessions).where(eq(sessions.id, mock.id))
        .pipe(Effect.orDie)
      const config = JSON.parse(row!.config)
      config.sections = config.sections.slice(0, 1)
      config.flow = { started: 1, breakAfter: null, breakStartedAt: (yield* Clock.currentTimeMillis) - 11 * 60_000, stage: "break" }
      yield* db.update(sessions).set({ config: JSON.stringify(config) }).where(eq(sessions.id, mock.id)).pipe(Effect.orDie)
      const mended = yield* asha.mocks.get({ params: { id: mock.id } })
      expect(sectionNow(mended)).toBe(begun)
      const running = yield* db.select({ id: sessions.id }).from(sessions)
        .where(and(eq(sessions.kind, "mock-section"), eq(sessions.status, "active"))).pipe(Effect.orDie)
      expect(running.map((each) => each.id)).toEqual([begun])
    })))

  test("a Mock stopped before its first Section began begins it", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* smallBlueprint
      yield* seedExamBank()
      const asha = yield* twoTabs("Asha")
      const db = yield* Db
      const id = crypto.randomUUID()
      yield* db.insert(sessions).values({
        id,
        profileId: asha.profileId,
        kind: "mock",
        timed: true,
        config: JSON.stringify({ order: ["quant", "verbal", "di"], sections: [], flow: NewMock }),
        status: "active",
        timeLimitMs: null,
        elapsedMs: 0,
        clockSavedAt: null,
        holder: "tab-1",
        createdAt: 0
      }).pipe(Effect.orDie)
      const view = yield* asha.first.mocks.get({ params: { id: SessionId.make(id) } })
      expect(view).toMatchObject({ stage: "section", current: 1 })
      expect(view.sections[0]).toMatchObject({ status: "running" })
      expect((yield* asha.first.sectionals.get({ params: { id: sectionNow(view) } })).heldHere).toBe(true)
    })))
})

describe("After the re-review", () => {
  // Rewrites the Mock's config, as a stop between two writes leaves it.
  const setMockConfig = (id: string, change: (config: { sections: Array<string>; flow: unknown }) => void) =>
    Effect.gen(function*() {
      const db = yield* Db
      const [row] = yield* db.select({ config: sessions.config }).from(sessions).where(eq(sessions.id, id)).pipe(Effect.orDie)
      const config = JSON.parse(row!.config)
      change(config)
      yield* db.update(sessions).set({ config: JSON.stringify(config) }).where(eq(sessions.id, id)).pipe(Effect.orDie)
    })

  test("a stop in going on, after the next Section began, is mended at once, keeping the break the Learner kept", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* smallBlueprint
      yield* seedExamBank()
      const asha = yield* learner("Asha")
      let mock = yield* asha.mocks.start({ payload: { order: ["quant", "verbal", "di"] } })
      yield* finishSection(asha, sectionNow(mock))
      const breakStartedAt = yield* Clock.currentTimeMillis
      // Going on at 30 seconds keeps the break for after Section 2.
      yield* TestClock.adjust("30 seconds")
      mock = yield* asha.mocks.goOn({ params: { id: mock.id } })
      const begun = sectionNow(mock)
      yield* setMockConfig(mock.id, (config) => {
        config.sections = config.sections.slice(0, 1)
        config.flow = { started: 1, breakAfter: null, breakStartedAt, stage: "break" }
      })
      const mended = yield* asha.mocks.get({ params: { id: mock.id } })
      expect(mended).toMatchObject({ stage: "section", current: 2, breakAfter: null })
      expect(sectionNow(mended)).toBe(begun)
    })))

  test("taking over a closed Section of a running Mock leaves the Mock with the device running it", () =>
    runWithWorkers(Effect.gen(function*() {
      yield* smallBlueprint
      yield* seedExamBank()
      const asha = yield* twoTabs("Asha")
      let mock = yield* asha.first.mocks.start({ payload: { order: ["quant", "verbal", "di"] } })
      const first = sectionNow(mock)
      yield* asha.second.sectionals.claim({ params: { id: first } })
      yield* finishSection(asha.second, first)
      mock = yield* asha.second.mocks.goOn({ params: { id: mock.id } })
      const second = sectionNow(mock)
      // Tab 1 still shows Section 1 running, and takes it over.
      expect((yield* asha.first.sectionals.claim({ params: { id: first } })).stage).toBe("finished")
      expect((yield* asha.first.mocks.get({ params: { id: mock.id } })).heldHere).toBe(false)
      expect((yield* asha.second.mocks.get({ params: { id: mock.id } })).heldHere).toBe(true)
      expect((yield* asha.second.sectionals.get({ params: { id: second } })).heldHere).toBe(true)
    })))
})
