import { afterAll } from "bun:test"
import { rmSync } from "node:fs"

// Folders the tests make, removed once the whole run ends: a full run makes
// hundreds, and left behind they fill the disk. This file is the test
// preload (bunfig.toml), as `bun test` runs no exit handlers; its top-level
// afterAll runs once, after every file.
const made = new Set<string>()

export const removeAtEnd = (...paths: ReadonlyArray<string>) => {
  for (const path of paths) made.add(path)
}

afterAll(() => {
  for (const path of made) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // Still open, as a file can be on Windows: the system's temp folder
      // takes it.
    }
  }
})
