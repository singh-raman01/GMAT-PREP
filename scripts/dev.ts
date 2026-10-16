// Runs the app from the repo for development: the server, restarted when its
// code changes, and the Vite dev server for the web app, which forwards /api to
// the server. Data goes to .data/ in the repo unless GMAT_PREP_DATA_DIR says
// otherwise, so development never touches an installed copy's data.
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const dataDir = process.env["GMAT_PREP_DATA_DIR"] ?? join(root, ".data")
mkdirSync(dataDir, { recursive: true })

// Marks this run's server.json. On Windows bun --watch runs the server as a
// child process, so the process id cannot identify it.
const runId = crypto.randomUUID()

const server = Bun.spawn([process.execPath, "--watch", "src/server/main.ts"], {
  cwd: root,
  env: { ...process.env, GMAT_PREP_DATA_DIR: dataDir, GMAT_PREP_RUN_ID: runId },
  stdio: ["inherit", "inherit", "inherit"]
})

// The server writes server.json once it listens; its port can differ from the
// preferred one when that is taken.
const serverUrl = async (): Promise<string | undefined> => {
  const file = join(dataDir, "server.json")
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) return undefined
    if (existsSync(file)) {
      try {
        const info = JSON.parse(readFileSync(file, "utf8")) as { readonly runId: string | null; readonly url: string }
        if (info.runId === runId) return info.url
      } catch {
        // Written but not complete yet; read again.
      }
    }
    await Bun.sleep(100)
  }
  return undefined
}

// Stops a process and everything it started. On Windows killing a process
// leaves its children running, so the whole tree is ended.
const stopTree = (proc: Bun.Subprocess) => {
  if (proc.exitCode !== null) return
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/pid", String(proc.pid), "/t", "/f"])
  } else {
    proc.kill()
  }
}

const url = await serverUrl()
if (url === undefined) {
  stopTree(server)
  await server.exited
  console.error("The server did not start. See its message above.")
  process.exit(1)
}

console.log(`The API is at ${url}. Open the address Vite prints below.`)
// --bun runs Vite on Bun rather than on whatever Node is installed.
const vite = Bun.spawn([process.execPath, "x", "--bun", "vite", "--config", "web/vite.config.ts"], {
  cwd: root,
  env: { ...process.env, GMAT_PREP_API_URL: url },
  stdio: ["inherit", "inherit", "inherit"]
})

const stop = () => {
  stopTree(server)
  stopTree(vite)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)

// When either one stops, stop the other.
const code = await Promise.race([server.exited, vite.exited])
stop()
await Promise.all([server.exited, vite.exited])
process.exit(code)
