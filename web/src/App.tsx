import { useCallback, useEffect, useState } from "react"
import type { ProfileSummary } from "../../src/api/Profiles.ts"
import { call, type Trouble, troubleOf } from "./api.ts"
import { ProfilePicker } from "./ProfilePicker.tsx"
import { TaxonomyBrowser } from "./TaxonomyBrowser.tsx"

type Screen =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Stopped"; readonly trouble: Trouble }
  | { readonly _tag: "Picking"; readonly notice: string | undefined }
  | { readonly _tag: "Studying"; readonly profile: ProfileSummary }

export const App = () => {
  const [screen, setScreen] = useState<Screen>({ _tag: "Starting" })

  const stop = useCallback((error: { readonly _tag: string }) => {
    setScreen({ _tag: "Stopped", trouble: troubleOf(error) })
  }, [])

  // An unlocked Profile survives a reload, because the cookie does.
  const start = useCallback(async () => {
    const result = await call((client) => client.session.me())
    if (result._tag === "Success") {
      setScreen({ _tag: "Studying", profile: result.success })
    } else if (result.failure._tag === "NotUnlocked") {
      setScreen({ _tag: "Picking", notice: undefined })
    } else {
      stop(result.failure)
    }
  }, [stop])

  useEffect(() => {
    void start()
  }, [start])

  const lock = useCallback(async () => {
    const result = await call((client) => client.session.lock())
    if (result._tag === "Failure" && result.failure._tag !== "NotUnlocked") {
      stop(result.failure)
    } else {
      setScreen({ _tag: "Picking", notice: undefined })
    }
  }, [stop])

  const sessionLost = useCallback(() => {
    setScreen({ _tag: "Picking", notice: "Your profile was locked, so open it again to carry on." })
  }, [])

  switch (screen._tag) {
    case "Starting":
      return null
    case "Stopped":
      return <Stopped trouble={screen.trouble} onRetry={start} />
    case "Picking":
      return (
        <ProfilePicker
          notice={screen.notice}
          onUnlocked={(profile) => setScreen({ _tag: "Studying", profile })}
          onStopped={stop}
        />
      )
    case "Studying":
      return (
        <>
          <header className="topbar">
            <span className="wordmark">GMAT prep</span>
            <div className="who">
              <span className="who-name">{screen.profile.name}</span>
              <button type="button" className="button button-quiet" onClick={() => void lock()}>
                Lock
              </button>
            </div>
          </header>
          <main className="page">
            <TaxonomyBrowser onSessionLost={sessionLost} onStopped={stop} />
          </main>
        </>
      )
  }
}

const troubleText: Record<Trouble, { readonly title: string; readonly body: string; readonly action: string }> = {
  unreachable: {
    title: "GMAT prep is not responding",
    body: "The app may have stopped. Start it again, then try again here.",
    action: "Try again"
  },
  failed: {
    title: "The app could not finish that",
    body: "Something failed inside the app. Try again, and restart the app if it keeps happening.",
    action: "Try again"
  },
  unreadable: {
    title: "This page needs a reload",
    body: "The app sent a reply this page could not read, which happens when a page stays open across an update.",
    action: "Reload page"
  }
}

const Stopped = ({ trouble, onRetry }: { readonly trouble: Trouble; readonly onRetry: () => Promise<void> }) => {
  const text = troubleText[trouble]
  const act = () => (trouble === "unreadable" ? window.location.reload() : void onRetry())
  return (
    <main className="page page-narrow">
      <p className="wordmark">GMAT prep</p>
      <h1>{text.title}</h1>
      <p className="lede">{text.body}</p>
      <button type="button" className="button" onClick={act}>
        {text.action}
      </button>
    </main>
  )
}
