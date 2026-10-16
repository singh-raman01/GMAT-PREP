import { Effect, Layer, Option, Redacted } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../../api/Api.ts"
import { CuratorCookie, CuratorSession } from "../../api/Curator.ts"
import { LlmNotConfigured } from "../../api/Jobs.ts"
import { DefaultBlueprint } from "../../api/blueprint.ts"
import {
  ApiKeyStatus,
  BlueprintView,
  LlmSettingsView,
  LlmTasks,
  ModelPrice,
  TargetTimeView,
  TaskModel,
  UnknownQuestionTypes
} from "../../api/Settings.ts"
import { DefaultTargetSeconds, targetSecondsFor } from "../../api/targetTimes.ts"
import { sectionOf } from "../../api/taxonomyRules.ts"
import { Curator } from "../curator/Curator.ts"
import { ConnectionTest, randomWord } from "../jobs/kinds/connectionTest.ts"
import { JobStore } from "../jobs/JobStore.ts"
import { ApiKeyStore } from "../settings/ApiKeyStore.ts"
import { missingSettings, Settings } from "../settings/Settings.ts"
import { Taxonomy } from "../taxonomy/Taxonomy.ts"

// Plain HTTP on localhost or a trusted LAN, so the cookie is not marked Secure.
const cookieOptions = { httpOnly: true, secure: false, sameSite: "strict", path: "/" } as const

const setCuratorCookie = (token: string) => HttpApiBuilder.securitySetCookie(CuratorCookie, token, cookieOptions)

const clearCuratorCookie = HttpApiBuilder.securitySetCookie(CuratorCookie, "", { ...cookieOptions, maxAge: 0 })

// Dollars a connection test may spend unless the Curator sets another cap.
const ConnectionTestCap = 0.05

export const CuratorSessionLive = Layer.effect(
  CuratorSession,
  Effect.gen(function*() {
    const curator = yield* Curator
    return CuratorSession.of({
      cookie: Effect.fn(function*(httpEffect, { credential }) {
        yield* curator.check(Redacted.value(credential))
        return yield* httpEffect
      })
    })
  })
)

export const CuratorAccessHandlers = HttpApiBuilder.group(
  Api,
  "curatorAccess",
  Effect.fn(function*(handlers) {
    const curator = yield* Curator

    // A browser holds one Curator unlock: a new one ends the one it replaces.
    const replaceUnlock = Effect.fn(function*(token: string) {
      const request = yield* HttpServerRequest.HttpServerRequest
      const previous = request.cookies[CuratorCookie.key]
      if (previous !== undefined && previous !== "") yield* curator.lock(previous)
      yield* setCuratorCookie(token)
    })

    return handlers.handleAll({
      status: () =>
        Effect.gen(function*() {
          const request = yield* HttpServerRequest.HttpServerRequest
          return yield* curator.status(request.cookies[CuratorCookie.key])
        }),
      setPassphrase: Effect.fn(function*({ payload }) {
        yield* replaceUnlock(yield* curator.setPassphrase(payload.passphrase))
      }),
      unlock: Effect.fn(function*({ payload }) {
        yield* replaceUnlock(yield* curator.unlock(payload.passphrase))
      })
    })
  })
)

export const CuratorSessionHandlers = HttpApiBuilder.group(
  Api,
  "curatorSession",
  Effect.fn(function*(handlers) {
    const curator = yield* Curator
    return handlers.handleAll({
      lock: Effect.fn(function*() {
        const credential = yield* HttpApiBuilder.securityDecode(CuratorCookie)
        yield* curator.lock(Redacted.value(credential))
        yield* clearCuratorCookie
      })
    })
  })
)

