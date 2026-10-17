import { Schema } from "effect"
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react"
import { Passphrase } from "../../../src/api/Curator.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { clockTime, minutesAndSeconds } from "../format.ts"
import { linkProps, navigate } from "../router.ts"
import { BookPage } from "./BookPage.tsx"
import { CuratorBooks } from "./CuratorBooks.tsx"
import { CuratorJobs } from "./CuratorJobs.tsx"
import { CuratorSettings } from "./CuratorSettings.tsx"
import { Generation } from "./Generation.tsx"
import { GoldenSet } from "./GoldenSet.tsx"
import { OverviewPage } from "./OverviewPage.tsx"
import { SiblingsPage } from "./SiblingsPage.tsx"
import { CuratorLesson, CuratorLessons } from "./LessonsPage.tsx"
import { ReviewQueue } from "./ReviewQueue.tsx"

type Stop = (error: { readonly _tag: string }) => void

const isPassphrase = Schema.is(Passphrase)

type Gate =
  | { readonly _tag: "Checking" }
  | { readonly _tag: "Setting" }
  | { readonly _tag: "Unlocking"; readonly notice: string | undefined }
  | { readonly _tag: "Open" }

// The Curator's tools, behind the Curator passphrase.
export const CuratorArea = ({ path, onStopped }: { readonly path: string; readonly onStopped: Stop }) => {
  const [gate, setGate] = useState<Gate>({ _tag: "Checking" })
  // A message for the page the Curator is sent to, such as a Book that was
  // added before. It is dropped once the Curator moves on from that page.
  const [notice, setNotice] = useState<{ readonly text: string; readonly path: string }>()
  useEffect(() => {
    setNotice((current) => (current !== undefined && current.path !== path ? undefined : current))
  }, [path])

  const check = useCallback(async () => {
    const result = await call((client) => client.curatorAccess.status())
    if (result._tag === "Failure") return onStopped(result.failure)
    const status = result.success
    setGate(
      !status.passphraseSet
        ? { _tag: "Setting" }
        : status.unlocked
        ? { _tag: "Open" }
        : { _tag: "Unlocking", notice: undefined }
    )
  }, [onStopped])

  useEffect(() => {
    void check()
  }, [check])

  const locked = useCallback(() => {
    setGate({ _tag: "Unlocking", notice: "The Curator tools were locked, so unlock them again to carry on." })
  }, [])

  const lock = async () => {
    const result = await call((client) => client.curatorSession.lock())
    if (result._tag === "Failure" && result.failure._tag !== "CuratorNotUnlocked") return onStopped(result.failure)
    setGate({ _tag: "Unlocking", notice: undefined })
  }

  switch (gate._tag) {
    case "Checking":
      return null
    case "Setting":
      return <SetPassphrase onSet={() => setGate({ _tag: "Open" })} onStopped={onStopped} />
    case "Unlocking":
      return <Unlock notice={gate.notice} onUnlocked={() => setGate({ _tag: "Open" })} onStopped={onStopped} />
    case "Open": {
      const section = path.startsWith("/curator/settings")
        ? "settings"
        : path.startsWith("/curator/jobs")
        ? "jobs"
        : path.startsWith("/curator/review")
        ? "review"
        : path.startsWith("/curator/golden")
        ? "golden"
        : path.startsWith("/curator/generate")
        ? "generate"
        : path.startsWith("/curator/siblings")
        ? "siblings"
        : path.startsWith("/curator/lessons")
        ? "lessons"
        : path.startsWith("/curator/books")
        ? "books"
        : "overview"
      const bookId = /^\/curator\/books\/([^/]+)/.exec(path)?.[1]
      const lessonId = /^\/curator\/lessons\/([^/]+)/.exec(path)?.[1]
      return (
        <>
          <header className="topbar">
            <span className="wordmark">GMAT prep</span>
            <div className="who">
              <a className="quiet-link" {...linkProps("/")}>Profiles</a>
              <span className="who-name">Curator</span>
              <button type="button" className="button button-quiet" onClick={() => void lock()}>
                Lock
              </button>
            </div>
          </header>
          <main className="page">
            <nav className="subnav" aria-label="Curator tools">
              <a {...linkProps("/curator")} aria-current={section === "overview" ? "page" : undefined}>
                <span className={section === "overview" ? "mark" : undefined}>Overview</span>
              </a>
              <a {...linkProps("/curator/books")} aria-current={section === "books" && bookId === undefined ? "page" : undefined}>
                <span className={section === "books" ? "mark" : undefined}>Books</span>
              </a>
              <a {...linkProps("/curator/review")} aria-current={section === "review" ? "page" : undefined}>
                <span className={section === "review" ? "mark" : undefined}>Review Queue</span>
              </a>
              <a {...linkProps("/curator/golden")} aria-current={section === "golden" ? "page" : undefined}>
                <span className={section === "golden" ? "mark" : undefined}>Golden set</span>
              </a>
              <a {...linkProps("/curator/generate")} aria-current={section === "generate" ? "page" : undefined}>
                <span className={section === "generate" ? "mark" : undefined}>Generate</span>
              </a>
              <a {...linkProps("/curator/siblings")} aria-current={section === "siblings" ? "page" : undefined}>
                <span className={section === "siblings" ? "mark" : undefined}>Siblings</span>
              </a>
              <a {...linkProps("/curator/lessons")} aria-current={section === "lessons" && lessonId === undefined ? "page" : undefined}>
                <span className={section === "lessons" ? "mark" : undefined}>Lessons</span>
              </a>
              <a {...linkProps("/curator/jobs")} aria-current={section === "jobs" ? "page" : undefined}>
                <span className={section === "jobs" ? "mark" : undefined}>Jobs</span>
              </a>
              <a {...linkProps("/curator/settings")} aria-current={section === "settings" ? "page" : undefined}>
                <span className={section === "settings" ? "mark" : undefined}>Settings</span>
              </a>
            </nav>
            {section === "settings"
              ? (
                <CuratorSettings
                  key="settings"
                  onLocked={locked}
                  onStopped={onStopped}
                  onTestStarted={() => navigate("/curator/jobs")}
                />
              )
              : section === "jobs"
              ? <CuratorJobs key="jobs" onLocked={locked} onStopped={onStopped} />
              : section === "review"
              ? <ReviewQueue key="review" onLocked={locked} onStopped={onStopped} />
              : section === "golden"
              ? <GoldenSet key="golden" onLocked={locked} onStopped={onStopped} />
              : section === "generate"
              ? <Generation key="generate" onLocked={locked} onStopped={onStopped} />
              : section === "siblings"
              ? <SiblingsPage key="siblings" onLocked={locked} onStopped={onStopped} />
              : section === "lessons"
              ? lessonId === undefined
                ? <CuratorLessons key="lessons" onLocked={locked} onStopped={onStopped} />
                : <CuratorLesson key={lessonId} id={lessonId} onLocked={locked} onStopped={onStopped} />
              : section === "overview"
              ? <OverviewPage key="overview" onLocked={locked} onStopped={onStopped} />
              : bookId !== undefined
              ? (
                <BookPage
                  key={bookId}
                  id={bookId}
                  notice={notice?.path === path ? notice.text : undefined}
                  onLocked={locked}
                  onStopped={onStopped}
                />
              )
              : (
                <CuratorBooks
                  key="books"
                  onLocked={locked}
                  onStopped={onStopped}
                  onNotice={(text, page) => setNotice({ text, path: page })}
                />
              )}
          </main>
        </>
      )
    }
  }
}

