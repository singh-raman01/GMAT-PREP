import { Config, Effect, Option, Schedule } from "effect"

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

// Polls until the server's process is gone.
const serverExits = (pid: number) =>
  Effect.sync(() => isAlive(pid)).pipe(
    Effect.repeat({ schedule: Schedule.spaced("2 seconds"), while: (alive) => alive })
  )

// The server holds the write end of the worker's stdin and never writes to it,
// so the worker reads end of input when the server dies or restarts in place
// (as bun --watch does, keeping its process id).
const serverPipeCloses = Effect.promise(async () => {
  const reader = Bun.stdin.stream().getReader()
  while (!(await reader.read()).done) {
    // Nothing is sent; any input is ignored.
  }
})

// The job worker. Ticket 01 only starts it; jobs arrive with ticket 02. It
// exits when its server is gone, so a crashed server never leaves it behind.
export const WorkerMain = Effect.gen(function*() {
  const parentPid = yield* Config.Int("GMAT_PREP_PARENT_PID").pipe(Config.option)
  yield* Effect.logInfo(`Job worker ready (pid ${process.pid})`)
  if (Option.isNone(parentPid)) {
    return yield* Effect.never
  }
  yield* Effect.raceFirst(serverExits(parentPid.value), serverPipeCloses)
  yield* Effect.logInfo("Server is gone; job worker stopping")
})
