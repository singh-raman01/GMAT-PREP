import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import {
  changeDisplay,
  currentDisplay,
  holdDisplayPanelOpen,
  onDisplayChanged,
  TextSizeNames,
  TextSizes,
  ThemeNames,
  Themes
} from "./display.ts"

// The Display button: this browser's colours and text size, at the top of
// every screen, the exam screen and the screens before a Profile opens
// included (decision 126).
// The panel keeps this far from the screen's edges.
const EdgeMargin = 16

export const DisplayMenu = () => {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [display, setDisplay] = useState(currentDisplay)
  const menu = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const close = () => {
    setOpen(false)
    button.current?.focus()
  }
  useEffect(() => onDisplayChanged(setDisplay), [])
  useEffect(() => (open ? holdDisplayPanelOpen() : undefined), [open])
  // The panel lines up with the button's right edge, as the button sits at
  // the right of a wide top bar; on a phone the top bar wraps and the button
  // can sit at the left, so the panel lines up with its left edge instead,
  // and never runs off the screen. Placed again when the text size or the
  // window changes.
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const element = panel.current
      const anchor = menu.current
      if (element === null || anchor === null) return
      const box = anchor.getBoundingClientRect()
      const width = element.offsetWidth
      const screen = document.documentElement.clientWidth
      const left = box.right - width >= EdgeMargin
        ? box.right - width
        : box.left + width <= screen - EdgeMargin
        ? box.left
        : Math.max(EdgeMargin, screen - EdgeMargin - width)
      element.style.insetInlineEnd = "auto"
      element.style.left = `${left - box.left}px`
    }
    place()
    window.addEventListener("resize", place)
    return () => window.removeEventListener("resize", place)
  }, [open, display])
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLInputElement>("input:checked")?.focus()
  }, [open])
  // A click or focus outside closes it, and so does Escape, wherever focus
  // is, its button included.
  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => {
      const target = event.target
      if (target instanceof Node && !panel.current?.contains(target) && !button.current?.contains(target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      setOpen(false)
      button.current?.focus()
    }
    document.addEventListener("pointerdown", outside)
    document.addEventListener("focusin", outside)
    document.addEventListener("keydown", escape)
    return () => {
      document.removeEventListener("pointerdown", outside)
      document.removeEventListener("focusin", outside)
      document.removeEventListener("keydown", escape)
    }
  }, [open])
  return (
    <div ref={menu} className="display-menu">
      <button
        ref={button}
        type="button"
        className="button button-quiet"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => setOpen(!open)}
      >
        Display
      </button>
      {open && (
        // Focusable, so a click on its background keeps focus in it.
        <div ref={panel} id={`${id}-panel`} className="display-panel" role="group" aria-label="Display" tabIndex={-1}>
          <fieldset>
            <legend>Colours</legend>
            {Themes.map((theme) => (
              <label key={theme} className="inline-choice">
                <input
                  type="radio"
                  name={`${id}-theme`}
                  checked={display.theme === theme}
                  onChange={() => changeDisplay({ theme })}
                />
                {ThemeNames[theme]}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Text size</legend>
            {TextSizes.map((textSize) => (
              <label key={textSize} className="inline-choice">
                <input
                  type="radio"
                  name={`${id}-size`}
                  checked={display.textSize === textSize}
                  onChange={() => changeDisplay({ textSize })}
                />
                {TextSizeNames[textSize]}
              </label>
            ))}
          </fieldset>
          <button type="button" className="button button-quiet" onClick={close}>Done</button>
        </div>
      )}
    </div>
  )
}

// The top of a screen with no top bar, such as the Profile picker: the
// wordmark, and the Display button beside it.
export const PlainHead = () => (
  <div className="plain-head">
    <p className="wordmark">GMAT prep</p>
    <DisplayMenu />
  </div>
)
