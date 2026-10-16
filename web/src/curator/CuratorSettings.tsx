import { type FormEvent, useEffect, useId, useRef, useState } from "react"
import { formatDollars } from "../../../src/api/money.ts"
import {
  type ApiKeyStatus,
  isApiKey,
  type JsonMode,
  type LlmSettingsView,
  type LlmTask,
  LlmTaskLabels,
  LlmTasks,
  type TargetTimeView
} from "../../../src/api/Settings.ts"
import { TargetSecondsRange } from "../../../src/api/targetTimes.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"

interface Props {
  readonly onLocked: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
  readonly onTestStarted: () => void
}

const JsonModes: ReadonlyArray<{ readonly mode: JsonMode; readonly label: string }> = [
  { mode: "json-schema", label: "JSON schema (structured outputs)" },
  { mode: "json-object", label: "JSON mode" },
  { mode: "instructions", label: "Instructions only" }
]

interface Draft {
  readonly baseUrl: string
  readonly jsonMode: JsonMode
  readonly models: Readonly<Record<LlmTask, string>>
  // Dollars per million tokens, as typed.
  readonly prices: Readonly<Record<string, { readonly input: string; readonly output: string }>>
  readonly readsImages: ReadonlySet<string>
}

const draftOf = (view: LlmSettingsView): Draft => ({
  baseUrl: view.baseUrl ?? "",
  jsonMode: view.jsonMode,
  models: Object.fromEntries(view.models.map((entry) => [entry.task, entry.model ?? ""])) as Record<LlmTask, string>,
  prices: Object.fromEntries(
    view.prices.map((price) => [price.model, {
      input: String(price.inputPerMillion),
      output: String(price.outputPerMillion)
    }])
  ),
  readsImages: new Set(view.readsImages)
})

// The distinct model names in use, in task order.
const modelsInUse = (draft: Draft) => [
  ...new Set(LlmTasks.map((task) => draft.models[task].trim()).filter((model) => model !== ""))
]

const isPrice = (text: string) => text.trim() !== "" && Number.isFinite(Number(text)) && Number(text) >= 0

