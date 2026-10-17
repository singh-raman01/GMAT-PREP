import { open } from "node:fs/promises"

// A tar archive in the POSIX ustar format, written a piece at a time, so a
// large install never sits in memory. Names are relative paths of at most
// 100 bytes, which the data folder's files keep to.

const Block = 512

export interface TarEntry {
  // The path inside the archive, such as books/<hash>.pdf.
  readonly name: string
  // The file on disk.
  readonly path: string
  readonly size: number
  readonly modified: number
}

const encoder = new TextEncoder()

export const tarHeader = (entry: Pick<TarEntry, "name" | "size" | "modified">) => {
  const name = encoder.encode(entry.name)
  if (name.length > 100) throw new Error(`The name ${entry.name} is too long for the archive.`)
  const block = new Uint8Array(Block)
  const put = (text: string, offset: number) => block.set(encoder.encode(text), offset)
  const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`
  block.set(name, 0)
  put(octal(0o600, 8), 100)
  put(octal(0, 8), 108)
  put(octal(0, 8), 116)
  put(octal(entry.size, 12), 124)
  put(octal(Math.floor(entry.modified / 1000), 12), 136)
  // The checksum counts its own field as spaces.
  put("        ", 148)
  put("0", 156)
  put("ustar\0", 257)
  put("00", 263)
  const sum = block.reduce((total, byte) => total + byte, 0)
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148)
  return block
}

// Writes the entries to a new archive file; each file is read in pieces.
export const writeTar = async (target: string, entries: ReadonlyArray<TarEntry>) => {
  const out = await open(target, "wx", 0o600)
  try {
    for (const entry of entries) {
      await out.write(tarHeader(entry))
      let written = 0
      for await (const piece of Bun.file(entry.path).stream()) {
        await out.write(piece)
        written += piece.length
      }
      if (written !== entry.size) throw new Error(`${entry.name} changed while it was being archived.`)
      const padding = (Block - (written % Block)) % Block
      if (padding > 0) await out.write(new Uint8Array(padding))
    }
    // Two empty blocks end the archive.
    await out.write(new Uint8Array(2 * Block))
  } finally {
    await out.close()
  }
}

// The entries of an archive with their contents, for checking one.
export const readTar = (bytes: Uint8Array) => {
  const decoder = new TextDecoder()
  const files: Array<{ readonly name: string; readonly content: Uint8Array }> = []
  for (let offset = 0; offset + Block <= bytes.length;) {
    const header = bytes.subarray(offset, offset + Block)
    if (header.every((byte) => byte === 0)) break
    const field = (from: number, length: number) => decoder.decode(header.subarray(from, from + length)).replace(/\0.*$/s, "")
    const size = parseInt(field(124, 12).trim(), 8)
    const content = bytes.subarray(offset + Block, offset + Block + size)
    files.push({ name: field(0, 100), content })
    offset += Block + Math.ceil(size / Block) * Block
  }
  return files
}
