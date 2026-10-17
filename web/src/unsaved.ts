// A change that failed to save after the screen that made it had closed,
// such as a Mistake Type picked just before moving on. The app shows each
// one until the Learner dismisses it, so no failure goes unseen.

type Listener = (message: string) => void

const listeners = new Set<Listener>()

export const reportUnsaved = (message: string) => {
  for (const listener of listeners) listener(message)
}

export const onUnsaved = (listener: Listener) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