const SetPassphrase = ({ onSet, onStopped }: { readonly onSet: () => void; readonly onStopped: Stop }) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const ids = { passphrase: useId(), repeat: useId(), hint: useId() }
  const [passphrase, setPassphrase] = useState("")
  const [repeat, setRepeat] = useState("")
  const [problem, setProblem] = useState<{ readonly field: "passphrase" | "repeat"; readonly text: string }>()
  const busy = useRef(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy.current) return
    if (!isPassphrase(passphrase)) {
      return setProblem({ field: "passphrase", text: "Use a passphrase of 8 to 200 characters." })
    }
    if (repeat !== passphrase) {
      return setProblem({ field: "repeat", text: "The two passphrases do not match." })
    }
    busy.current = true
    const result = await call((client) => client.curatorAccess.setPassphrase({ payload: { passphrase } }))
    busy.current = false
    if (result._tag === "Success") return onSet()
    if (result.failure._tag === "PassphraseAlreadySet") {
      return setProblem({ field: "passphrase", text: "A passphrase was set a moment ago. Reload the page to unlock." })
    }
    onStopped(result.failure)
  }

  return (
    <main className="page page-narrow">
      <p className="wordmark">GMAT prep</p>
      <h1 ref={heading} tabIndex={-1}>Set the Curator passphrase</h1>
      <p className="lede">
        The Curator adds books, reviews questions and sets up the LLM. A passphrase guards those tools on this
        computer.
      </p>
      <form className="add-form" noValidate onSubmit={(event) => void submit(event)}>
        <div className="field">
          <label htmlFor={ids.passphrase}>Passphrase</label>
          <p id={ids.hint} className="hint">At least 8 characters. A few words are easier to remember.</p>
          <input
            id={ids.passphrase}
            type="password"
            autoComplete="new-password"
            value={passphrase}
            aria-invalid={problem?.field === "passphrase"}
            aria-describedby={problem?.field === "passphrase" ? `${ids.passphrase}-error ${ids.hint}` : ids.hint}
            onChange={(event) => setPassphrase(event.target.value)}
          />
          {problem?.field === "passphrase" && (
            <p id={`${ids.passphrase}-error`} className="field-error">{problem.text}</p>
          )}
        </div>
        <div className="field">
          <label htmlFor={ids.repeat}>Repeat the passphrase</label>
          <input
            id={ids.repeat}
            type="password"
            autoComplete="new-password"
            value={repeat}
            aria-invalid={problem?.field === "repeat"}
            aria-describedby={problem?.field === "repeat" ? `${ids.repeat}-error` : undefined}
            onChange={(event) => setRepeat(event.target.value)}
          />
          {problem?.field === "repeat" && <p id={`${ids.repeat}-error`} className="field-error">{problem.text}</p>}
        </div>
        <div className="actions">
          <button type="submit" className="button">Set passphrase</button>
          <a className="button button-quiet" {...linkProps("/")}>Back to profiles</a>
        </div>
      </form>
    </main>
  )
}

