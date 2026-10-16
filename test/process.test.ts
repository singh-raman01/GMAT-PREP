import { Database } from "bun:sqlite"
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs"
import { networkInterfaces } from "node:os"
import { join } from "node:path"
import { tempDataDir } from "./harness.ts"

setDefaultTimeout(30_000)

// These tests run the real server as a separate process, the way a Learner
// starts it, and observe it from outside.

const repoRoot = join(import.meta.dir, "..")
const running: Array<Bun.Subprocess> = []

afterEach(async () => {
  for (const proc of running.splice(0)) {
    proc.kill("SIGTERM")
    await proc.exited
  }
})

const freePort = () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = probe.port
  probe.stop(true)
  return port!
}

const startApp = (dataDir: string, port: number) => {
  const proc = Bun.spawn([process.execPath, "src/server/main.ts"], {
    cwd: repoRoot,
    env: { ...process.env, GMAT_PREP_DATA_DIR: dataDir, GMAT_PREP_PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe"
  })
  running.push(proc)
  return proc
}

const waitFor = async <A>(probe: () => A | undefined | Promise<A | undefined>, timeoutMs = 15_000): Promise<A> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await Bun.sleep(100)
  }
  throw new Error("timed out waiting")
}

interface ServerInfo {
  readonly pid: number
  readonly port: number
  readonly url: string
}

const serverInfo = (dataDir: string) =>
  waitFor<ServerInfo>(() => {
    const file = join(dataDir, "server.json")
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as ServerInfo : undefined
  })

const health = async (url: string) =>
  (await (await fetch(`${url}/api/health`)).json()) as {
    status: string
    worker: { running: boolean; pid: number | null; restarts: number }
  }

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const outputOf = async (proc: Bun.Subprocess) => {
  await proc.exited
  const out = await new Response(proc.stdout as ReadableStream).text()
  const err = await new Response(proc.stderr as ReadableStream).text()
  return out + err
}

