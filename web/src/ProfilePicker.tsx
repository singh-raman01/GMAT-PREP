import { Schema } from "effect"
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react"
import { Pin, ProfileName, type ProfileSummary } from "../../src/api/Profiles.ts"
import { call } from "./api.ts"
import { clockTime, minutesAndSeconds } from "./format.ts"
import { linkProps } from "./router.ts"

type Stop = (error: { readonly _tag: string }) => void

const isPin = Schema.is(Pin)
const isProfileName = Schema.is(ProfileName)

const digitsOnly = (value: string) => value.replace(/\D/g, "")

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

const browserTimeZone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}


interface PickerProps {
  readonly notice: string | undefined
  readonly onUnlocked: (profile: ProfileSummary) => void
  readonly onStopped: Stop
}

export const ProfilePicker = ({ notice, onUnlocked, onStopped }: PickerProps) => {
  const [profiles, setProfiles] = useState<ReadonlyArray<ProfileSummary>>()
  const [openId, setOpenId] = useState<string>()
  const [adding, setAdding] = useState(false)
  const [message, setMessage] = useState(notice)
  const busy = useRef(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const cancelAdding = () => {
    setAdding(false)
    // The form and its focus go away; focus goes back to the button that opened it.
    requestAnimationFrame(() => addButton.current?.focus())
  }

  const load = useCallback(async () => {
    const result = await call((client) => client.profiles.list())
    if (result._tag === "Success") setProfiles(result.success)
    else onStopped(result.failure)
  }, [onStopped])

  useEffect(() => {
    void load()
  }, [load])

  // Focus the heading once the list of Profiles appears.
  const listShown = profiles !== undefined && profiles.length > 0
  useEffect(() => {
    if (listShown) heading.current?.focus()
  }, [listShown])

  const gone = useCallback((name: string) => {
    setOpenId(undefined)
    setMessage(`The profile ${name} no longer exists.`)
    void load()
  }, [load])

  // A Profile without a PIN opens at once; one with a PIN asks for it below its name.
  const choose = async (profile: ProfileSummary) => {
    if (profile.hasPin) {
      setOpenId((current) => (current === profile.id ? undefined : profile.id))
      return
    }
    if (busy.current) return
    busy.current = true
    const result = await call((client) => client.profiles.unlock({ params: { id: profile.id }, payload: {} }))
    busy.current = false
    if (result._tag === "Success") return onUnlocked(result.success)
    switch (result.failure._tag) {
      case "ProfileNotFound":
        return gone(profile.name)
      case "PinRequired":
      case "WrongPin":
      case "ProfileLocked":
        // The Profile has a PIN that this list did not show yet.
        await load()
        return setOpenId(profile.id)
      default:
        return onStopped(result.failure)
    }
  }

  if (profiles === undefined) return <main className="page picker" aria-busy="true" />

  const noticeLine = message === undefined ? null : <p className="notice" role="status">{message}</p>

  if (profiles.length === 0) {
    return (
      <main className="page picker">
        <p className="wordmark">GMAT prep</p>
        <h1>Set up your first profile</h1>
        {noticeLine}
        <p className="lede">
          A profile keeps one person's practice, mistakes and study plan apart from anyone else's on this computer.
        </p>
        <AddProfile existing={profiles} onUnlocked={onUnlocked} onStopped={onStopped} />
        <CuratorLink />
      </main>
    )
  }

  return (
    <main className="page picker">
      <p className="wordmark">GMAT prep</p>
      <h1 ref={heading} tabIndex={-1}>Who is studying?</h1>
      {noticeLine}
      <ul className="profiles">
        {profiles.map((profile) => {
          const open = openId === profile.id
          const pinRowId = `pin-${profile.id}`
          return (
            <li key={profile.id}>
              <button
                type="button"
                className="profile"
                aria-expanded={profile.hasPin ? open : undefined}
                aria-controls={open ? pinRowId : undefined}
                onClick={() => void choose(profile)}
              >
                <span className={open ? "profile-name mark" : "profile-name"}>{profile.name}</span>
                {profile.hasPin && <span className="profile-pin">Needs a PIN</span>}
              </button>
              {open && (
                <PinEntry
                  id={pinRowId}
                  profile={profile}
                  onUnlocked={onUnlocked}
                  onGone={() => gone(profile.name)}
                  onStopped={onStopped}
                />
              )}
            </li>
          )
        })}
      </ul>
      {adding
        ? (
          <section className="add" aria-labelledby="add-title">
            <h2 id="add-title">Add a profile</h2>
            <AddProfile
              existing={profiles}
              onUnlocked={onUnlocked}
              onStopped={onStopped}
              onCancel={cancelAdding}
            />
          </section>
        )
        : (
          <button ref={addButton} type="button" className="button button-quiet" onClick={() => setAdding(true)}>
            Add a profile
          </button>
        )}
      <CuratorLink />
    </main>
  )
}

// The way into the Curator's tools: books, review and the LLM settings.
const CuratorLink = () => (
  <p className="curator-link">
    <a {...linkProps("/curator")}>Curator tools</a> for adding books and setting up the LLM
  </p>
)

interface PinEntryProps {
  readonly id: string
  readonly profile: ProfileSummary
  readonly onUnlocked: (profile: ProfileSummary) => void
  readonly onGone: () => void
  readonly onStopped: Stop
}

const PinEntry = ({ id, profile, onUnlocked, onGone, onStopped }: PinEntryProps) => {
  const inputId = useId()
  const problemId = useId()
  const input = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  const [pin, setPin] = useState("")
  const [problem, setProblem] = useState<string>()
  const [lockedUntil, setLockedUntil] = useState<number>()
  const [now, setNow] = useState(() => Date.now())
  const [shakes, setShakes] = useState(0)

  const locked = lockedUntil !== undefined && now < lockedUntil

  useEffect(() => {
    if (lockedUntil === undefined) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [lockedUntil])

  useEffect(() => {
    if (lockedUntil !== undefined && !locked) {
      setLockedUntil(undefined)
      setProblem("The lock has ended, so you can enter the PIN again.")
    }
  }, [locked, lockedUntil])

  // Focus the PIN on opening, and again when a lock ends.
  useEffect(() => {
    if (!locked) input.current?.focus()
  }, [locked])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy.current || locked) return
    // A PIN that cannot be right is not sent, so it does not use up an attempt.
    if (!isPin(pin)) {
      setProblem("Enter the PIN, which is 4 to 8 digits.")
      input.current?.focus()
      return
    }
    busy.current = true
    const result = await call((client) => client.profiles.unlock({ params: { id: profile.id }, payload: { pin } }))
    busy.current = false
    if (result._tag === "Success") return onUnlocked(result.success)
    const failure = result.failure
    switch (failure._tag) {
      case "WrongPin": {
        const left = failure.attemptsLeft
        setPin("")
        setProblem(`That PIN is wrong. ${left} ${left === 1 ? "try" : "tries"} left before the profile locks for 5 minutes.`)
        setShakes((count) => count + 1)
        input.current?.focus()
        return
      }
      case "ProfileLocked":
        setPin("")
        setProblem(undefined)
        setNow(Date.now())
        setLockedUntil(failure.lockedUntil)
        return
      case "ProfileNotFound":
        return onGone()
      case "PinRequired":
        setProblem("Enter the PIN, which is 4 to 8 digits.")
        return
      default:
        return onStopped(failure)
    }
  }

  return (
    <div className="pin-entry" id={id}>
      <form className="pin-form" noValidate onSubmit={(event) => void submit(event)}>
        <div className="field">
          <label htmlFor={inputId}>PIN for {profile.name}</label>
          <input
            id={inputId}
            ref={input}
            className="pin-input"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            value={pin}
            readOnly={locked}
            aria-disabled={locked}
            aria-invalid={problem !== undefined && !locked}
            aria-describedby={problemId}
            data-shake={shakes === 0 ? undefined : shakes % 2}
            onChange={(event) => setPin(digitsOnly(event.target.value))}
          />
        </div>
        <button type="submit" className="button" aria-disabled={locked}>
          Open
        </button>
      </form>
      <div id={problemId} aria-live="polite">
        {locked && lockedUntil !== undefined
          ? (
            <p className="problem">
              Too many wrong PINs, so this profile is locked until {clockTime(lockedUntil)}.
            </p>
          )
          : problem !== undefined && <p className="problem">{problem}</p>}
      </div>
      {locked && lockedUntil !== undefined && (
        <p className="countdown" aria-hidden="true">
          {minutesAndSeconds(lockedUntil - now)} left
        </p>
      )}
    </div>
  )
}

