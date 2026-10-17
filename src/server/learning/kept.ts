import { Effect } from "effect"

// Rows a table only ever gains, kept between reads for the few Profiles read
// last, so a read takes only the rows written since the last one kept. What
// is kept is checked first: when fewer rows now reach the last one kept, or
// another row has taken its place, as after a deletion or a restore, they
// are all read again.

export interface Since<Item> {
  readonly items: ReadonlyArray<Item>
  // The newest row read: its rowid, and what tells it apart from a row that
  // might take its place.
  readonly newest: { readonly rowid: number; readonly identity: string } | undefined
}

export interface KeptRead<Item> {
  readonly items: ReadonlyArray<Item>
  // Those read now; all of them when nothing was kept.
  readonly added: ReadonlyArray<Item>
  readonly fresh: boolean
}

export const keptRows = <Item>(options: {
  // The Profile's rows after a rowid, with the newest of them.
  readonly since: (profileId: string, after: number) => Effect.Effect<Since<Item>>
  // How many of the Profile's rows reach a rowid, and the identity of the
  // row at it, if any.
  readonly check: (profileId: string, upTo: number) => Effect.Effect<{ readonly count: number; readonly identity: string | null }>
  readonly profiles: number
}) => {
  type Kept = { readonly items: ReadonlyArray<Item>; readonly newest: Since<Item>["newest"] }
  const kept = new Map<string, Kept>()
  return (profileId: string): Effect.Effect<KeptRead<Item>> =>
    Effect.gen(function*() {
      const found = kept.get(profileId)
      const intact = found === undefined || found.newest === undefined ? found : yield* options.check(profileId, found.newest.rowid).pipe(
        Effect.map((check) => (check.count === found.items.length && check.identity === found.newest!.identity ? found : undefined))
      )
      const since = yield* options.since(profileId, intact?.newest?.rowid ?? 0)
      const next: Kept = {
        items: intact === undefined ? since.items : since.items.length === 0 ? intact.items : [...intact.items, ...since.items],
        newest: since.newest ?? intact?.newest
      }
      kept.delete(profileId)
      kept.set(profileId, next)
      for (const oldest of [...kept.keys()].slice(0, Math.max(0, kept.size - options.profiles))) kept.delete(oldest)
      return { items: next.items, added: since.items, fresh: intact === undefined }
    })
}
