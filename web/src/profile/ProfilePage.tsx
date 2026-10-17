import { useEffect, useId, useRef, useState } from "react"
import type { ProfileSummary } from "../../../src/api/Profiles.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { dayAndTime } from "../format.ts"

// The Learner's own Profile (docs/design.md, "Data safety and operations"):
// a download of everything it holds, and deleting it.

interface Props {
  readonly profile: ProfileSummary
  readonly onDeleted: () => void
  readonly onSessionLost: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

const fileName = (name: string) => `gmat-prep-${name.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "profile"}-${new Date().toISOString().slice(0, 10)}.json`

export const ProfilePage = ({ profile, onDeleted, onSessionLost, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const handle = (failure: { readonly _tag: string }) => (failure._tag === "NotUnlocked" ? onSessionLost() : onStopped(failure))
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>{profile.name}</h1>
      <Download profile={profile} onFailure={handle} />
      <Delete profile={profile} onDeleted={onDeleted} onFailure={handle} />
    </>
  )
}

const Download = ({ profile, onFailure }: { readonly profile: ProfileSummary; readonly onFailure: (failure: { readonly _tag: string }) => void }) => {
  const [saved, setSaved] = useState<string>()
  const [busy, setBusy] = useState(false)
  const download = async () => {
    if (busy) return
    setBusy(true)
    setSaved(undefined)
    const result = await call((client) => client.sessionData.export())
    setBusy(false)
    if (result._tag === "Failure") return onFailure(result.failure)
    const url = URL.createObjectURL(new Blob([JSON.stringify(result.success, null, 2)], { type: "application/json" }))
    const link = document.createElement("a")
    link.href = url
    link.download = fileName(profile.name)
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    setSaved(`Your data, as of ${dayAndTime(result.success.exportedAt)}, is in ${link.download}.`)
  }
  return (
    <section className="group" aria-labelledby="download-title">
      <h2 id="download-title">Your data</h2>
      <p className="group-about">
        A file of everything this profile holds: your sets and answers, Sectionals and Mocks, scores, plan, notes and
        chats with the tutor. It has no PIN in it.
      </p>
      <div className="actions">
        <button type="button" className="button" aria-busy={busy} onClick={() => void download()}>
          {busy ? "Gathering your data" : "Download my data"}
        </button>
      </div>
      <div role="status">{saved !== undefined && <p className="saved">{saved}</p>}</div>
    </section>
  )
}

const Delete = (
  { profile, onDeleted, onFailure }: {
    readonly profile: ProfileSummary
    readonly onDeleted: () => void
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const pinId = useId()
  const [asking, setAsking] = useState(false)
  const [pin, setPin] = useState("")
  const [problem, setProblem] = useState<string>()
  const opener = useRef<HTMLButtonElement>(null)
  const busy = useRef(false)
  const keep = () => {
    setAsking(false)
    setPin("")
    setProblem(undefined)
    window.requestAnimationFrame(() => opener.current?.focus())
  }
  const remove = async () => {
    if (busy.current) return
    if (profile.hasPin && !/^\d{4,8}$/.test(pin)) return setProblem("Enter your PIN, 4 to 8 digits.")
    busy.current = true
    const result = await call((client) => client.sessionData.remove({ payload: profile.hasPin ? { pin } : {} }))
    busy.current = false
    if (result._tag === "Success") return onDeleted()
    const failure = result.failure
    switch (failure._tag) {
      case "WrongPin":
        return setProblem(`That is not your PIN. ${failure.attemptsLeft} more tries before the profile locks for 5 minutes.`)
      case "ProfileLocked":
        return setProblem(`Too many wrong PINs: the profile is locked until ${dayAndTime(failure.lockedUntil)}.`)
      case "PinRequired":
        return setProblem("Enter your PIN.")
      case "SnapshotFailed":
        return setProblem(`Nothing was deleted, as the snapshot taken first failed: ${failure.detail}`)
      default:
        return onFailure(failure)
    }
  }
  return (
    <section className="group" aria-labelledby="delete-title">
      <h2 id="delete-title">Delete this profile</h2>
      <p className="group-about">
        Deleting removes everything it holds from the app. A snapshot of the database is taken first, which only the
        Curator can restore. Copies stay in the snapshots until the app deletes them, the daily ones within about five
        weeks, and in the install's last archive, if the Curator made one.
      </p>
      {asking
        ? (
          <form
            className="data-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              void remove()
            }}
          >
            <p>Delete {profile.name} for good?</p>
            {profile.hasPin && (
              <>
                <label htmlFor={pinId}>Your PIN</label>
                <PinField
                  id={pinId}
                  value={pin}
                  problem={problem === undefined ? undefined : `${pinId}-problem`}
                  onChange={setPin}
                />
              </>
            )}
            {problem !== undefined && <p id={`${pinId}-problem`} className="field-error" role="alert">{problem}</p>}
            <div className="actions">
              <button type="submit" className="button">Delete it</button>
              <KeepButton onKeep={keep} focus={!profile.hasPin} />
            </div>
          </form>
        )
        : (
          <div className="actions">
            <button ref={opener} type="button" className="button button-quiet" onClick={() => setAsking(true)}>
              Delete this profile
            </button>
          </div>
        )}
    </section>
  )
}

// problem: the id of the message that says what is wrong with it, if any.
const PinField = (
  { id, value, problem, onChange }: {
    readonly id: string
    readonly value: string
    readonly problem: string | undefined
    readonly onChange: (value: string) => void
  }
) => {
  const ref = useFocusOnMount<HTMLInputElement>()
  return (
    <input
      ref={ref}
      id={id}
      className="number-input"
      type="password"
      inputMode="numeric"
      autoComplete="off"
      value={value}
      aria-invalid={problem !== undefined}
      aria-describedby={problem}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

// The way out, focused when the question has no field to fill first.
const KeepButton = ({ onKeep, focus }: { readonly onKeep: () => void; readonly focus: boolean }) => {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (focus) ref.current?.focus()
  }, [focus])
  return <button ref={ref} type="button" className="button button-quiet" onClick={onKeep}>Keep it</button>
}
