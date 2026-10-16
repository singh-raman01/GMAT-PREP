import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { TestClock } from "effect/testing"
import { openBrowser, runWithApp } from "./harness.ts"

describe("Profiles", () => {
  test("a Learner creates a Profile and finds it in the list", () =>
    runWithApp(Effect.gen(function*() {
      const browser = yield* openBrowser
      const created = yield* browser.profiles.create({ payload: { name: "Asha", timeZone: "Asia/Taipei" } })
      const listed = yield* browser.profiles.list()
      expect(created.hasPin).toBe(false)
      expect(listed.map((profile) => profile.name)).toEqual(["Asha"])
      expect(listed[0]?.timeZone).toBe("Asia/Taipei")
      expect(listed[0]?.rolloverHour).toBe(4)
    })))

  test("Profile names are unique regardless of case", () =>
    runWithApp(Effect.gen(function*() {
      const browser = yield* openBrowser
      yield* browser.profiles.create({ payload: { name: "Asha" } })
      const error = yield* browser.profiles.create({ payload: { name: "  asha " } }).pipe(Effect.flip)
      expect(error._tag).toBe("ProfileNameTaken")
    })))

  test("an unknown time zone is refused", () =>
    runWithApp(Effect.gen(function*() {
      const browser = yield* openBrowser
      const error = yield* browser.profiles.create({ payload: { name: "Asha", timeZone: "Mars/Olympus" } }).pipe(
        Effect.flip
      )
      expect(error._tag).toBe("InvalidTimeZone")
    })))

  test("creating a Profile unlocks it in that browser only", () =>
    runWithApp(Effect.gen(function*() {
      const mine = yield* openBrowser
      const created = yield* mine.profiles.create({ payload: { name: "Asha" } })
      const me = yield* mine.session.me()
      expect(me.id).toBe(created.id)

      const other = yield* openBrowser
      const error = yield* other.session.me().pipe(Effect.flip)
      expect(error._tag).toBe("NotUnlocked")
    })))

  test("the unlock cookie is HttpOnly and SameSite=Strict", () =>
    runWithApp(Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(
        HttpClientRequest.post("/api/profiles").pipe(HttpClientRequest.bodyJsonUnsafe({ name: "Asha" }))
      )
      const cookie = response.headers["set-cookie"] ?? ""
      expect(cookie).toContain("gp_profile=")
      expect(cookie).toContain("HttpOnly")
      expect(cookie).toContain("SameSite=Strict")
    })))

  test("a Profile with a PIN unlocks only with that PIN", () =>
    runWithApp(Effect.gen(function*() {
      const owner = yield* openBrowser
      const created = yield* owner.profiles.create({ payload: { name: "Asha", pin: "2468" } })
      expect(created.hasPin).toBe(true)

      const tablet = yield* openBrowser
      const wrong = yield* tablet.profiles.unlock({ params: { id: created.id }, payload: { pin: "1111" } }).pipe(
        Effect.flip
      )
      expect(wrong._tag).toBe("WrongPin")
      expect(wrong._tag === "WrongPin" && wrong.attemptsLeft).toBe(4)

      yield* tablet.profiles.unlock({ params: { id: created.id }, payload: { pin: "2468" } })
      const me = yield* tablet.session.me()
      expect(me.name).toBe("Asha")
    })))

  test("the server refuses a PIN that is not 4 to 8 digits, and a blank name", () =>
    runWithApp(Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const post = (body: unknown) =>
        client.execute(HttpClientRequest.post("/api/profiles").pipe(HttpClientRequest.bodyJsonUnsafe(body)))
      expect((yield* post({ name: "Asha", pin: "12a4" })).status).toBe(400)
      expect((yield* post({ name: "Asha", pin: "123" })).status).toBe(400)
      expect((yield* post({ name: "   " })).status).toBe(400)
      const browser = yield* openBrowser
      expect(yield* browser.profiles.list()).toHaveLength(0)
    })))

  test("five wrong PINs lock the Profile for five minutes", () =>
    runWithApp(Effect.gen(function*() {
      const owner = yield* openBrowser
      const created = yield* owner.profiles.create({ payload: { name: "Asha", pin: "2468" } })
      const tablet = yield* openBrowser
      const tryPin = (pin: string) =>
        tablet.profiles.unlock({ params: { id: created.id }, payload: { pin } }).pipe(Effect.flip)

      const attemptsLeft: Array<number> = []
      for (let i = 0; i < 4; i++) {
        const error = yield* tryPin("0000")
        if (error._tag === "WrongPin") attemptsLeft.push(error.attemptsLeft)
      }
      expect(attemptsLeft).toEqual([4, 3, 2, 1])

      const fifth = yield* tryPin("0000")
      expect(fifth._tag).toBe("ProfileLocked")

      const rightButLocked = yield* tryPin("2468")
      expect(rightButLocked._tag).toBe("ProfileLocked")

      yield* TestClock.adjust("4 minutes")
      const stillLocked = yield* tryPin("2468")
      expect(stillLocked._tag).toBe("ProfileLocked")

      yield* TestClock.adjust("1 minute")
      yield* tablet.profiles.unlock({ params: { id: created.id }, payload: { pin: "2468" } })
      const me = yield* tablet.session.me()
      expect(me.id).toBe(created.id)
    })))

  test("wrong PINs sent all at once still lock the Profile after five", () =>
    runWithApp(Effect.gen(function*() {
      const owner = yield* openBrowser
      const created = yield* owner.profiles.create({ payload: { name: "Asha", pin: "2468" } })
      const attacker = yield* openBrowser
      const outcomes = yield* Effect.all(
        Array.from({ length: 12 }, (_, i) =>
          attacker.profiles.unlock({ params: { id: created.id }, payload: { pin: String(1000 + i) } }).pipe(
            Effect.flip,
            Effect.map((error) => error._tag)
          )),
        { concurrency: "unbounded" }
      )
      expect(outcomes.filter((tag) => tag === "WrongPin")).toHaveLength(4)
      expect(outcomes.filter((tag) => tag === "ProfileLocked")).toHaveLength(8)
      const right = yield* attacker.profiles.unlock({ params: { id: created.id }, payload: { pin: "2468" } }).pipe(
        Effect.flip
      )
      expect(right._tag).toBe("ProfileLocked")
    })))

  test("two Profiles with one name created at once make one Profile", () =>
    runWithApp(Effect.gen(function*() {
      const first = yield* openBrowser
      const second = yield* openBrowser
      const outcomes = yield* Effect.all(
        [first, second].map((browser) =>
          browser.profiles.create({ payload: { name: "Asha", pin: "2468" } }).pipe(
            Effect.map(() => "created"),
            Effect.catchTag("ProfileNameTaken", () => Effect.succeed("taken"))
          )
        ),
        { concurrency: "unbounded" }
      )
      expect([...outcomes].sort()).toEqual(["created", "taken"])
      expect(yield* first.profiles.list()).toHaveLength(1)
    })))

  test("locking ends the session in that browser", () =>
    runWithApp(Effect.gen(function*() {
      const browser = yield* openBrowser
      yield* browser.profiles.create({ payload: { name: "Asha" } })
      yield* browser.session.lock()
      const error = yield* browser.session.me().pipe(Effect.flip)
      expect(error._tag).toBe("NotUnlocked")
    })))
})
