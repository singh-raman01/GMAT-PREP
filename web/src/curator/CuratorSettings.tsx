import { type FormEvent, useEffect, useId, useRef, useState } from "react"
import {
  type Blueprint,
  BlueprintGroups,
  type BlueprintSection,
  GroupCountRange,
  type GroupId,
  UnitSizeRange,
  UnitsRange
} from "../../../src/api/blueprint.ts"
import { formatDollars } from "../../../src/api/money.ts"
import {
  type ApiKeyStatus,
  type BlueprintView,
  isApiKey,
  type JsonMode,
  type LlmSettingsView,
  type LlmTask,
  LlmTaskLabels,
  LlmTasks,
  type TargetTimeView
} from "../../../src/api/Settings.ts"
import { TargetSecondsRange } from "../../../src/api/targetTimes.ts"
import type { TutorSpendView } from "../../../src/api/Tutor.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { dayAndTime } from "../format.ts"

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

      <TutorCap onFailure={handle} />
      <TargetTimes onFailure={handle} />

      <SectionBlueprint onFailure={handle} />
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

const SectionNames: Record<BlueprintSection, string> = {
  quant: "Quantitative Reasoning",
  verbal: "Verbal Reasoning",
  di: "Data Insights"
}

// A group's slots as typed: a count, or unit sizes such as 3, 3, 3, 4.
const blueprintText = (blueprint: Blueprint, group: GroupId) => {
  const value = blueprint[group]
  return typeof value === "number" ? String(value) : value.join(", ")
}

const sizesOf = (text: string) => {
  const pieces = text.split(/[\s,]+/).filter((piece) => piece !== "")
  return pieces.every((piece) => /^\d+$/.test(piece)) ? pieces.map(Number) : undefined
}

// The Blueprint the fields describe, or what is wrong with them.
const blueprintOf = (typed: Readonly<Record<GroupId, string>>): { readonly blueprint: Blueprint } | { readonly problems: ReadonlyArray<string> } => {
  const problems: Array<string> = []
  const value: Record<string, number | ReadonlyArray<number>> = {}
  for (const group of BlueprintGroups) {
    const text = typed[group.id].trim()
    if (group.units) {
      const sizes = sizesOf(text)
      if (
        sizes === undefined || sizes.length < UnitsRange.minimum || sizes.length > UnitsRange.maximum ||
        sizes.some((size) => size < UnitSizeRange.minimum || size > UnitSizeRange.maximum)
      ) {
        problems.push(
          `Give ${group.name} ${UnitsRange.minimum} to ${UnitsRange.maximum} ${group.id === "rc" ? "passages" : "sets"} of ${UnitSizeRange.minimum} to ${UnitSizeRange.maximum} Questions, such as 3, 3, 3, 4.`
        )
      } else value[group.id] = sizes
    } else {
      const count = /^\d+$/.test(text) ? Number(text) : undefined
      if (count === undefined || count < GroupCountRange.minimum || count > GroupCountRange.maximum) {
        problems.push(`Give ${group.name} ${GroupCountRange.minimum} to ${GroupCountRange.maximum} Questions.`)
      } else value[group.id] = count
    }
  }
  return problems.length > 0 ? { problems } : { blueprint: value as unknown as Blueprint }
}

const typedOf = (blueprint: Blueprint) =>
  Object.fromEntries(BlueprintGroups.map((group) => [group.id, blueprintText(blueprint, group.id)])) as Record<GroupId, string>

const totalOf = (typed: Readonly<Record<GroupId, string>>, section: BlueprintSection) =>
  BlueprintGroups.filter((group) => group.section === section).reduce((sum, group) => {
    const sizes = group.units ? sizesOf(typed[group.id]) : /^\d+$/.test(typed[group.id].trim()) ? [Number(typed[group.id])] : undefined
    return sum === undefined || sizes === undefined ? undefined : sum + sizes.reduce((total, size) => total + size, 0)
  }, 0 as number | undefined)

