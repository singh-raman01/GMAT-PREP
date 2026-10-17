import { type FormEvent, useId, useRef, useState } from "react"
import { MaxDeviceName, PairingCodeLength } from "../../src/api/Lan.ts"
import { call, type Refusal } from "./api.ts"
import { PlainHead } from "./DisplayMenu.tsx"
import { useFocusOnMount } from "./focus.ts"

// What another device on the network sees until it is paired (decision
// 121): a code shown on the computer GMAT prep runs on, and a name for this
// device so the Curator can tell devices apart.

interface Props {
  readonly refusal: Refusal
  readonly onPaired: () => void
  readonly onStopped: (error: { readonly _tag: string }) => void
}

const wrongCode = (attemptsLeft: number) =>
  attemptsLeft === 0
    ? "No code is waiting: it was used, it expired, or five wrong tries ended it. Show a new code on the computer GMAT prep runs on, then enter it here."
    : `That is not the code shown. ${attemptsLeft} ${attemptsLeft === 1 ? "try is" : "tries are"} left before the code ends.`

export const PairingPage = ({ refusal, onPaired, onStopped }: Props) => {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const ids = { code: useId(), name: useId() }
  const [code, setCode] = useState("")
  const [name, setName] = useState("")
  const [problem, setProblem] = useState<{ readonly field: "code" | "name"; readonly text: string }>()
  const codeField = useRef<HTMLInputElement>(null)
  const nameField = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  const [pairing, setPairing] = useState(false)

  if (refusal === "lan-off") {
    return (
      <main className="page page-narrow">
        <PlainHead />
        <h1 ref={heading} tabIndex={-1}>GMAT prep is not open to other devices</h1>
        <p className="lede">
          To use it here, turn on LAN mode on the computer GMAT prep runs on: open Curator tools there, then Devices.
        </p>
        <button type="button" className="button" onClick={onPaired}>Try again</button>
      </main>
    )
  }

  const pair = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const digits = code.replace(/\s+/g, "")
    if (!new RegExp(`^\\d{${PairingCodeLength}}$`).test(digits)) {
      setProblem({ field: "code", text: `Enter the ${PairingCodeLength} digits shown on the computer GMAT prep runs on.` })
      return codeField.current?.focus()
    }
    if (name.trim() === "" || name.trim().length > MaxDeviceName) {
      setProblem({ field: "name", text: `Give this device a name of up to ${MaxDeviceName} characters, such as Asha's tablet.` })
      return nameField.current?.focus()
    }
    if (busy.current) return
    busy.current = true
    setPairing(true)
    const result = await call((client) => client.pairing.pair({ payload: { code: digits, name: name.trim() } }))
    busy.current = false
    setPairing(false)
    if (result._tag === "Success") return onPaired()
    const failure = result.failure
    if (failure._tag === "PairingCodeWrong") {
      setProblem({ field: "code", text: wrongCode(failure.attemptsLeft) })
      setCode("")
      return codeField.current?.focus()
    }
    // This computer itself needs no pairing: show the app.
    if (failure._tag === "PairingNotNeeded") return onPaired()
    onStopped(failure)
  }

  return (
    <main className="page page-narrow">
      <PlainHead />
      <h1 ref={heading} tabIndex={-1}>Pair this device</h1>
      <p className="lede">
        GMAT prep runs on another computer on this network. To use it here, open Curator tools on that computer, go
        to Devices, and choose Show a pairing code. Then enter the code below. It works once, within 5 minutes.
      </p>
      <form className="pairing" noValidate onSubmit={(event) => void pair(event)}>
        <div className="field">
          <label htmlFor={ids.code}>Pairing code</label>
          <input
            ref={codeField}
            id={ids.code}
            className="pairing-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={PairingCodeLength + 2}
            value={code}
            aria-invalid={problem?.field === "code"}
            aria-describedby={problem?.field === "code" ? `${ids.code}-error` : undefined}
            onChange={(event) => setCode(event.target.value)}
          />
          {problem?.field === "code" && <p id={`${ids.code}-error`} className="field-error" role="alert">{problem.text}</p>}
        </div>
        <div className="field">
          <label htmlFor={ids.name}>Name this device</label>
          <p id={`${ids.name}-hint`} className="hint">The Curator sees it in the list of paired devices.</p>
          <input
            ref={nameField}
            id={ids.name}
            type="text"
            autoComplete="off"
            maxLength={MaxDeviceName}
            placeholder="Asha's tablet"
            value={name}
            aria-invalid={problem?.field === "name"}
            aria-describedby={[`${ids.name}-hint`, problem?.field === "name" ? `${ids.name}-error` : ""].join(" ").trim()}
            onChange={(event) => setName(event.target.value)}
          />
          {problem?.field === "name" && <p id={`${ids.name}-error`} className="field-error" role="alert">{problem.text}</p>}
        </div>
        <div className="actions">
          <button type="submit" className="button" aria-disabled={pairing}>{pairing ? "Pairing" : "Pair this device"}</button>
        </div>
      </form>
      <p className="hint measure">
        On this network GMAT prep travels as plain HTTP, which others on the same network could read. Use it on a
        network you trust, such as your home Wi-Fi.
      </p>
    </main>
  )
}
