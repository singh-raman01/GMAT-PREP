import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import {
  changeDisplay,
  currentDisplay,
  onDisplayChanged,
  TextSizeNames,
  TextSizes,
  ThemeNames,
  Themes
} from "./display.ts"

// The top bar's Display button: this browser's colours and text size, on
// every screen, the exam screen included (decision 126).
// The panel keeps this far from the screen's edges.
const EdgeMargin = 16

export const DisplayMenu = () => {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [display, setDisplay] = useState(currentDisplay)
  const menu = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => onDisplayChanged(setDisplay), [])
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
  // A click or focus outside closes it.
  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => {
      const target = event.target
      if (target instanceof Node && !panel.current?.contains(target) && !button.current?.contains(target)) setOpen(false)
    }
    document.addEventListener("pointerdown", outside)
    document.addEventListener("focusin", outside)
    return () => {
      document.removeEventListener("pointerdown", outside)
      document.removeEventListener("focusin", outside)
    }
  }, [open])
  const close = () => {
    setOpen(false)
    button.current?.focus()
  }
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
        <div
          ref={panel}
          id={`${id}-panel`}
          className="display-panel"
          role="group"
          aria-label="Display"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault()
              close()
            }
          }}
        >
          <fieldset>
            <legend>Colours</legend>
            {Themes.map((theme) => (
              <label key={theme} className="inline-choice">
                <input
                  type="radio"
                  name={`${id}-theme`}
                  checked={display.theme === theme}
                  onChange={() => changeDisplay({ ...display, theme })}
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
                  onChange={() => changeDisplay({ ...display, textSize })}
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
