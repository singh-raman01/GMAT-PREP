import { useCallback, useEffect, useId, useRef, useState } from "react"
import type { DeviceView, LanView, NewPairingCode } from "../../../src/api/Lan.ts"
import { call } from "../api.ts"
import { useFocusOnMount } from "../focus.ts"
import { clockTime, dayAndTime } from "../format.ts"

// The Curator's Devices page (decisions 119 to 125): LAN mode on or off,
// where other devices open the app, pairing codes, and the paired devices.
// Only this computer may change these.

interface Props {
  readonly onLocked: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

// While LAN mode opens its listeners, the page looks again for the
// addresses.
const ListeningCheckMs = 1500

const remainingText = (millis: number) => {
  const seconds = Math.max(0, Math.ceil(millis / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

export const DevicesPage = ({ onLocked, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const onFailure = useCallback(
    (failure: { readonly _tag: string }) => (failure._tag === "CuratorNotUnlocked" ? onLocked() : onStopped(failure)),
    [onLocked, onStopped]
  )
  const id = useId()
  const [fromHost, setFromHost] = useState<boolean>()
  const [view, setView] = useState<LanView>()
  const [code, setCode] = useState<NewPairingCode>()
  const [now, setNow] = useState(() => Date.now())
  const [status, setStatus] = useState<string>()
  const [revoking, setRevoking] = useState<DeviceView>()
  const busy = useRef(false)
  const codeHeading = useRef<HTMLParagraphElement>(null)
  const keepButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      const where = await call((client) => client.pairing.status())
      if (!live) return
      if (where._tag === "Failure") return onFailure(where.failure)
      setFromHost(where.success.fromHost)
      if (!where.success.fromHost) return
      const found = await call((client) => client.curatorLan.view())
      if (!live) return
      if (found._tag === "Failure") return onFailure(found.failure)
      setView(found.success)
    })()
    return () => {
      live = false
    }
    // Loads once, when the screen opens.
  }, [])

  // Turned on, the listeners take a moment; read the addresses again.
  useEffect(() => {
    if (view === undefined || !view.on || view.urls.length > 0 || view.problems.length > 0) return
    const timer = window.setTimeout(() => {
      void call((client) => client.curatorLan.view()).then((found) => {
        if (found._tag === "Success") setView(found.success)
      })
    }, ListeningCheckMs)
    return () => window.clearTimeout(timer)
  }, [view])

  // The code's countdown.
  useEffect(() => {
    if (code === undefined) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [code])
  useEffect(() => {
    if (code !== undefined) codeHeading.current?.focus()
  }, [code])
  useEffect(() => {
    if (revoking !== undefined) keepButton.current?.focus()
  }, [revoking])

  const run = async <A,>(action: () => Promise<{ readonly _tag: "Success"; readonly success: A } | { readonly _tag: "Failure"; readonly failure: { readonly _tag: string } }>) => {
    if (busy.current) return undefined
    busy.current = true
    const result = await action()
    busy.current = false
    if (result._tag === "Failure") {
      onFailure(result.failure)
      return undefined
    }
    return result.success
  }

  const setMode = async (on: boolean) => {
    const next = await run(() => call((client) => client.curatorLan.setMode({ payload: { on } })))
    if (next === undefined) return
    setView(next)
    setCode(undefined)
    setStatus(on ? "LAN mode is on." : "LAN mode is off. Other devices can no longer reach GMAT prep.")
  }

  const showCode = async () => {
    const made = await run(() => call((client) => client.curatorLan.makeCode()))
    if (made === undefined) return
    setNow(Date.now())
    setCode(made)
    setStatus(undefined)
  }

  const revoke = async (device: DeviceView) => {
    const next = await run(() => call((client) => client.curatorLan.revoke({ params: { id: device.id } })))
    if (next === undefined) return
    setView(next)
    setRevoking(undefined)
    setStatus(`${device.name} is revoked. It needs a new code to come back.`)
  }

  const live = view?.devices.filter((device) => device.revokedAt === null) ?? []
  const revoked = view?.devices.filter((device) => device.revokedAt !== null) ?? []
  const codeLive = code !== undefined && code.expiresAt > now

  return (
    <>
      <h1 ref={heading} tabIndex={-1}>Devices</h1>
      <p className="lede">
        LAN mode lets tablets and phones on your network use GMAT prep, each once it is paired with a code shown here.
        Traffic on the network is plain HTTP, which others on the same network could read, so use LAN mode only on a
        network you trust, such as your home Wi-Fi, never on public Wi-Fi.
      </p>
      {fromHost === undefined || (fromHost && view === undefined)
        ? <p className="quiet" aria-busy="true">Reading LAN mode</p>
        : !fromHost || view === undefined
        ? <p className="quiet">LAN mode and paired devices are managed on the computer GMAT prep runs on.</p>
        : (
          <>
          <section className="group" aria-labelledby={`${id}-title`}>
            <h2 id={`${id}-title`}>LAN mode</h2>
            <div className="actions">
              <p>{view.on ? "LAN mode is on." : "LAN mode is off: only this computer can use GMAT prep."}</p>
              <button type="button" className="button button-quiet" onClick={() => void setMode(!view.on)}>
                {view.on ? "Turn off LAN mode" : "Turn on LAN mode"}
              </button>
            </div>
            <div role="status">{status !== undefined && <p className="saved">{status}</p>}</div>
            {view.on && (
              <>
                {view.urls.length > 0
                  ? (
                    <>
                      <p className="group-about">On the other device, open:</p>
                      <ul className="lan-urls">
                        {view.urls.map((url) => <li key={url}><code>{url}</code></li>)}
                      </ul>
                    </>
                  )
                  : view.problems.length === 0 && <p className="quiet" aria-busy="true">Opening to your network</p>}
                {view.problems.length > 0 && (
                  <div className="problem" role="alert">
                    {view.problems.map((problem) => <p key={problem.address}>{problem.address}: {problem.detail}</p>)}
                  </div>
                )}
                <div className="lan-pairing">
                  {codeLive
                    ? (
                      <>
                        <p ref={codeHeading} tabIndex={-1} className="lan-code" aria-label={`Pairing code ${code.code.split("").join(" ")}`}>
                          {code.code}
                        </p>
                        <p className="hint">
                          Enter it on the other device. It works once, until {clockTime(code.expiresAt)} (
                          <span aria-hidden="true">{remainingText(code.expiresAt - now)}</span> left).
                        </p>
                        <button type="button" className="button button-quiet" onClick={() => void showCode()}>Show a new code</button>
                      </>
                    )
                    : (
                      <>
                        {code !== undefined && <p className="hint">That code has expired.</p>}
                        <button type="button" className="button" onClick={() => void showCode()}>Show a pairing code</button>
                      </>
                    )}
                </div>
              </>
            )}
          </section>
          <section className="group" aria-labelledby={`${id}-devices`}>
            <h2 id={`${id}-devices`}>Paired devices</h2>
            {live.length === 0
              ? <p className="quiet">No device is paired.</p>
              : (
                <ul className="set-list">
                  {live.map((device) => (
                    <li key={device.id}>
                      <span className="set-name">{device.name}</span>
                      <span className="set-facts">
                        Paired {dayAndTime(device.pairedAt)}; last seen {dayAndTime(device.lastSeenAt)}.
                      </span>
                      {revoking?.id === device.id
                        ? (
                          <div className="plan-confirm" role="group" aria-labelledby={`${id}-${device.id}-ask`}>
                            <p id={`${id}-${device.id}-ask`}>Revoke {device.name}? It can no longer reach GMAT prep until it pairs again.</p>
                            <div className="actions">
                              <button type="button" className="button" onClick={() => void revoke(device)}>Revoke it</button>
                              <button
                                ref={keepButton}
                                type="button"
                                className="button button-quiet"
                                onClick={() => {
                                  setRevoking(undefined)
                                  window.requestAnimationFrame(() => document.getElementById(`${id}-${device.id}-revoke`)?.focus())
                                }}
                              >
                                Keep it
                              </button>
                            </div>
                          </div>
                        )
                        : (
                          <button id={`${id}-${device.id}-revoke`} type="button" className="button button-quiet" onClick={() => setRevoking(device)}>
                            Revoke<span className="visually-hidden"> {device.name}</span>
                          </button>
                        )}
                    </li>
                  ))}
                </ul>
              )}
            {revoked.length > 0 && (
              <p className="hint">
                Revoked: {revoked.map((device) => `${device.name} (${dayAndTime(device.revokedAt!)})`).join("; ")}.
              </p>
            )}
          </section>
          </>
        )}
    </>
  )
}
