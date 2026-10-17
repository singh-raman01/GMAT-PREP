import { closeSync, fsyncSync, openSync, readSync, renameSync, rmSync, statSync } from "node:fs"
import { dirname } from "node:path"

// Files the snapshot and export work writes. Each is written under a
// temporary name and moved into place only once it is complete and checked,
// so a file under a final name is never half written.

export const PartSuffix = ".part"

// Removes a file this work made, with the journal SQLite may leave beside it.
export const removeWorkFile = (path: string) => {
  for (const each of [path, `${path}-journal`]) rmSync(each, { force: true })
}

// Writes a file's contents to the disk, so a power cut after it is moved
// into place cannot leave it short.
export const syncFile = (path: string) => {
  const fd = openSync(path, "r+")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

// Writes a folder's entries to the disk, so a rename in it holds after a
// power cut. Where a folder cannot be opened for this, as on Windows, the
// rename is left as the system wrote it.
export const syncFolder = (folder: string) => {
  let fd: number
  try {
    fd = openSync(folder, "r")
  } catch {
    return
  }
  try {
    fsyncSync(fd)
  } catch {
    // Some file systems refuse to sync a folder.
  } finally {
    closeSync(fd)
  }
}

// Moves a complete, checked file from its temporary name to its own.
export const moveIntoPlace = (part: string, file: string) => {
  renameSync(part, file)
  syncFolder(dirname(file))
}

// SQLite's smallest page; a database file holds at least one.
export const MinPageBytes = 512
const Header = new TextEncoder().encode("SQLite format 3\0")

// Why a file cannot be an SQLite database, or undefined when it may be one:
// it must be a file of at least one page that starts with SQLite's header.
export const notADatabase = (path: string): string | undefined => {
  const found = statSync(path, { throwIfNoEntry: false })
  if (found === undefined) return "it is no longer there"
  if (!found.isFile()) return "it is not a file"
  if (found.size < MinPageBytes) return found.size === 0 ? "it is empty" : `it is ${found.size} bytes, less than a page`
  const head = new Uint8Array(Header.length)
  const fd = openSync(path, "r")
  try {
    readSync(fd, head, 0, head.length, 0)
  } finally {
    closeSync(fd)
  }
  return head.every((byte, index) => byte === Header[index]) ? undefined : "it is not an SQLite database"
}

// Whether an SQLite database file says it is in rollback-journal mode, as a
// copy made by VACUUM INTO is, rather than in WAL mode.
export const inRollbackMode = (path: string) => {
  if (notADatabase(path) !== undefined) return false
  const versions = new Uint8Array(2)
  const fd = openSync(path, "r")
  try {
    // The header's write and read format versions: 1 for rollback, 2 for WAL.
    readSync(fd, versions, 0, 2, 18)
  } finally {
    closeSync(fd)
  }
  return versions[0] === 1 && versions[1] === 1
}