describe("the server process", () => {
  test("starts, says where it listens, and runs a job worker", async () => {
    const dataDir = tempDataDir()
    const port = freePort()
    startApp(dataDir, port)
    const info = await serverInfo(dataDir)
    expect(info.url).toBe(`http://127.0.0.1:${port}`)
    const status = await waitFor(async () => {
      const h = await health(info.url)
      return h.worker.running ? h : undefined
    })
    expect(status.status).toBe("ok")
    expect(isAlive(status.worker.pid!)).toBe(true)
  })

  test("restarts the job worker when it dies", async () => {
    const dataDir = tempDataDir()
    startApp(dataDir, freePort())
    const info = await serverInfo(dataDir)
    const first = await waitFor(async () => (await health(info.url)).worker.pid ?? undefined)
    process.kill(first, "SIGKILL")
    const after = await waitFor(async () => {
      const h = await health(info.url)
      return h.worker.running && h.worker.pid !== first ? h : undefined
    })
    expect(after.worker.restarts).toBe(1)
  })

  // bun --watch restarts the server in place, keeping its process id, so the
  // worker also watches the pipe its server holds open.
  test("a worker stops when its server's pipe closes, even if that process lives on", async () => {
    const worker = Bun.spawn([process.execPath, "src/server/main.ts", "worker"], {
      cwd: repoRoot,
      env: { ...process.env, GMAT_PREP_DATA_DIR: tempDataDir(), GMAT_PREP_PARENT_PID: String(process.pid) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    })
    running.push(worker)
    await Bun.sleep(500)
    expect(worker.exitCode).toBeNull()
    worker.stdin.end()
    const code = await Promise.race([worker.exited, Bun.sleep(5_000).then(() => "still running")])
    expect(code).toBe(0)
  })

  test("stopping the server stops its worker and releases the data folder", async () => {
    const dataDir = tempDataDir()
    const proc = startApp(dataDir, freePort())
    const info = await serverInfo(dataDir)
    const worker = await waitFor(async () => (await health(info.url)).worker.pid ?? undefined)
    proc.kill("SIGTERM")
    await proc.exited
    await waitFor(() => (isAlive(worker) ? undefined : true))
    expect(existsSync(join(dataDir, "server.json"))).toBe(false)
    startApp(dataDir, freePort())
    expect((await health((await serverInfo(dataDir)).url)).status).toBe("ok")
  })

  test("a server that was killed leaves nothing that blocks the next start", async () => {
    const dataDir = tempDataDir()
    const proc = startApp(dataDir, freePort())
    await serverInfo(dataDir)
    proc.kill("SIGKILL")
    await proc.exited
    rmSync(join(dataDir, "server.json"), { force: true })
    startApp(dataDir, freePort())
    expect((await health((await serverInfo(dataDir)).url)).status).toBe("ok")
  })

  // A process id can belong to another program after a crash and a restart.
  test("a leftover process id naming a running program does not block the start", async () => {
    const dataDir = tempDataDir()
    writeFileSync(join(dataDir, "instance.pid"), String(process.pid))
    startApp(dataDir, freePort())
    expect((await health((await serverInfo(dataDir)).url)).status).toBe("ok")
  })

  test("a second copy on the same data folder refuses to start", async () => {
    const dataDir = tempDataDir()
    startApp(dataDir, freePort())
    await serverInfo(dataDir)
    const second = startApp(dataDir, freePort())
    const output = await outputOf(second)
    expect(second.exitCode).not.toBe(0)
    expect(output).toContain("already running")
  })

  test("moves to the next free port when its port is taken", async () => {
    const port = freePort()
    const blocker = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("busy") })
    try {
      const dataDir = tempDataDir()
      startApp(dataDir, port)
      const info = await serverInfo(dataDir)
      expect(info.port).not.toBe(port)
      expect((await health(info.url)).status).toBe("ok")
    } finally {
      blocker.stop(true)
    }
  })

  test("accepts connections from this computer only", async () => {
    const dataDir = tempDataDir()
    startApp(dataDir, freePort())
    const info = await serverInfo(dataDir)
    const lanAddress = Object.values(networkInterfaces())
      .flat()
      .find((address) => address !== undefined && address.family === "IPv4" && !address.internal)?.address
    if (lanAddress === undefined) return
    const reached = await fetch(`http://${lanAddress}:${info.port}/api/health`).then(() => true, () => false)
    expect(reached).toBe(false)
  })

  test("the data folder and its files are readable by this user only", async () => {
    if (process.platform === "win32") return
    const dataDir = join(tempDataDir(), "data")
    const proc = startApp(dataDir, freePort())
    await serverInfo(dataDir)
    const mode = (file: string) => statSync(join(dataDir, file)).mode & 0o777
    expect(mode(".")).toBe(0o700)
    expect(mode("gmat-prep.sqlite")).toBe(0o600)
    expect(mode("server.json")).toBe(0o600)
    proc.kill("SIGTERM")
    await proc.exited
  })

  test("the reset command on the host clears the Curator passphrase, even while the app runs", async () => {
    const dataDir = tempDataDir()
    startApp(dataDir, freePort())
    const info = await serverInfo(dataDir)
    const set = await fetch(`${info.url}/api/curator/passphrase`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "correct horse battery" })
    })
    expect(set.status).toBe(204)
    const reset = Bun.spawn([process.execPath, "src/server/main.ts", "reset-passphrase"], {
      cwd: repoRoot,
      env: { ...process.env, GMAT_PREP_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe"
    })
    const output = await outputOf(reset)
    expect(reset.exitCode).toBe(0)
    expect(output).toContain("The Curator passphrase is cleared")
    const status = await (await fetch(`${info.url}/api/curator/status`)).json() as { passphraseSet: boolean }
    expect(status.passphraseSet).toBe(false)
  })

  test("stores PINs only as argon2id hashes", async () => {
    const dataDir = tempDataDir()
    const proc = startApp(dataDir, freePort())
    const info = await serverInfo(dataDir)
    const created = await fetch(`${info.url}/api/profiles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Asha", pin: "246813" })
    })
    expect(created.status).toBe(200)
    proc.kill("SIGTERM")
    await proc.exited
    const db = new Database(join(dataDir, "gmat-prep.sqlite"), { readonly: true })
    const row = db.query("SELECT pin_hash FROM profiles").get() as { pin_hash: string }
    db.close()
    expect(row.pin_hash).toStartWith("$argon2id$")
    expect(row.pin_hash).not.toContain("246813")
  })

  test("refuses a database written by a newer version", async () => {
    const dataDir = tempDataDir()
    const proc = startApp(dataDir, freePort())
    await serverInfo(dataDir)
    proc.kill("SIGTERM")
    await proc.exited
    const db = new Database(join(dataDir, "gmat-prep.sqlite"))
    db.run(
      "INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES ('x', 0, '29991231000000_future', '')"
    )
    db.close()
    const again = startApp(dataDir, freePort())
    const output = await outputOf(again)
    expect(again.exitCode).not.toBe(0)
    expect(output).toContain("newer version")
  })

  // The file opens as a database, so only the integrity check at startup can
  // tell that a page inside it is damaged.
  test("refuses a database with a damaged page", async () => {
    const dataDir = tempDataDir()
    const first = startApp(dataDir, freePort())
    const info = await serverInfo(dataDir)
    const worker = await waitFor(async () => (await health(info.url)).worker.pid ?? undefined)
    first.kill("SIGTERM")
    await first.exited
    // The worker holds the database open too; it must be gone before the file
    // is changed underneath it.
    await waitFor(() => (isAlive(worker) ? undefined : true))
    const file = join(dataDir, "gmat-prep.sqlite")
    const db = new Database(file)
    db.run("PRAGMA journal_mode = DELETE")
    db.run("CREATE TABLE filler (id INTEGER PRIMARY KEY, body TEXT)")
    const insert = db.prepare("INSERT INTO filler (body) VALUES (?)")
    for (let i = 0; i < 400; i++) insert.run(`${"x".repeat(200)}${i}`)
    const pageSize = (db.query("PRAGMA page_size").get() as { page_size: number }).page_size
    const pageCount = (db.query("PRAGMA page_count").get() as { page_count: number }).page_count
    db.close()
    const fd = openSync(file, "r+")
    writeSync(fd, Buffer.alloc(64, 0xff), 0, 64, Math.floor(pageCount / 2) * pageSize + 8)
    closeSync(fd)
    const again = startApp(dataDir, freePort())
    const output = await outputOf(again)
    expect(again.exitCode).not.toBe(0)
    expect(output).toContain("The database file is damaged")
  })

  test("refuses a file that is not a database", async () => {
    const dataDir = tempDataDir()
    writeFileSync(join(dataDir, "gmat-prep.sqlite"), "this is not a database, just text that fills a page ".repeat(200))
    const proc = startApp(dataDir, freePort())
    const output = await outputOf(proc)
    expect(proc.exitCode).not.toBe(0)
    expect(output).toContain("damaged")
  })
})
