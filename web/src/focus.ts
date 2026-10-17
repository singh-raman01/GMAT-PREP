import { useEffect, useRef } from "react"

// Moves focus to an element when it first appears, such as a new screen's
// heading, so keyboard and screen reader users start there instead of at the
// top of the page.
export const useFocusOnMount = <E extends HTMLElement>() => {
  const ref = useRef<E>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return ref
}

// The same for a heading that is drawn only once the screen's content has
// arrived: focus moves when ready turns true.
export const useFocusWhenReady = <E extends HTMLElement>(ready: boolean) => {
  const ref = useRef<E>(null)
  useEffect(() => {
    if (ready) ref.current?.focus()
  }, [ready])
  return ref
}