const Unlock = (
  { notice, onUnlocked, onStopped }: {
    readonly notice: string | undefined
    readonly onUnlocked: () => void
    readonly onStopped: Stop
  }
) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const inputId = useId()
  const problemId = useId()
  const [passphrase, setPassphrase] = useState("")
  const [problem, setProblem] = useState<string>()
  const [lockedUntil, setLockedUntil] = useState<number>()
  const [now, setNow] = useState(() => Date.now())
  const busy = useRef(false)
  const locked = lockedUntil !== undefined && now < lockedUntil

  useEffect(() => {
    if (lockedUntil === undefined) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [lockedUntil])

  useEffect(() => {
    if (lockedUntil !== undefined && !locked) {
      setLockedUntil(undefined)
      setProblem("The lock has ended, so you can enter the passphrase again.")
    }
  }, [locked, lockedUntil])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy.current || locked) return
    if (passphrase === "") return setProblem("Enter the Curator passphrase.")
    busy.current = true
    const result = await call((client) => client.curatorAccess.unlock({ payload: { passphrase } }))
    busy.current = false
    if (result._tag === "Success") return onUnlocked()
    const failure = result.failure
    switch (failure._tag) {
      case "WrongPassphrase": {
        const left = failure.attemptsLeft
        setPassphrase("")
        return setProblem(
          `That passphrase is wrong. ${left} ${left === 1 ? "try" : "tries"} left before the Curator tools lock for 5 minutes.`
        )
      }
      case "CuratorLocked":
        setPassphrase("")
        setProblem(undefined)
        setNow(Date.now())
        return setLockedUntil(failure.lockedUntil)
      case "PassphraseNotSet":
        return window.location.reload()
      default:
        return onStopped(failure)
    }
  }

  return (
    <main className="page page-narrow">
      <p className="wordmark">GMAT prep</p>
      <h1 ref={heading} tabIndex={-1}>Unlock the Curator tools</h1>
      {notice !== undefined && <p className="notice" role="status">{notice}</p>}
      <form className="add-form" noValidate onSubmit={(event) => void submit(event)}>
        <div className="field">
          <label htmlFor={inputId}>Curator passphrase</label>
          <input
            id={inputId}
            type="password"
            autoComplete="current-password"
            value={passphrase}
            readOnly={locked}
            aria-disabled={locked}
            aria-invalid={problem !== undefined && !locked}
            aria-describedby={problemId}
            onChange={(event) => setPassphrase(event.target.value)}
          />
        </div>
        <div id={problemId} aria-live="polite">
          {locked && lockedUntil !== undefined
            ? <p className="problem">Too many wrong passphrases, so the tools are locked until {clockTime(lockedUntil)}.</p>
            : problem !== undefined && <p className="problem">{problem}</p>}
        </div>
        {locked && lockedUntil !== undefined && (
          <p className="countdown" aria-hidden="true">{minutesAndSeconds(lockedUntil - now)} left</p>
        )}
        <div className="actions">
          <button type="submit" className="button" aria-disabled={locked}>Unlock</button>
          <a className="button button-quiet" {...linkProps("/")}>Back to profiles</a>
        </div>
      </form>
      <p className="hint aside">
        Forgotten it? On this computer, run <code>gmat-prep reset-passphrase</code>, then set a new one here.
      </p>
    </main>
  )
}
