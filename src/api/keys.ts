// A Question's key, as Sources, Approaches and solves give one: the right
// option of each Part, in order, joined with commas, such as C for one Part
// or A,B,A for three. Unknown while a Part has no key.
export const joinedKey = (keys: ReadonlyArray<string | null>): string | null =>
  keys.length > 0 && keys.every((key) => key !== null) ? keys.join(",") : null

// Each Part's key from a joined key.
export const partKeys = (key: string | null, parts: number): ReadonlyArray<string | null> => {
  const keys = key === null ? [] : key.split(",")
  return Array.from({ length: parts }, (_, index) => keys[index] ?? null)
}