// How many Questions each group gets in a Mock or Sectional Section, and the
// sizes of RC passages and MSR sets.
const SectionBlueprint = ({ onFailure }: { readonly onFailure: (failure: { readonly _tag: string }) => void }) => {
  const id = useId()
  const [view, setView] = useState<BlueprintView>()
  const [typed, setTyped] = useState<Record<GroupId, string>>()
  const [problems, setProblems] = useState<ReadonlyArray<string>>([])
  const [saved, setSaved] = useState<string>()
  const busy = useRef(false)

  useEffect(() => {
    let live = true
    void call((client) => client.settings.blueprint()).then((result) => {
      if (!live) return
      if (result._tag === "Failure") return onFailure(result.failure)
      setView(result.success)
      setTyped(typedOf(result.success.blueprint))
    })
    return () => {
      live = false
    }
    // Loads once, when the screen opens.
  }, [])

  if (view === undefined || typed === undefined) return null

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSaved(undefined)
    const read = blueprintOf(typed)
    if ("problems" in read) return setProblems(read.problems)
    setProblems([])
    if (busy.current) return
    busy.current = true
    const result = await call((client) => client.settings.saveBlueprint({ payload: { blueprint: read.blueprint } }))
    busy.current = false
    if (result._tag === "Failure") return onFailure(result.failure)
    setView(result.success)
    setTyped(typedOf(result.success.blueprint))
    const released = result.success.released ?? 0
    const joined = result.success.joined ?? 0
    setSaved(
      [
        "Blueprint saved.",
        released === 0
          ? undefined
          : `${released} ${released === 1 ? "passage or set" : "passages and sets"} held for Mocks fit no slot now and went to Practice Sets.`,
        joined === 0
          ? undefined
          : `${joined} ${joined === 1 ? "Question" : "Questions"} in passages and sets the new slot sizes take ${
            joined === 1 ? "is" : "are"
          } now held for Mocks.`
      ].filter((part) => part !== undefined).join(" ")
    )
  }

  return (
    <section className="group" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Section Blueprint</h2>
      <p className="group-about">
        How many Questions each group gets in a Mock or Sectional Section. RC passages and MSR sets are served whole,
        so they are given as the size of each one. GMAC does not publish the mix; these start at common estimates.
      </p>
      <form className="target-times" noValidate onSubmit={(event) => void save(event)}>
        {(Object.keys(SectionNames) as Array<BlueprintSection>).map((section) => {
          const total = totalOf(typed, section)
          return (
            <fieldset key={section} className="target-section">
              <legend>
                {SectionNames[section]}
                {total === undefined ? "" : `, ${total} Questions`}
              </legend>
              <div className="target-fields">
                {BlueprintGroups.filter((group) => group.section === section).map((group) => (
                  <div key={group.id} className="field target-field">
                    <label htmlFor={`${id}-${group.id}`}>
                      {group.name}
                      {group.units ? (group.id === "rc" ? ", passage sizes" : ", set sizes") : ""}
                    </label>
                    <input
                      id={`${id}-${group.id}`}
                      className={group.units ? undefined : "number-input"}
                      type="text"
                      inputMode={group.units ? "text" : "numeric"}
                      autoComplete="off"
                      value={typed[group.id]}
                      aria-describedby={`${id}-${group.id}-default`}
                      onChange={(event) => {
                        setSaved(undefined)
                        setTyped({ ...typed, [group.id]: event.target.value })
                      }}
                    />
                    <span id={`${id}-${group.id}-default`} className="field-note">
                      Default {blueprintText(view.defaults, group.id)}
                    </span>
                  </div>
                ))}
              </div>
            </fieldset>
          )
        })}
        <p className="hint">
          Passages and sets held for Mocks that fit no slot after a change go to Practice Sets, and stay there if you
          change it back.
        </p>
        <div className="actions">
          <button type="submit" className="button">Save the Blueprint</button>
          <button
            type="button"
            className="button button-quiet"
            onClick={() => {
              setSaved(undefined)
              setTyped(typedOf(view.defaults))
            }}
          >
            Fill in the defaults
          </button>
          <p className="saved" role="status">{saved ?? ""}</p>
        </div>
        {problems.length > 0 && (
          <div className="problem" role="alert">
            {problems.map((problem) => <p key={problem}>{problem}</p>)}
          </div>
        )}
      </form>
    </section>
  )
}

// Tutor Chat's monthly cap (decision 106): what it spent this month, in
// the app's time zone, and the cap to stop at.
const TutorCap = ({ onFailure }: { readonly onFailure: (failure: { readonly _tag: string }) => void }) => {
  const id = useId()
  const [spend, setSpend] = useState<TutorSpendView>()
  const [typed, setTyped] = useState("")
  const [problem, setProblem] = useState<string>()
  const [saved, setSaved] = useState<string>()
  const busy = useRef(false)

  useEffect(() => {
    let live = true
    void call((client) => client.curatorTutor.spend()).then((result) => {
      if (!live) return
      if (result._tag === "Failure") return onFailure(result.failure)
      setSpend(result.success)
      setTyped(String(result.success.cap))
    })
    return () => {
      live = false
    }
    // Loads once, when the screen opens.
  }, [])

  if (spend === undefined) return null
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSaved(undefined)
    const cap = Number(typed.trim())
    if (typed.trim() === "" || !Number.isFinite(cap) || cap < 0 || cap > 10_000) {
      return setProblem("Give the cap in dollars, from 0 to 10,000.")
    }
    setProblem(undefined)
    if (busy.current) return
    busy.current = true
    const result = await call((client) => client.curatorTutor.saveCap({ payload: { cap } }))
    busy.current = false
    if (result._tag === "Failure") return onFailure(result.failure)
    setSpend(result.success)
    setSaved("Cap saved.")
  }
  return (
    <section className="group" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Tutor Chat</h2>
      <p className="group-about">
        Tutor Chat calls the model as Learners ask, so its spend is capped each month. It has spent{" "}
        {formatDollars(spend.spent)} this month; once it reaches the
        cap, the chat says so until the month ends or you raise it.
      </p>
      {spend.refused !== null && (
        <p className="problem tutor-refused">
          The model's API refused the latest Tutor Chat call, on {dayAndTime(spend.refused.at)}, saying "{spend.refused.detail}".
          Learners are told to come to you. Check the API key and the Tutor Chat model above, then test the connection.
        </p>
      )}
      <form className="tutor-cap" noValidate onSubmit={(event) => void save(event)}>
        <div className="field">
          <label htmlFor={`${id}-cap`}>Monthly cap, dollars</label>
          <input
            id={`${id}-cap`}
            className="number-input"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={typed}
            onChange={(event) => {
              setSaved(undefined)
              setTyped(event.target.value)
            }}
          />
        </div>
        <div className="actions">
          <button type="submit" className="button">Save the cap</button>
          <p className="saved" role="status">{saved ?? ""}</p>
        </div>
        {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
      </form>
    </section>
  )
}
