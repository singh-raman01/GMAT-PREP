import { useEffect, useState } from "react"

// Paths in the app: "/" for Learners, "/curator" and below for the Curator.
// The server answers every page path with the app, so these survive a reload.

const listeners = new Set<() => void>()

export const navigate = (path: string) => {
  if (path === window.location.pathname) return
  window.history.pushState(null, "", path)
  for (const listener of listeners) listener()
}

export const usePath = (): string => {
  const [path, setPath] = useState(window.location.pathname)
  useEffect(() => {
    const update = () => setPath(window.location.pathname)
    listeners.add(update)
    window.addEventListener("popstate", update)
    return () => {
      listeners.delete(update)
      window.removeEventListener("popstate", update)
    }
  }, [])
  return path
}

// A link that changes the page without reloading the app.
export const linkProps = (path: string) => ({
  href: path,
  onClick: (event: { preventDefault: () => void; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; button: number }) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
    event.preventDefault()
    navigate(path)
  }
})
