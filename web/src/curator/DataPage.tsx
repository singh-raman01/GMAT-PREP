import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react"
import { type CuratorProfileView, type InstallExportView, InstallExportPath } from "../../../src/api/Exports.ts"
import type { SnapshotKind, SnapshotsView, SnapshotView } from "../../../src/api/Snapshots.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { dayAndTime } from "../format.ts"

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

export const sizeText = (bytes: number | null) =>
  bytes === null
    ? "size unknown"
    : bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : bytes < 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`

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

const Snapshots = ({ onFailure }: { readonly onFailure: (failure: { readonly _tag: string }) => void }) => {
  const [view, setView] = useState<SnapshotsView>()
  const [problem, setProblem] = useState<string>()
  const [done, setDone] = useState<string>()
  const [asking, setAsking] = useState<SnapshotView>()
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
    setProblem(undefined)
    setDone(undefined)
    const result = await call((client) => client.snapshots.take())
    busy.current = false
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

  const restore = async (snapshot: SnapshotView) => {
    if (busy.current) return
    busy.current = true
    setProblem(undefined)
    setDone(undefined)
    const result = await call((client) => client.snapshots.restore({ params: { id: snapshot.id } }))
    busy.current = false
    setAsking(undefined)
    title.current?.focus()
    if (result._tag === "Success") {
      setDone(
        `Restored the snapshot from ${dayAndTime(snapshot.takenAt)}. The database it replaced is kept as a snapshot, "${
          kindNames["pre-restore"]
        }", should you want it back.`
      )
      return void load()
    }
    const failure = result.failure
    switch (failure._tag) {
      case "RestoreBlocked":
        return setProblem(
          failure.reason === "job-running"
            ? "A job is running. Pause it, or wait for it to finish, then restore."
            : "A Learner is in a Mock, Sectional or timed set. Restore once it has ended."
        )
      case "SnapshotUnusable":
        return setProblem(
          failure.reason === "changed"
            ? "This snapshot's file has changed since it was taken, so it is not restored."
            : failure.reason === "newer"
            ? "A newer version of the app took this snapshot. Update the app to restore it."
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

  return (
    <section className="group" aria-labelledby="snapshots-title">
      <h2 id="snapshots-title" ref={title} tabIndex={-1}>Snapshots</h2>
      <p className="group-about">
        Kept: the last 7 days, a snapshot from each of the 4 weeks before them, and the last 10 taken before a change.
      </p>
      {view?.integrity != null && (
        view.integrity.ok
          ? <p className="hint">The weekly full check found no damage on {dayAndTime(view.integrity.at)}.</p>
          : (
            <p className="problem">
              The weekly full check on {dayAndTime(view.integrity.at)} found damage in the database: {view.integrity.detail}.
              Restore the latest snapshot taken before that day.
            </p>
          )
      )}
      {view !== undefined && view.failures.length > 0 && (
        <ul className="problem-list" aria-label="Snapshots that failed">
          {view.failures.map((failure) => (
            <li key={failure.kind} className="problem">
              {kindNames[failure.kind]} snapshot, {dayAndTime(failure.at)}: {failure.error}
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button type="button" className="button" onClick={() => void take()}>Take a snapshot now</button>
      </div>
      <div role="status">{done !== undefined && <p className="saved">{done}</p>}</div>
      {problem !== undefined && <p className="problem" role="alert">{problem}</p>}
      {view === undefined
        ? <p className="quiet" aria-busy="true">Reading the snapshots</p>
        : view.snapshots.length === 0
        ? <p className="empty">No snapshot is kept yet. The first daily one is taken within the hour.</p>
        : (
          <ul className="set-list snapshot-list">
            {view.snapshots.map((snapshot) => (
              <li key={snapshot.id}>
                <span className="set-name">{dayAndTime(snapshot.takenAt)}</span>
                <span className="set-facts">{kindNames[snapshot.kind]}, {sizeText(snapshot.size)}.</span>
                {asking?.id === snapshot.id
                  ? (
                    <div className="snapshot-confirm" role="group" aria-labelledby={`restore-${snapshot.id}`}>
                      <p id={`restore-${snapshot.id}`}>
                        Put the database back as it was then? Everything since is replaced; the database as it is now is
                        kept as a snapshot first.
                      </p>
                      <div className="actions">
                        <button type="button" className="button" onClick={() => void restore(snapshot)}>Restore it</button>
                        <KeepButton onKeep={() => setAsking(undefined)} />
                      </div>
                    </div>
                  )
                  : (
                    <button type="button" className="button button-quiet" onClick={() => setAsking(snapshot)}>
                      Restore<span className="visually-hidden"> the snapshot from {dayAndTime(snapshot.takenAt)}</span>
                    </button>
                  )}
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}

// The way out of a question asked in place, focused when it appears.
const KeepButton = ({ onKeep, label = "Keep it as it is" }: { readonly onKeep: () => void; readonly label?: string }) => {
  const ref = useFocusOnMount<HTMLButtonElement>()
  return <button ref={ref} type="button" className="button button-quiet" onClick={onKeep}>{label}</button>
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
        Set a new PIN for a Learner who forgot theirs, or take it away. Deleting a Profile removes everything it holds,
        after a snapshot.
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
      {problem !== undefined && <p id={`${id}-problem`} className="field-error">{problem}</p>}
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
        other computer, unpack the archive into its data folder, and start it. The LLM key is not in it: enter it again
        under Settings there.
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
