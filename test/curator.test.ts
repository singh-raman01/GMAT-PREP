import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { TestClock } from "effect/testing"
import { join } from "node:path"
import { getWithCookie, openBrowser, openInspectableBrowser, runWithApp, tempDataDir } from "./harness.ts"

const passphrase = "correct horse battery"

describe("Curator access", () => {
  test("the passphrase is set once, on first use, and unlocks the browser that set it", () =>
    runWithApp(Effect.gen(function*() {
      const curator = yield* openBrowser
      expect(yield* curator.curatorAccess.status()).toMatchObject({ passphraseSet: false, unlocked: false })
      yield* curator.curatorAccess.setPassphrase({ payload: { passphrase } })
      expect(yield* curator.curatorAccess.status()).toMatchObject({ passphraseSet: true, unlocked: true })

      const other = yield* openBrowser
      expect(yield* other.curatorAccess.status()).toMatchObject({ passphraseSet: true, unlocked: false })
      const again = yield* other.curatorAccess.setPassphrase({ payload: { passphrase: "a different one" } }).pipe(
        Effect.flip
      )
      expect(again._tag).toBe("PassphraseAlreadySet")
    })))

  test("a passphrase shorter than 8 characters is refused", () =>
    runWithApp(Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(
        HttpClientRequest.post("/api/curator/passphrase").pipe(HttpClientRequest.bodyJsonUnsafe({ passphrase: "short" }))
      )
      expect(response.status).toBe(400)
    })))

  test("the passphrase is stored only as an argon2id hash", async () => {
    const dataDir = tempDataDir()
    await runWithApp(
      Effect.gen(function*() {
        const curator = yield* openBrowser
        yield* curator.curatorAccess.setPassphrase({ payload: { passphrase } })
      }),
      dataDir
    )
    const db = new Database(join(dataDir, "gmat-prep.sqlite"), { readonly: true })
    const row = db.query("SELECT passphrase_hash FROM curator_access").get() as { passphrase_hash: string }
    db.close()
    expect(row.passphrase_hash).toStartWith("$argon2id$")
    expect(row.passphrase_hash).not.toContain(passphrase)
  })

  test("every Curator operation needs the Curator unlocked", () =>
    runWithApp(Effect.gen(function*() {
      const owner = yield* openBrowser
      yield* owner.curatorAccess.setPassphrase({ payload: { passphrase } })
      const stranger = yield* openBrowser
      const tags = yield* Effect.all([
        stranger.settings.llm().pipe(Effect.flip),
        stranger.settings.saveApiKey({ payload: { apiKey: "sk-test-123456789" } }).pipe(Effect.flip),
        stranger.settings.removeApiKey().pipe(Effect.flip),
        stranger.jobs.list().pipe(Effect.flip),
        stranger.jobs.testConnection({ payload: { task: "tagging" } }).pipe(Effect.flip),
        stranger.curatorSession.lock().pipe(Effect.flip)
      ])
      expect(tags.map((error) => error._tag)).toEqual(Array(6).fill("CuratorNotUnlocked"))
      expect(yield* getWithCookie("/api/events", "")).toBe(401)
    })))

  test("five wrong passphrases lock the Curator for five minutes", () =>
    runWithApp(Effect.gen(function*() {
      const owner = yield* openBrowser
      yield* owner.curatorAccess.setPassphrase({ payload: { passphrase } })
      const guesser = yield* openBrowser
      const attempt = (guess: string) => guesser.curatorAccess.unlock({ payload: { passphrase: guess } })
      const left: Array<number> = []
      for (let i = 0; i < 4; i++) {
        const error = yield* attempt("wrong guess").pipe(Effect.flip)
        if (error._tag === "WrongPassphrase") left.push(error.attemptsLeft)
      }
      expect(left).toEqual([4, 3, 2, 1])
      expect((yield* attempt("wrong guess").pipe(Effect.flip))._tag).toBe("CuratorLocked")
      expect((yield* attempt(passphrase).pipe(Effect.flip))._tag).toBe("CuratorLocked")
      yield* TestClock.adjust("5 minutes")
      yield* attempt(passphrase)
      expect((yield* guesser.curatorAccess.status()).unlocked).toBe(true)
    })))

  test("locking ends the Curator unlock on the server", () =>
    runWithApp(Effect.gen(function*() {
      const curator = yield* openInspectableBrowser
      yield* curator.api.curatorAccess.setPassphrase({ payload: { passphrase } })
      const token = Option.getOrThrow(yield* curator.cookie("gp_curator"))
      yield* curator.api.curatorSession.lock()
      expect((yield* curator.api.curatorAccess.status()).unlocked).toBe(false)
      expect(yield* getWithCookie("/api/curator/jobs", `gp_curator=${token}`)).toBe(401)
    })))

  test("unlocking before a passphrase is set says so", () =>
    runWithApp(Effect.gen(function*() {
      const browser = yield* openBrowser
      const error = yield* browser.curatorAccess.unlock({ payload: { passphrase } }).pipe(Effect.flip)
      expect(error._tag).toBe("PassphraseNotSet")
    })))
})