export const CuratorSettings = ({ onLocked, onStopped, onTestStarted }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const [draft, setDraft] = useState<Draft>()
  const [apiKey, setApiKey] = useState<ApiKeyStatus>()
  const [saved, setSaved] = useState<string>()
  const [problems, setProblems] = useState<Readonly<Record<string, string>>>({})
  const [sameModel, setSameModel] = useState("")
  const ids = { baseUrl: useId(), jsonMode: useId(), same: useId() }

  const handle = (failure: { readonly _tag: string }) =>
    failure._tag === "CuratorNotUnlocked" ? onLocked() : onStopped(failure)

  useEffect(() => {
    let live = true
    void call((client) => client.settings.llm()).then((result) => {
      if (!live) return
      if (result._tag === "Failure") return handle(result.failure)
      setDraft(draftOf(result.success))
      setApiKey(result.success.apiKey)
    })
    return () => {
      live = false
    }
    // Loads once, when the screen opens.
  }, [])

  if (draft === undefined || apiKey === undefined) {
    return (
      <>
        <h1 ref={heading} tabIndex={-1}>Settings</h1>
        <p className="lede quiet" aria-busy="true">Loading the settings</p>
      </>
    )
  }

  const update = (change: Partial<Draft>) => {
    setDraft({ ...draft, ...change })
    setSaved(undefined)
  }
  const used = modelsInUse(draft)

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const found: Record<string, string> = {}
    let baseUrl = draft.baseUrl.trim()
    try {
      const url = new URL(baseUrl)
      if (url.protocol !== "http:" && url.protocol !== "https:") found["baseUrl"] = "Use an http or https address."
      else if (url.username !== "" || url.password !== "") found["baseUrl"] = "Leave the user name and password out of the address."
    } catch {
      found["baseUrl"] = "Enter the API's address, such as https://api.openai.com/v1."
    }
    for (const model of used) {
      const price = draft.prices[model]
      if (price === undefined || !isPrice(price.input) || !isPrice(price.output)) {
        found[`price:${model}`] = `Enter both prices for ${model}, in dollars per million tokens.`
      }
    }
    setProblems(found)
    if (Object.keys(found).length > 0) return
    baseUrl = baseUrl.replace(/\/+$/, "")
    const result = await call((client) =>
      client.settings.saveLlm({
        payload: {
          baseUrl,
          jsonMode: draft.jsonMode,
          models: LlmTasks.map((task) => ({ task, model: draft.models[task].trim() === "" ? null : draft.models[task].trim() })),
          prices: used.map((model) => ({
            model,
            inputPerMillion: Number(draft.prices[model]!.input),
            outputPerMillion: Number(draft.prices[model]!.output)
          })),
          readsImages: used.filter((model) => draft.readsImages.has(model))
        }
      })
    )
    if (result._tag === "Failure") return handle(result.failure)
    setDraft(draftOf(result.success))
    setSaved("Settings saved.")
  }

  return (
    <>
      <h1 ref={heading} tabIndex={-1}>Settings</h1>
      <p className="lede">
        The app talks to an OpenAI-compatible chat completions API. Each task can use its own model, and the prices
        you enter work out what each job spends.
      </p>

      <ApiKeySection status={apiKey} onChange={setApiKey} onFailure={handle} />

      <form className="settings" noValidate onSubmit={(event) => void save(event)}>
        <section className="group" aria-labelledby={`${ids.baseUrl}-title`}>
          <h2 id={`${ids.baseUrl}-title`}>Connection</h2>
          <div className="field">
            <label htmlFor={ids.baseUrl}>API base URL</label>
            <input
              id={ids.baseUrl}
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://api.openai.com/v1"
              value={draft.baseUrl}
              aria-invalid={problems["baseUrl"] !== undefined}
              aria-describedby={problems["baseUrl"] !== undefined ? `${ids.baseUrl}-error` : undefined}
              onChange={(event) => update({ baseUrl: event.target.value })}
            />
            {problems["baseUrl"] !== undefined && (
              <p id={`${ids.baseUrl}-error`} className="field-error">{problems["baseUrl"]}</p>
            )}
          </div>
          <div className="field">
            <label htmlFor={ids.jsonMode}>How to ask for JSON</label>
            <p id={`${ids.jsonMode}-hint`} className="hint">
              Every reply is checked either way. If the API refuses requests, try JSON mode or instructions only.
            </p>
            <select
              id={ids.jsonMode}
              value={draft.jsonMode}
              aria-describedby={`${ids.jsonMode}-hint`}
              onChange={(event) => update({ jsonMode: event.target.value as JsonMode })}
            >
              {JsonModes.map((option) => <option key={option.mode} value={option.mode}>{option.label}</option>)}
            </select>
          </div>
        </section>

        <section className="group" aria-labelledby={`${ids.same}-title`}>
          <h2 id={`${ids.same}-title`}>Models</h2>
          <p className="group-about">The model each task uses. A task with no model cannot run.</p>
          <div className="same-model">
            <div className="field">
              <label htmlFor={ids.same}>One model for every task</label>
              <input
                id={ids.same}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={sameModel}
                onChange={(event) => setSameModel(event.target.value)}
              />
            </div>
            <button
              type="button"
              className="button button-quiet"
              onClick={() =>
                sameModel.trim() !== "" &&
                update({ models: Object.fromEntries(LlmTasks.map((task) => [task, sameModel.trim()])) as Record<LlmTask, string> })}
            >
              Use for every task
            </button>
          </div>
          <div className="task-models">
            {LlmTasks.map((task) => (
              <TaskModelField
                key={task}
                task={task}
                value={draft.models[task]}
                onChange={(model) => update({ models: { ...draft.models, [task]: model } })}
              />
            ))}
          </div>
        </section>

        <section className="group" aria-labelledby={`${ids.same}-prices`}>
          <h2 id={`${ids.same}-prices`}>Prices and images</h2>
          <p className="group-about">
            Prices are dollars per million tokens, from your provider's price list; the API reports tokens but not
            cost. Mark the models that accept images, so the extraction model can read scanned pages.
          </p>
          {used.length === 0
            ? <p className="quiet">Set a model above, and its prices go here.</p>
            : (
              <div className="prices">
                {used.map((model) => (
                  <PriceFields
                    key={model}
                    model={model}
                    value={draft.prices[model] ?? { input: "", output: "" }}
                    readsImages={draft.readsImages.has(model)}
                    problem={problems[`price:${model}`]}
                    onChange={(price) => update({ prices: { ...draft.prices, [model]: price } })}
                    onReadsImagesChange={(reads) => {
                      const next = new Set(draft.readsImages)
                      if (reads) next.add(model)
                      else next.delete(model)
                      update({ readsImages: next })
                    }}
                  />
                ))}
              </div>
            )}
        </section>

        <div className="actions">
          <button type="submit" className="button">Save settings</button>
          <p className="saved" role="status">{saved ?? ""}</p>
        </div>
      </form>

      <ConnectionTest
        tasks={LlmTasks.filter((task) => draft.models[task].trim() !== "")}
        onStarted={onTestStarted}
        onFailure={handle}
      />

      <TargetTimes onFailure={handle} />
    </>
  )
}

