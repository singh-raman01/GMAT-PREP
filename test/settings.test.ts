import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { AppConfig } from "../src/server/AppConfig.ts"
import { openBrowser, runWithApp, tempDataDir } from "./harness.ts"

const passphrase = "correct horse battery"
const apiKey = "sk-live-7f3c9a1b2d4e6f80"

const curatorBrowser = Effect.gen(function*() {
  const browser = yield* openBrowser
  yield* browser.curatorAccess.setPassphrase({ payload: { passphrase } })
  return browser
})

const settingsInput = {
  baseUrl: "https://api.example.com/v1",
  jsonMode: "json-schema" as const,
  models: [
    { task: "tagging" as const, model: "small-model" },
    { task: "extraction" as const, model: "large-model" }
  ],
  prices: [
    { model: "small-model", inputPerMillion: 0.15, outputPerMillion: 0.6 },
    { model: "large-model", inputPerMillion: 2.5, outputPerMillion: 10 }
  ],
  readsImages: ["large-model"]
}

describe("LLM settings", () => {
  test("the base URL, a model per task and prices per model are saved and read back", () =>
    runWithApp(Effect.gen(function*() {
      const curator = yield* curatorBrowser
      const empty = yield* curator.settings.llm()
      expect(empty.baseUrl).toBeNull()
      expect(empty.models).toHaveLength(9)
      expect(empty.models.every((entry) => entry.model === null)).toBe(true)

      yield* curator.settings.saveLlm({ payload: settingsInput })
      const saved = yield* curator.settings.llm()
      expect(saved.baseUrl).toBe("https://api.example.com/v1")
      expect(saved.jsonMode).toBe("json-schema")
      expect(saved.models.find((entry) => entry.task === "tagging")?.model).toBe("small-model")
      expect(saved.models.find((entry) => entry.task === "lessons")?.model).toBeNull()
      expect(saved.prices.map((price) => [price.model, price.inputPerMillion, price.outputPerMillion])).toEqual([
        ["small-model", 0.15, 0.6],
        ["large-model", 2.5, 10]
      ])
    })))

  test("settings that cannot work are refused", () =>
    runWithApp(Effect.gen(function*() {
      yield* curatorBrowser
      const client = yield* HttpClient.HttpClient
      const statusFor = (changes: Record<string, unknown>) =>
        client.execute(
          HttpClientRequest.put("/api/curator/settings/llm").pipe(
            HttpClientRequest.bodyJsonUnsafe({ ...settingsInput, ...changes })
          )
        ).pipe(Effect.map((response) => response.status))
      // The cookie jar is not shared with this raw client, so unlock it first.
      const unlock = yield* client.execute(
        HttpClientRequest.post("/api/curator/unlock").pipe(HttpClientRequest.bodyJsonUnsafe({ passphrase }))
      )
      const cookie = unlock.headers["set-cookie"]?.split(";")[0] ?? ""
      const withCookie = (changes: Record<string, unknown>) =>
        client.execute(
          HttpClientRequest.put("/api/curator/settings/llm").pipe(
            HttpClientRequest.setHeader("cookie", cookie),
            HttpClientRequest.bodyJsonUnsafe({ ...settingsInput, ...changes })
          )
        ).pipe(Effect.map((response) => response.status))
      expect(yield* withCookie({})).toBe(200)
      expect(yield* withCookie({ baseUrl: "ftp://api.example.com" })).toBe(400)
      expect(yield* withCookie({ baseUrl: "https://user:secret@api.example.com" })).toBe(400)
      expect(yield* withCookie({ baseUrl: "not a url" })).toBe(400)
      expect(yield* withCookie({ prices: [{ model: "small-model", inputPerMillion: -1, outputPerMillion: 1 }] }))
        .toBe(400)
      expect(yield* withCookie({ models: [{ task: "tagging", model: "   " }] })).toBe(400)
      expect(yield* withCookie({ models: [{ task: "unknown-task", model: "x" }] })).toBe(400)
      expect(yield* statusFor({})).toBe(401)
    })))
})

describe("The API key", () => {
  test("is kept only in a file outside the data folder that only this user can read", async () => {
    const dataDir = tempDataDir()
    const configDir = `${dataDir}-config`
    const shown = await runWithApp(
      Effect.gen(function*() {
        const curator = yield* curatorBrowser
        const status = yield* curator.settings.saveApiKey({ payload: { apiKey: `  ${apiKey}  ` } })
        const view = yield* curator.settings.llm()
        return { status, view: JSON.stringify(view) }
      }),
      dataDir
    )
    expect(shown.status).toMatchObject({ saved: true, endsWith: "6f80", file: join(configDir, "credentials.json") })
    expect(shown.view).not.toContain(apiKey)

    const file = join(configDir, "credentials.json")
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ apiKey })
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
    // Nothing in the data folder holds it: not the database, its journal or
    // anything else written there.
    const holders = readdirSync(dataDir, { recursive: true })
      .map((name) => join(dataDir, String(name)))
      .filter((path) => statSync(path).isFile())
      .filter((path) => readFileSync(path).includes(apiKey))
    expect(holders).toEqual([])
  })

  test("can be removed", async () => {
    const dataDir = tempDataDir()
    const status = await runWithApp(
      Effect.gen(function*() {
        const curator = yield* curatorBrowser
        yield* curator.settings.saveApiKey({ payload: { apiKey } })
        return yield* curator.settings.removeApiKey()
      }),
      dataDir
    )
    expect(status.saved).toBe(false)
    expect(existsSync(join(`${dataDir}-config`, "credentials.json"))).toBe(false)
  })
})

describe("The config folder", () => {
  const configFor = (env: Record<string, string>) =>
    Effect.runPromise(
      Effect.gen(function*() {
        return yield* AppConfig
      }).pipe(
        Effect.provide(AppConfig.layerFromEnv),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
        Effect.flip,
        Effect.map((error) => error._tag),
        Effect.catch(() => Effect.succeed("accepted"))
      )
    )

  test("is refused inside the data folder, where snapshots would copy the key", async () => {
    const dataDir = tempDataDir()
    expect(await configFor({ GMAT_PREP_DATA_DIR: dataDir, GMAT_PREP_CONFIG_DIR: join(dataDir, "config") })).toBe(
      "ConfigInsideData"
    )
    expect(await configFor({ GMAT_PREP_DATA_DIR: dataDir, GMAT_PREP_CONFIG_DIR: dataDir })).toBe("ConfigInsideData")
  })

  test("is accepted beside the data folder", async () => {
    const dataDir = tempDataDir()
    expect(await configFor({ GMAT_PREP_DATA_DIR: dataDir, GMAT_PREP_CONFIG_DIR: `${dataDir}-config` })).toBe(
      "accepted"
    )
  })
})