interface AddProfileProps {
  readonly existing: ReadonlyArray<ProfileSummary>
  readonly onUnlocked: (profile: ProfileSummary) => void
  readonly onStopped: Stop
  readonly onCancel?: () => void
}

interface FieldErrors {
  readonly name?: string
  readonly pin?: string
  readonly repeat?: string
}

const checkNewProfile = (
  name: string,
  pin: string,
  repeat: string,
  existing: ReadonlyArray<ProfileSummary>
): FieldErrors => {
  const trimmed = name.trim()
  const nameError = trimmed.length === 0
    ? "Enter a name for the profile."
    : !isProfileName(name)
    ? "Use a name of 40 characters or fewer."
    : existing.some((profile) => sameName(profile.name, name))
    ? `There is already a profile named ${trimmed}.`
    : undefined
  const pinError = pin.length > 0 && !isPin(pin) ? "A PIN is 4 to 8 digits." : undefined
  const repeatError = pin.length > 0 && pinError === undefined && repeat !== pin
    ? "The two PINs do not match."
    : undefined
  return {
    ...(nameError === undefined ? {} : { name: nameError }),
    ...(pinError === undefined ? {} : { pin: pinError }),
    ...(repeatError === undefined ? {} : { repeat: repeatError })
  }
}

const AddProfile = ({ existing, onUnlocked, onStopped, onCancel }: AddProfileProps) => {
  const ids = { name: useId(), pin: useId(), pinHint: useId(), repeat: useId() }
  const nameInput = useRef<HTMLInputElement>(null)
  const pinInput = useRef<HTMLInputElement>(null)
  const repeatInput = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  const [name, setName] = useState("")
  const [pin, setPin] = useState("")
  const [repeat, setRepeat] = useState("")
  const [errors, setErrors] = useState<FieldErrors>({})
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    nameInput.current?.focus()
  }, [])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy.current) return
    const found = checkNewProfile(name, pin, repeat, existing)
    setErrors(found)
    if (found.name !== undefined) return nameInput.current?.focus()
    if (found.pin !== undefined) return pinInput.current?.focus()
    if (found.repeat !== undefined) return repeatInput.current?.focus()

    busy.current = true
    setAdding(true)
    const create = (timeZone: string | undefined) =>
      call((client) =>
        client.profiles.create({
          payload: {
            name,
            ...(pin.length > 0 ? { pin } : {}),
            ...(timeZone === undefined ? {} : { timeZone })
          }
        })
      )
    const zone = browserTimeZone()
    let result = await create(zone)
    // A zone this browser knows but the app does not: use the computer's zone.
    if (result._tag === "Failure" && result.failure._tag === "InvalidTimeZone" && zone !== undefined) {
      result = await create(undefined)
    }
    busy.current = false
    setAdding(false)
    if (result._tag === "Success") return onUnlocked(result.success)
    if (result.failure._tag === "ProfileNameTaken") {
      setErrors({ name: `There is already a profile named ${name.trim()}.` })
      return nameInput.current?.focus()
    }
    onStopped(result.failure)
  }

  const describedBy = (...parts: ReadonlyArray<string | false>) => parts.filter((part) => part !== false).join(" ") || undefined

  return (
    <form className="add-form" noValidate onSubmit={(event) => void submit(event)}>
      <div className="field">
        <label htmlFor={ids.name}>Name</label>
        <input
          id={ids.name}
          ref={nameInput}
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={60}
          value={name}
          aria-invalid={errors.name !== undefined}
          aria-describedby={describedBy(errors.name !== undefined && `${ids.name}-error`)}
          onChange={(event) => setName(event.target.value)}
        />
        {errors.name !== undefined && <p id={`${ids.name}-error`} className="field-error">{errors.name}</p>}
      </div>
      <div className="field">
        <label htmlFor={ids.pin}>
          PIN <span className="optional">(optional)</span>
        </label>
        <p id={ids.pinHint} className="hint">4 to 8 digits. Add one if other people use this computer.</p>
        <input
          id={ids.pin}
          ref={pinInput}
          className="pin-input"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={8}
          value={pin}
          aria-invalid={errors.pin !== undefined}
          aria-describedby={describedBy(ids.pinHint, errors.pin !== undefined && `${ids.pin}-error`)}
          onChange={(event) => setPin(digitsOnly(event.target.value))}
        />
        {errors.pin !== undefined && <p id={`${ids.pin}-error`} className="field-error">{errors.pin}</p>}
      </div>
      {pin.length > 0 && (
        <div className="field">
          <label htmlFor={ids.repeat}>Repeat the PIN</label>
          <input
            id={ids.repeat}
            ref={repeatInput}
            className="pin-input"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={8}
            value={repeat}
            aria-invalid={errors.repeat !== undefined}
            aria-describedby={describedBy(errors.repeat !== undefined && `${ids.repeat}-error`)}
            onChange={(event) => setRepeat(digitsOnly(event.target.value))}
          />
          {errors.repeat !== undefined && <p id={`${ids.repeat}-error`} className="field-error">{errors.repeat}</p>}
        </div>
      )}
      <div className="actions">
        <button type="submit" className="button" aria-disabled={adding}>
          {adding ? "Adding profile" : "Add profile"}
        </button>
        {onCancel !== undefined && (
          <button type="button" className="button button-quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}