export const SettingsHandlers = HttpApiBuilder.group(
  Api,
  "settings",
  Effect.fn(function*(handlers) {
    const settings = yield* Settings
    const keys = yield* ApiKeyStore

    const keyStatus = keys.read.pipe(
      Effect.map((key) =>
        new ApiKeyStatus({
          saved: Option.isSome(key),
          endsWith: Option.isSome(key) ? Redacted.value(key.value).slice(-4) : null,
          file: keys.file
        })
      )
    )

    const questionTypes = (yield* Taxonomy).view.sections.flatMap((section) =>
      section.questionTypes.map((type) => ({ id: type.id, name: type.name, section: section.id, sectionName: section.name }))
    )
    const targetTimesView = settings.targetTimes.pipe(
      Effect.map((overrides) =>
        questionTypes.map((type) =>
          new TargetTimeView({
            questionType: type.id,
            name: type.name,
            section: type.section,
            sectionName: type.sectionName,
            seconds: targetSecondsFor(type.id, overrides),
            sectionDefault: DefaultTargetSeconds[type.section] ?? targetSecondsFor(type.id, {})
          })
        )
      )
    )

    const view = Effect.gen(function*() {
      const llm = yield* settings.llm
      return new LlmSettingsView({
        baseUrl: llm.baseUrl,
        jsonMode: llm.jsonMode,
        models: LlmTasks.map((task) => new TaskModel({ task, model: llm.models[task] ?? null })),
        prices: Object.entries(llm.prices).map(([model, price]) =>
          new ModelPrice({ model, inputPerMillion: price.input, outputPerMillion: price.output })
        ),
        readsImages: llm.readsImages,
        apiKey: yield* keyStatus
      })
    })

    return handlers.handleAll({
      llm: () => view,
      saveLlm: Effect.fn(function*({ payload }) {
        yield* settings.saveLlm(payload)
        return yield* view
      }),
      saveApiKey: Effect.fn(function*({ payload }) {
        yield* keys.save(payload.apiKey)
        return yield* keyStatus
      }),
      removeApiKey: () => keys.remove.pipe(Effect.andThen(keyStatus)),
      targetTimes: () => targetTimesView,
      saveTargetTimes: Effect.fn(function*({ payload }) {
        const known = new Set(questionTypes.map((type) => type.id))
        const unknown = payload.times.map((time) => time.questionType).filter((id) => !known.has(id))
        if (unknown.length > 0) return yield* new UnknownQuestionTypes({ questionTypes: [...new Set(unknown)] })
        const current = { ...(yield* settings.targetTimes) }
        for (const time of payload.times) {
          // A time equal to the Section's default follows that default.
          if (time.seconds === DefaultTargetSeconds[sectionOf(time.questionType)]) delete current[time.questionType]
          else current[time.questionType] = time.seconds
        }
        yield* settings.saveTargetTimes(current)
        return yield* targetTimesView
      }),
      blueprint: () =>
        settings.blueprint.pipe(
          Effect.map((blueprint) => new BlueprintView({ blueprint, defaults: DefaultBlueprint, released: null }))
        ),
      saveBlueprint: Effect.fn(function*({ payload }) {
        const released = yield* settings.saveBlueprint(payload.blueprint)
        return new BlueprintView({ blueprint: yield* settings.blueprint, defaults: DefaultBlueprint, released })
      })
    })
  })
)

export const JobsHandlers = HttpApiBuilder.group(
  Api,
  "jobs",
  Effect.fn(function*(handlers) {
    const store = yield* JobStore
    const settings = yield* Settings
    const keys = yield* ApiKeyStore
    return handlers.handleAll({
      list: () => store.list,
      testConnection: Effect.fn(function*({ payload }) {
        const llm = yield* settings.llm
        const hasKey = Option.isSome(yield* keys.read)
        const missing = missingSettings(llm, hasKey, payload.task)
        const model = llm.models[payload.task]
        if (missing.length > 0 || model === undefined) {
          return yield* new LlmNotConfigured({ missing })
        }
        return yield* store.create(
          ConnectionTest,
          { task: payload.task, model, word: randomWord() },
          payload.spendCap ?? ConnectionTestCap
        )
      }),
      pause: ({ params }) => store.pause(params.id),
      resume: ({ params, payload }) => store.resume(params.id, payload.spendCap),
      cancel: ({ params }) => store.cancel(params.id)
    })
  })
)

export const CuratorHandlers = Layer.mergeAll(
  CuratorAccessHandlers,
  CuratorSessionHandlers,
  SettingsHandlers,
  JobsHandlers
)