const TaskModelField = (
  { task, value, onChange }: { readonly task: LlmTask; readonly value: string; readonly onChange: (model: string) => void }
) => {
  const id = useId()
  return (
    <div className="field">
      <label htmlFor={id}>{LlmTaskLabels[task]}</label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

const PriceFields = (
  { model, value, readsImages, problem, onChange, onReadsImagesChange }: {
    readonly model: string
    readonly value: { readonly input: string; readonly output: string }
    readonly readsImages: boolean
    readonly problem: string | undefined
    readonly onChange: (price: { readonly input: string; readonly output: string }) => void
    readonly onReadsImagesChange: (readsImages: boolean) => void
  }
) => {
  const ids = { input: useId(), output: useId(), error: useId(), images: useId() }
  return (
    <fieldset className="price" aria-describedby={problem === undefined ? undefined : ids.error}>
      <legend>{model}</legend>
      <div className="price-fields">
        <div className="field">
          <label htmlFor={ids.input}>Input</label>
          <input
            id={ids.input}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={value.input}
            aria-invalid={problem !== undefined && !isPrice(value.input)}
            onChange={(event) => onChange({ ...value, input: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.output}>Output</label>
          <input
            id={ids.output}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={value.output}
            aria-invalid={problem !== undefined && !isPrice(value.output)}
            onChange={(event) => onChange({ ...value, output: event.target.value })}
          />
        </div>
      </div>
      <div className="check">
        <input
          id={ids.images}
          type="checkbox"
          checked={readsImages}
          onChange={(event) => onReadsImagesChange(event.target.checked)}
        />
        <label htmlFor={ids.images}>Reads images</label>
      </div>
      {problem !== undefined && <p id={ids.error} className="field-error">{problem}</p>}
    </fieldset>
  )
}

const ApiKeySection = (
  { status, onChange, onFailure }: {
    readonly status: ApiKeyStatus
    readonly onChange: (status: ApiKeyStatus) => void
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const id = useId()
  const [replacing, setReplacing] = useState(false)
  const [key, setKey] = useState("")
  const [problem, setProblem] = useState<string>()
  const editing = !status.saved || replacing

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = key.trim()
    if (!isApiKey(trimmed)) {
      return setProblem("Paste the whole key: at least 8 characters, with no spaces or hidden characters.")
    }
    const result = await call((client) => client.settings.saveApiKey({ payload: { apiKey: trimmed } }))
    if (result._tag === "Failure") return onFailure(result.failure)
    setKey("")
    setProblem(undefined)
    setReplacing(false)
    onChange(result.success)
  }

  const remove = async () => {
    const result = await call((client) => client.settings.removeApiKey())
    if (result._tag === "Failure") return onFailure(result.failure)
    onChange(result.success)
  }

  return (
    <section className="group" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>API key</h2>
      {status.saved && (
        <p className="group-about">
          A key ending in {status.endsWith} is saved in <code>{status.file}</code>, which only you can read. It never
          goes into the database, snapshots or exports.
        </p>
      )}
      {editing
        ? (
          <form className="key-form" noValidate onSubmit={(event) => void save(event)}>
            <div className="field">
              <label htmlFor={id}>{status.saved ? "New API key" : "API key"}</label>
              <input
                id={id}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                aria-invalid={problem !== undefined}
                aria-describedby={problem === undefined ? undefined : `${id}-error`}
                onChange={(event) => setKey(event.target.value)}
              />
              {problem !== undefined && <p id={`${id}-error`} className="field-error">{problem}</p>}
            </div>
            <div className="actions">
              <button type="submit" className="button">Save key</button>
              {replacing && (
                <button type="button" className="button button-quiet" onClick={() => setReplacing(false)}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        )
        : (
          <div className="actions">
            <button type="button" className="button button-quiet" onClick={() => setReplacing(true)}>
              Replace key
            </button>
            <button type="button" className="button button-quiet" onClick={() => void remove()}>
              Remove key
            </button>
          </div>
        )}
    </section>
  )
}

const ConnectionTest = (
  { tasks, onStarted, onFailure }: {
    readonly tasks: ReadonlyArray<LlmTask>
    readonly onStarted: () => void
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const id = useId()
  const [task, setTask] = useState<LlmTask | undefined>(tasks[0])
  const [problem, setProblem] = useState<string>()
  // One test per click, however fast the clicks come.
  const busy = useRef(false)
  const chosen = task !== undefined && tasks.includes(task) ? task : tasks[0]

  const start = async () => {
    if (chosen === undefined || busy.current) return
    busy.current = true
    const result = await call((client) => client.jobs.testConnection({ payload: { task: chosen } }))
    busy.current = false
    if (result._tag === "Success") return onStarted()
    if (result.failure._tag === "LlmNotConfigured") {
      return setProblem(`Save ${result.failure.missing.join(", ")} first.`)
    }
    onFailure(result.failure)
  }

  return (
    <section className="group" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Test the connection</h2>
      <p className="group-about">
        Sends one short request with a task's model and shows what it cost, at most {formatDollars(0.05)}.
      </p>
      {tasks.length === 0
        ? <p className="quiet">Save a model for a task first.</p>
        : (
          <div className="same-model">
            <div className="field">
              <label htmlFor={id}>Task</label>
              <select id={id} value={chosen} onChange={(event) => setTask(event.target.value as LlmTask)}>
                {tasks.map((option) => <option key={option} value={option}>{LlmTaskLabels[option]}</option>)}
              </select>
            </div>
            <button type="button" className="button" onClick={() => void start()}>Test the connection</button>
          </div>
        )}
      {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
    </section>
  )
}

// A time as m:ss, or seconds alone, as typed.
const secondsOf = (text: string): number | undefined => {
  const trimmed = text.trim()
  const clock = /^(\d+):([0-5]\d)$/.exec(trimmed)
  if (clock !== null) return Number(clock[1]) * 60 + Number(clock[2])
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined
}

const clockText = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`

// How long a timed set gives each Question, per Question Type.
const TargetTimes = ({ onFailure }: { readonly onFailure: (failure: { readonly _tag: string }) => void }) => {
  const id = useId()
  const [times, setTimes] = useState<ReadonlyArray<TargetTimeView>>()
  const [typed, setTyped] = useState<Readonly<Record<string, string>>>({})
  const [problem, setProblem] = useState<string>()
  const [saved, setSaved] = useState<string>()
  const busy = useRef(false)

  const show = (loaded: ReadonlyArray<TargetTimeView>) => {
    setTimes(loaded)
    setTyped(Object.fromEntries(loaded.map((time) => [time.questionType, clockText(time.seconds)])))
  }

  useEffect(() => {
    let live = true
    void call((client) => client.settings.targetTimes()).then((result) => {
      if (!live) return
      if (result._tag === "Failure") return onFailure(result.failure)
      show(result.success)
    })
    return () => {
      live = false
    }
    // Loads once, when the screen opens.
  }, [])

  if (times === undefined) return null
  const sections = [...new Map(times.map((time) => [time.section, time.sectionName])).entries()]

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSaved(undefined)
    const parsed = times.map((time) => ({ time, seconds: secondsOf(typed[time.questionType] ?? "") }))
    const wrong = parsed.filter(({ seconds }) =>
      seconds === undefined || seconds < TargetSecondsRange.minimum || seconds > TargetSecondsRange.maximum
    )
    if (wrong.length > 0) {
      return setProblem(
        `Give ${wrong.map(({ time }) => time.name).join(", ")} a time from ${clockText(TargetSecondsRange.minimum)} to ${
          clockText(TargetSecondsRange.maximum)
        }, as minutes and seconds.`
      )
    }
    setProblem(undefined)
    const changed = parsed.filter(({ time, seconds }) => seconds !== time.seconds)
    if (changed.length === 0) return setSaved("Nothing changed.")
    if (busy.current) return
    busy.current = true
    const result = await call((client) =>
      client.settings.saveTargetTimes({
        payload: { times: changed.map(({ time, seconds }) => ({ questionType: time.questionType, seconds: seconds! })) }
      })
    )
    busy.current = false
    if (result._tag === "Failure") return onFailure(result.failure)
    show(result.success)
    setSaved("Target Times saved.")
  }

  return (
    <section className="group" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Target Times</h2>
      <p className="group-about">
        A timed set gives each Question its Target Time and adds them up for its time limit. A Question Type takes
        its Section's pace unless you give it its own.
      </p>
      <form className="target-times" noValidate onSubmit={(event) => void save(event)}>
        {sections.map(([section, name]) => {
          const mine = times.filter((time) => time.section === section)
          return (
            <fieldset key={section} className="target-section">
              <legend>
                {name}, {clockText(mine[0]?.sectionDefault ?? 0)} a Question unless set
              </legend>
              <div className="target-fields">
                {mine.map((time) => (
                  <div key={time.questionType} className="field target-field">
                    <label htmlFor={`${id}-${time.questionType}`}>{time.name}</label>
                    <input
                      id={`${id}-${time.questionType}`}
                      className="number-input"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={typed[time.questionType] ?? ""}
                      onChange={(event) => {
                        setSaved(undefined)
                        setTyped({ ...typed, [time.questionType]: event.target.value })
                      }}
                    />
                  </div>
                ))}
              </div>
            </fieldset>
          )
        })}
        <div className="actions">
          <button type="submit" className="button">Save Target Times</button>
          <p className="saved" role="status">{saved ?? ""}</p>
        </div>
        {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
      </form>
    </section>
  )
}
