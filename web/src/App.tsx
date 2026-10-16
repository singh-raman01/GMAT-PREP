import { useCallback, useEffect, useRef, useState } from "react"
import type { ProfileSummary } from "../../src/api/Profiles.ts"
import { announceUnlockChanged, call, onUnlockChanged, showProfile, type Trouble, troubleOf } from "./api.ts"
import { CuratorArea } from "./curator/CuratorArea.tsx"
import { useFocusOnMount } from "./focus.ts"
import { PracticeHome } from "./practice/PracticeHome.tsx"
import { PracticeSet } from "./practice/PracticeSet.tsx"
import { ProfilePicker } from "./ProfilePicker.tsx"
import { linkProps, usePath } from "./router.ts"
import { TaxonomyBrowser } from "./TaxonomyBrowser.tsx"

type Screen =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Stopped"; readonly trouble: Trouble }
  | { readonly _tag: "Picking"; readonly notice: string | undefined }
  | { readonly _tag: "Studying"; readonly profile: ProfileSummary }

export const App = () => {
  const path = usePath()
  const [screen, setScreen] = useState<Screen>({ _tag: "Starting" })
  const shown = useRef<string | undefined>(undefined)

  const show = useCallback((next: Screen) => {
    const profileId = next._tag === "Studying" ? next.profile.id : undefined
    shown.current = profileId
    showProfile(profileId)
    setScreen(next)
  }, [])

  const stop = useCallback((error: { readonly _tag: string }) => {
    show({ _tag: "Stopped", trouble: troubleOf(error) })
  }, [show])

  // Asks the server which Profile this browser has unlocked, if any. An
  // unlock survives a reload, because the cookie does; it can also change in
  // another tab. notice is shown if no Profile is unlocked.
  const recheck = useCallback(async (notice?: string) => {
    showProfile(undefined)
    const result = await call((client) => client.session.me())
    if (result._tag === "Success") {
      if (shown.current === result.success.id) {
        showProfile(result.success.id)
      } else {
        show({ _tag: "Studying", profile: result.success })
      }
    } else if (result.failure._tag === "NotUnlocked") {
      if (shown.current !== undefined || notice !== undefined) {
        show({ _tag: "Picking", notice })
      } else {
        setScreen((current) => (current._tag === "Picking" ? current : { _tag: "Picking", notice: undefined }))
      }
    } else {
      stop(result.failure)
    }
  }, [show, stop])

  useEffect(() => {
    void recheck()
    const onVisible = () => {
      if (document.visibilityState === "visible") void recheck()
    }
    document.addEventListener("visibilitychange", onVisible)
    const stopListening = onUnlockChanged(() => void recheck())
    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      stopListening()
    }
  }, [recheck])

  const unlocked = useCallback((profile: ProfileSummary) => {
    show({ _tag: "Studying", profile })
    announceUnlockChanged()
  }, [show])

  const lock = useCallback(async () => {
    const result = await call((client) => client.session.lock())
    if (result._tag === "Failure" && result.failure._tag !== "NotUnlocked") {
      return stop(result.failure)
    }
    announceUnlockChanged()
    await recheck()
  }, [recheck, stop])

  const sessionLost = useCallback(() => {
    void recheck("Your profile was locked, so open it again to carry on.")
  }, [recheck])

  if (screen._tag === "Stopped") {
    return <Stopped trouble={screen.trouble} onRetry={() => void recheck()} />
  }
  if (path === "/curator" || path.startsWith("/curator/")) {
    return <CuratorArea path={path} onStopped={stop} />
  }

  switch (screen._tag) {
    case "Starting":
      return null
    case "Picking":
      return <ProfilePicker notice={screen.notice} onUnlocked={unlocked} onStopped={stop} />
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
            <LearnerArea key={screen.profile.id} path={path} onSessionLost={sessionLost} onStopped={stop} />
          </main>
        </>
      )
  }
}

// A Learner's pages: Practice, a set, and the Taxonomy.
const LearnerArea = ({ path, onSessionLost, onStopped }: {
  readonly path: string
  readonly onSessionLost: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}) => {
  const setId = /^\/practice\/([^/]+)$/.exec(path)?.[1]
  if (setId !== undefined) {
    return <PracticeSet key={setId} id={setId} onSessionLost={onSessionLost} onStopped={onStopped} />
  }
  const taxonomy = path === "/taxonomy"
  return (
    <>
      <nav className="subnav" aria-label="Learner pages">
        <a {...linkProps("/")} aria-current={taxonomy ? undefined : "page"}>
          <span className={taxonomy ? undefined : "mark"}>Practice</span>
        </a>
        <a {...linkProps("/taxonomy")} aria-current={taxonomy ? "page" : undefined}>
          <span className={taxonomy ? "mark" : undefined}>What the GMAT tests</span>
        </a>
      </nav>
      {taxonomy
        ? <TaxonomyBrowser onSessionLost={onSessionLost} onStopped={onStopped} />
        : <PracticeHome onSessionLost={onSessionLost} onStopped={onStopped} />}
    </>
  )
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

const Stopped = ({ trouble, onRetry }: { readonly trouble: Trouble; readonly onRetry: () => void }) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const text = troubleText[trouble]
  const act = () => (trouble === "unreadable" ? window.location.reload() : onRetry())
  return (
    <main className="page page-narrow">
      <p className="wordmark">GMAT prep</p>
      <h1 ref={heading} tabIndex={-1}>{text.title}</h1>
      <p className="lede">{text.body}</p>
      <button type="button" className="button" onClick={act}>
        {text.action}
      </button>
    </main>
  )
}
