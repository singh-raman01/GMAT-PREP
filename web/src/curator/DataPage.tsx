import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react"
import { type CuratorProfileView, type InstallExportView, InstallExportPath } from "../../../src/api/Exports.ts"
import type { IntegrityView, SnapshotKind, SnapshotsView, SnapshotView } from "../../../src/api/Snapshots.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { dayAndTime } from "../format.ts"
import { blockedText, sizeText, takenTexts } from "./dataText.ts"

// The Curator's care of the install's data (docs/design.md, "Data safety and
// operations"): snapshots and restoring one, each Profile's PIN and
// deletion, and an archive of the install to move it to another computer.

interface Props {
  readonly onLocked: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

const kindNames: Record<SnapshotKind, string> = {
  "daily": "Daily",
  "pre-migration": "Before an update",
  "pre-taxonomy": "Before a new Taxonomy",
  "pre-rescore": "Before a key change",
  "pre-deletion": "Before a Profile was deleted",
  "pre-restore": "Before a restore",
  "manual": "Taken by hand"
}

export const DataPage = ({ onLocked, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const handle = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "CuratorNotUnlocked" ? onLocked() : onStopped(failure)),
    [onLocked, onStopped]
  )
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>Data</h1>
      <p className="lede">
        Snapshots keep the database as it stood each day and before each risky change, so a mistake can be undone. The
        Books and their page images are files beside it, kept once, and are not in snapshots.
      </p>
      <Snapshots onFailure={handle} />
      <Profiles onFailure={handle} />
      <Archive onFailure={handle} />
    </>
  )
}

// The last full check, worded by what it found and when it ran.
const IntegrityNote = ({ integrity }: { readonly integrity: IntegrityView }) => {
  const when = dayAndTime(integrity.at)
  switch (integrity.outcome) {
    case "ok":
      return (
        <p className="hint">
          {integrity.afterRestore
            ? `The full check after the restore on ${when} found no damage.`
            : `The weekly full check found no damage on ${when}.`}
        </p>
      )
    case "not-run":
      return (
        <p className="hint">
          The full check of the database could not run on {when}: {integrity.detail}. It is tried again within the hour.
        </p>
      )
    case "damaged":
      return integrity.afterRestore
        ? (
          <p className="problem">
            The full check after the restore on {when} still found damage, in the database file itself, which a restore
            cannot repair: {integrity.detail}. Stop the app, move gmat-prep.sqlite out of the data folder, copy the
            snapshot you want from the snapshots folder in its place under the name gmat-prep.sqlite, and start the app
            again.
          </p>
        )
        : (
          <p className="problem">
            The weekly full check on {when} found damage in the database: {integrity.detail}. Restore the latest snapshot
            taken before that day.
          </p>
        )
  }
}

const Snapshots = ({ onFailure }: { readonly onFailure: (failure: { readonly _tag: string }) => void }) => {
  const [view, setView] = useState<SnapshotsView>()
  const [problem, setProblem] = useState<string>()
  const [done, setDone] = useState<string>()
  const [asking, setAsking] = useState<SnapshotView>()
  // What is under way: taking a snapshot, or restoring the one asked about.
  const [working, setWorking] = useState<"taking" | "restoring">()
  const [passphraseProblem, setPassphraseProblem] = useState<string>()
  const busy = useRef(false)
  const title = useRef<HTMLHeadingElement>(null)

  const load = useCallback(async () => {
    const result = await call((client) => client.snapshots.list())
    if (result._tag === "Failure") return onFailure(result.failure)
    setView(result.success)
  }, [onFailure])
  useEffect(() => {
    void load()
  }, [load])

  const take = async () => {
    if (busy.current) return
    busy.current = true
    setWorking("taking")
    setProblem(undefined)
    setDone(undefined)
    const result = await call((client) => client.snapshots.take())
    busy.current = false
    setWorking(undefined)
    if (result._tag === "Success") {
      setView(result.success)
      return setDone("Snapshot taken.")
    }
    if (result.failure._tag === "SnapshotFailed") {
      setProblem(`The snapshot was not taken: ${result.failure.detail}`)
      return void load()
    }
    onFailure(result.failure)
  }

  const ask = (snapshot: SnapshotView | undefined) => {
    setAsking(snapshot)
    setPassphraseProblem(undefined)
  }

  const restore = async (snapshot: SnapshotView, passphrase: string, when: string) => {
    if (busy.current) return
    busy.current = true
    setWorking("restoring")
    setProblem(undefined)
    setDone(undefined)
    setPassphraseProblem(undefined)
    const result = await call((client) => client.snapshots.restore({ params: { id: snapshot.id }, payload: { passphrase } }))
    busy.current = false
    setWorking(undefined)
    const failure = result._tag === "Failure" ? result.failure : undefined
    // A wrong passphrase leaves the question open, to try again.
    switch (failure?._tag) {
      case "WrongPassphrase":
        return setPassphraseProblem(
          `That is not the passphrase. ${failure.attemptsLeft} more tries before the tools lock for 5 minutes.`
        )
      case "CuratorLocked":
        return setPassphraseProblem(`Too many wrong passphrases: the tools are locked until ${dayAndTime(failure.lockedUntil)}.`)
    }
    ask(undefined)
    title.current?.focus()
    if (failure === undefined) {
      setDone(
        `Restored the snapshot from ${when}. The database it replaced is kept as a snapshot, "${kindNames["pre-restore"]}", should you want it back.`
      )
      return void load()
    }
    switch (failure._tag) {
      case "RestoreBlocked":
        return setProblem(blockedText(failure))
      case "SnapshotUnusable":
        return setProblem(
          failure.reason === "changed"
            ? "This snapshot's file has changed since it was taken, so it is not restored."
            : failure.reason === "newer"
            ? "A newer version of the app took this snapshot. Update the app to restore it."
            : failure.reason === "foreign"
            ? "This file is not a snapshot of this app's database, so it is not restored."
            : `This snapshot's file is damaged and is not restored: ${failure.detail}`
        )
      case "SnapshotNotFound":
        setProblem("That snapshot is no longer kept.")
        return void load()
      case "SnapshotFailed":
        return setProblem(`Nothing was restored: ${failure.detail}`)
      default:
        return onFailure(failure)
    }
  }

  const taken = takenTexts(view?.snapshots ?? [])

  return (
    <section className="group" aria-labelledby="snapshots-title" aria-busy={working !== undefined}>
      <h2 id="snapshots-title" ref={title} tabIndex={-1}>Snapshots</h2>
      <p className="group-about">
        Kept: the last 7 days, a snapshot from each of the 4 weeks before them, and the last 10 taken before a change.
        Copies found in the snapshots folder are listed too, and the app never deletes them.
      </p>
      {view?.integrity != null && <IntegrityNote integrity={view.integrity} />}
      {view !== undefined && view.failures.length > 0 && (
        <ul className="problem-list" aria-label="Snapshots that failed">
          {view.failures.map((failure, index) => (
            <li key={`${failure.kind}-${failure.at}-${index}`} className="problem">
              {kindNames[failure.kind]} snapshot, {dayAndTime(failure.at)}: {failure.error}
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button
          type="button"
          className="button"
          aria-busy={working === "taking"}
          aria-disabled={working !== undefined}
          onClick={() => void take()}
        >
          {working === "taking" ? "Taking a snapshot" : "Take a snapshot now"}
        </button>
      </div>
      <div role="status">
        {working === "restoring" && <p className="quiet">Restoring the snapshot. Learners' requests wait while the data is swapped.</p>}
        {done !== undefined && <p className="saved">{done}</p>}
      </div>
      {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
      {view === undefined
        ? <p className="quiet" aria-busy="true">Reading the snapshots</p>
        : view.snapshots.length === 0
        ? <p className="empty">No snapshot is kept yet. The first daily one is taken within the hour.</p>
        : (
          <ul className="set-list snapshot-list">
            {view.snapshots.map((snapshot) => {
              const when = taken.get(snapshot.id) ?? dayAndTime(snapshot.takenAt)
              return (
                <li key={snapshot.id}>
                  <span className="set-name">{when}</span>
                  <span className="set-facts">
                    {kindNames[snapshot.kind]}, {sizeText(snapshot.size)}
                    {snapshot.found ? ", found in the snapshots folder." : "."}
                  </span>
                  {asking?.id === snapshot.id
                    ? (
                      <RestoreForm
                        when={when}
                        restoring={working === "restoring"}
                        problem={passphraseProblem}
                        onRestore={(passphrase) => void restore(snapshot, passphrase, when)}
                        onKeep={() => ask(undefined)}
                      />
                    )
                    : (
                      <button
                        type="button"
                        className="button button-quiet"
                        aria-disabled={working !== undefined}
                        onClick={() => working === undefined && ask(snapshot)}
                      >
                        Restore<span className="visually-hidden"> the snapshot from {when}</span>
                      </button>
                    )}
                </li>
              )
            })}
          </ul>
        )}
    </section>
  )
}

// The question asked before a restore, which replaces every Learner's work
// since the snapshot: the passphrase again, and the way out.
const RestoreForm = (
  { when, restoring, problem, onRestore, onKeep }: {
    readonly when: string
    readonly restoring: boolean
    readonly problem: string | undefined
    readonly onRestore: (passphrase: string) => void
    readonly onKeep: () => void
  }
) => {
  const id = useId()
  const field = useFocusOnMount<HTMLInputElement>()
  const [passphrase, setPassphrase] = useState("")
  return (
    <form
      className="snapshot-confirm"
      noValidate
      aria-labelledby={`${id}-ask`}
      aria-busy={restoring}
      onSubmit={(event) => {
        event.preventDefault()
        if (!restoring) onRestore(passphrase)
      }}
    >
      <p id={`${id}-ask`}>
        Put the database back as it was on {when}? Everything since is replaced; the database as it is now is kept as a
        snapshot first. Enter the Curator passphrase to go on.
      </p>
      <label htmlFor={id}>Curator passphrase</label>
      <input
        ref={field}
        id={id}
        type="password"
        autoComplete="current-password"
        value={passphrase}
        aria-invalid={problem !== undefined}
        aria-describedby={problem === undefined ? undefined : `${id}-problem`}
        onChange={(event) => setPassphrase(event.target.value)}
      />
      {problem !== undefined && <p id={`${id}-problem`} className="field-error" role="alert">{problem}</p>}
      <div className="actions">
        <button type="submit" className="button" aria-busy={restoring} aria-disabled={restoring}>
          {restoring ? "Restoring" : "Restore it"}
        </button>
        <button type="button" className="button button-quiet" aria-disabled={restoring} onClick={() => !restoring && onKeep()}>
          Keep it as it is
        </button>
      </div>
    </form>
  )
}

const Profiles = ({ onFailure }: { readonly onFailure: (failure: { readonly _tag: string }) => void }) => {
  const [rows, setRows] = useState<ReadonlyArray<CuratorProfileView>>()
  const [open, setOpen] = useState<{ readonly id: string; readonly what: "pin" | "delete" }>()
  const [done, setDone] = useState<string>()
  const title = useRef<HTMLHeadingElement>(null)

  const load = useCallback(async () => {
    const result = await call((client) => client.curatorData.profiles())
    if (result._tag === "Failure") return onFailure(result.failure)
    setRows(result.success)
  }, [onFailure])
  useEffect(() => {
    void load()
  }, [load])

  const finished = (text: string) => {
    setOpen(undefined)
    setDone(text)
    title.current?.focus()
    void load()
  }

  return (
    <section className="group" aria-labelledby="profiles-title">
      <h2 id="profiles-title" ref={title} tabIndex={-1}>Profiles</h2>
      <p className="group-about">
        Set a new PIN for a Learner who forgot theirs, or take it away. Deleting a Profile removes everything it holds
        from the app, after a snapshot. Copies of it stay in the snapshots until the app deletes them, the daily ones
        within about five weeks, and in the install's last archive, if one was made.
      </p>
      <div role="status">{done !== undefined && <p className="saved">{done}</p>}</div>
      {rows === undefined
        ? <p className="quiet" aria-busy="true">Reading the Profiles</p>
        : rows.length === 0
        ? <p className="empty">No Profile yet.</p>
        : (
          <ul className="set-list">
            {rows.map((row) => (
              <li key={row.profile.id} className="data-profile">
                <span className="set-name">{row.profile.name}</span>
                <span className="set-facts">
                  {row.profile.hasPin ? "Has a PIN" : "No PIN"}
                  {row.lockedUntil === null ? "." : `, locked by wrong PINs until ${dayAndTime(row.lockedUntil)}.`} Added{" "}
                  {dayAndTime(row.createdAt)}.
                </span>
                {open?.id === row.profile.id
                  ? open.what === "pin"
                    ? <PinForm row={row} onDone={finished} onCancel={() => setOpen(undefined)} onFailure={onFailure} />
                    : <DeleteForm row={row} onDone={finished} onCancel={() => setOpen(undefined)} onFailure={onFailure} />
                  : (
                    <div className="actions">
                      <button type="button" className="button button-quiet" onClick={() => setOpen({ id: row.profile.id, what: "pin" })}>
                        Reset the PIN<span className="visually-hidden"> of {row.profile.name}</span>
                      </button>
                      <button type="button" className="button button-quiet" onClick={() => setOpen({ id: row.profile.id, what: "delete" })}>
                        Delete<span className="visually-hidden"> {row.profile.name}</span>
                      </button>
                    </div>
                  )}
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}

const PinForm = (
  { row, onDone, onCancel, onFailure }: {
    readonly row: CuratorProfileView
    readonly onDone: (text: string) => void
    readonly onCancel: () => void
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const id = useId()
  const field = useFocusOnMount<HTMLInputElement>()
  const [pin, setPin] = useState("")
  const [problem, setProblem] = useState<string>()
  const busy = useRef(false)
  const submit = async (none: boolean) => {
    if (busy.current) return
    if (!none && !/^\d{4,8}$/.test(pin)) return setProblem("A PIN is 4 to 8 digits.")
    busy.current = true
    const result = await call((client) =>
      client.curatorData.resetPin({ params: { id: row.profile.id }, payload: { pin: none ? null : pin } })
    )
    busy.current = false
    if (result._tag === "Success") {
      return onDone(none ? `${row.profile.name} has no PIN now.` : `${row.profile.name} has a new PIN.`)
    }
    if (result.failure._tag === "ProfileNotFound") return onDone(`${row.profile.name} was deleted meanwhile.`)
    onFailure(result.failure)
  }
  return (
    <form
      className="data-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        void submit(false)
      }}
    >
      <label htmlFor={id}>New PIN for {row.profile.name}</label>
      <input
        ref={field}
        id={id}
        className="number-input"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        value={pin}
        aria-invalid={problem !== undefined}
        aria-describedby={problem === undefined ? undefined : `${id}-problem`}
        onChange={(event) => setPin(event.target.value)}
      />
      {problem !== undefined && <p id={`${id}-problem`} className="field-error" role="alert">{problem}</p>}
      <div className="actions">
        <button type="submit" className="button">Set the PIN</button>
        {row.profile.hasPin && (
          <button type="button" className="button button-quiet" onClick={() => void submit(true)}>Take the PIN away</button>
        )}
        <button type="button" className="button button-quiet" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

const DeleteForm = (
  { row, onDone, onCancel, onFailure }: {
    readonly row: CuratorProfileView
    readonly onDone: (text: string) => void
    readonly onCancel: () => void
    readonly onFailure: (failure: { readonly _tag: string }) => void
  }
) => {
  const id = useId()
  const field = useFocusOnMount<HTMLInputElement>()
  const [passphrase, setPassphrase] = useState("")
  const [problem, setProblem] = useState<string>()
  const busy = useRef(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy.current) return
    busy.current = true
    const result = await call((client) =>
      client.curatorData.removeProfile({ params: { id: row.profile.id }, payload: { passphrase } })
    )
    busy.current = false
    if (result._tag === "Success") return onDone(`${row.profile.name} was deleted. A snapshot taken first holds it.`)
    const failure = result.failure
    switch (failure._tag) {
      case "WrongPassphrase":
        return setProblem(`That is not the passphrase. ${failure.attemptsLeft} more tries before the tools lock for 5 minutes.`)
      case "CuratorLocked":
        return setProblem(`Too many wrong passphrases: the tools are locked until ${dayAndTime(failure.lockedUntil)}.`)
      case "SnapshotFailed":
        return setProblem(`Nothing was deleted, as the snapshot before it failed: ${failure.detail}`)
      case "ProfileNotFound":
        return onDone(`${row.profile.name} was deleted meanwhile.`)
      default:
        return onFailure(failure)
    }
  }
  return (
    <form className="data-form" noValidate onSubmit={(event) => void submit(event)}>
      <p>
        Delete {row.profile.name} and everything it holds: its sets, answers, Mocks, plan, notes and chats. Enter the
        Curator passphrase to go on.
      </p>
      <label htmlFor={id}>Curator passphrase</label>
      <input
        ref={field}
        id={id}
        type="password"
        autoComplete="current-password"
        value={passphrase}
        aria-invalid={problem !== undefined}
        aria-describedby={problem === undefined ? undefined : `${id}-problem`}
        onChange={(event) => setPassphrase(event.target.value)}
      />
      {problem !== undefined && <p id={`${id}-problem`} className="field-error" role="alert">{problem}</p>}
      <div className="actions">
        <button type="submit" className="button">Delete {row.profile.name}</button>
        <button type="button" className="button button-quiet" onClick={onCancel}>Keep it</button>
      </div>
    </form>
  )
}

const Archive = ({ onFailure }: { readonly onFailure: (failure: { readonly _tag: string }) => void }) => {
  const [latest, setLatest] = useState<InstallExportView | null>()
  const [problem, setProblem] = useState<string>()
  const [making, setMaking] = useState(false)
  const busy = useRef(false)

  useEffect(() => {
    void call((client) => client.curatorData.installExport()).then((result) => {
      if (result._tag === "Failure") return onFailure(result.failure)
      setLatest(result.success)
    })
  }, [onFailure])

  const make = async () => {
    if (busy.current) return
    busy.current = true
    setMaking(true)
    setProblem(undefined)
    const result = await call((client) => client.curatorData.exportInstall())
    busy.current = false
    setMaking(false)
    if (result._tag === "Success") return setLatest(result.success)
    if (result.failure._tag === "ExportFailed") return setProblem(`The archive was not made: ${result.failure.detail}`)
    onFailure(result.failure)
  }

  return (
    <section className="group" aria-labelledby="archive-title">
      <h2 id="archive-title">Move the install</h2>
      <p className="group-about">
        One archive holds the database, the Books and their page images. To move the install, close the app on the
        other computer, unpack the archive into an empty data folder there, and start it. The LLM key is not in it:
        enter it again under Settings there.
      </p>
      <div className="actions">
        <button type="button" className="button" aria-busy={making} onClick={() => void make()}>
          {making ? "Making the archive" : "Make an archive"}
        </button>
      </div>
      {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
      <div role="status">
        {latest != null && (
          <p>
            <a href={InstallExportPath} download={latest.name}>Download {latest.name}</a>, {sizeText(latest.size)}, made{" "}
            {dayAndTime(latest.at)}.
          </p>
        )}
      </div>
    </section>
  )
}
