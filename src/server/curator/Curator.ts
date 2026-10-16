import { and, eq, lt } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Semaphore } from "effect"
import {
  CuratorLocked,
  CuratorNotUnlocked,
  CuratorStatus,
  PassphraseAlreadySet,
  PassphraseNotSet,
  WrongPassphrase
} from "../../api/Curator.ts"
import { LastUsedResolutionMs, newToken, sha256, UnlockIdleMs } from "../access/tokens.ts"
import { Db } from "../db/Database.ts"
import { curatorAccess, curatorUnlocks } from "../db/schema.ts"
import { attemptPin, isLocked } from "../profiles/pinLockout.ts"

const AccessRow = 1

export class Curator extends Context.Service<Curator, {
  status(token: string | undefined): Effect.Effect<CuratorStatus>
  // Sets the passphrase on first use and returns an unlock token.
  setPassphrase(passphrase: string): Effect.Effect<string, PassphraseAlreadySet>
  unlock(passphrase: string): Effect.Effect<string, PassphraseNotSet | WrongPassphrase | CuratorLocked>
  check(token: string): Effect.Effect<void, CuratorNotUnlocked>
  lock(token: string): Effect.Effect<void>
  // Clears the passphrase and every unlock, for the reset command on the host.
  readonly reset: Effect.Effect<void>
}>()("gmat-prep/server/Curator") {
  static readonly layer = Layer.effect(
    Curator,
    Effect.gen(function*() {
      const db = yield* Db
      // Setting and checking the passphrase read, decide and write; one at a
      // time, as with PINs, so parallel guesses still count one by one.
      const oneAtATime = (yield* Semaphore.make(1)).withPermits(1)

      const access = db.select().from(curatorAccess).where(eq(curatorAccess.id, AccessRow)).pipe(
        Effect.map((rows) => rows[0]),
        Effect.orDie
      )

      const issueToken = Effect.gen(function*() {
        const token = newToken()
        const now = yield* Clock.currentTimeMillis
        yield* db.insert(curatorUnlocks).values({ tokenHash: sha256(token), createdAt: now, lastUsedAt: now }).pipe(
          Effect.orDie
        )
        return token
      })

      // Whether the token is a live unlock. One unused for UnlockIdleMs ends;
      // use moves its last-used time on, written at most every few minutes.
      const isUnlocked = (token: string) =>
        Effect.gen(function*() {
          const tokenHash = sha256(token)
          const [row] = yield* db.select().from(curatorUnlocks).where(eq(curatorUnlocks.tokenHash, tokenHash))
          if (row === undefined) return false
          const now = yield* Clock.currentTimeMillis
          if (now - row.lastUsedAt > UnlockIdleMs) {
            yield* db.delete(curatorUnlocks).where(eq(curatorUnlocks.tokenHash, tokenHash))
            return false
          }
          if (now - row.lastUsedAt > LastUsedResolutionMs) {
            yield* db.update(curatorUnlocks)
              .set({ lastUsedAt: now })
              .where(and(eq(curatorUnlocks.tokenHash, tokenHash), lt(curatorUnlocks.lastUsedAt, now)))
          }
          return true
        }).pipe(Effect.orDie)

      const status = Effect.fn("Curator.status")(function*(token: string | undefined) {
        const row = yield* access
        const unlocked = row !== undefined && token !== undefined && token !== "" ? yield* isUnlocked(token) : false
        return new CuratorStatus({ passphraseSet: row !== undefined, unlocked })
      })

      const setPassphrase = Effect.fn("Curator.setPassphrase")(function*(passphrase: string) {
        if ((yield* access) !== undefined) {
          return yield* new PassphraseAlreadySet()
        }
        const passphraseHash = yield* Effect.promise(() => Bun.password.hash(passphrase, { algorithm: "argon2id" }))
        const setAt = yield* Clock.currentTimeMillis
        yield* db.insert(curatorAccess).values({ id: AccessRow, passphraseHash, setAt }).pipe(Effect.orDie)
        return yield* issueToken
      }, oneAtATime)

      const unlock = Effect.fn("Curator.unlock")(function*(passphrase: string) {
        const row = yield* access
        if (row === undefined) {
          return yield* new PassphraseNotSet()
        }
        const now = yield* Clock.currentTimeMillis
        const state = { failedAttempts: row.failedAttempts, lockedUntil: row.lockedUntil }
        if (isLocked(state, now)) {
          return yield* new CuratorLocked({ lockedUntil: state.lockedUntil ?? now })
        }
        const correct = yield* Effect.promise(() => Bun.password.verify(passphrase, row.passphraseHash))
        const attempt = attemptPin(state, now, correct)
        yield* db.update(curatorAccess)
          .set({ failedAttempts: attempt.next.failedAttempts, lockedUntil: attempt.next.lockedUntil })
          .where(eq(curatorAccess.id, AccessRow))
          .pipe(Effect.orDie)
        switch (attempt._tag) {
          case "Rejected":
            return yield* new WrongPassphrase({ attemptsLeft: attempt.attemptsLeft })
          case "Locked":
            return yield* new CuratorLocked({ lockedUntil: attempt.lockedUntil })
          case "Accepted":
            return yield* issueToken
        }
      }, oneAtATime)

      const check = Effect.fn("Curator.check")(function*(token: string) {
        if (!(yield* isUnlocked(token))) {
          return yield* new CuratorNotUnlocked()
        }
      })

      const lock = Effect.fn("Curator.lock")(function*(token: string) {
        yield* db.delete(curatorUnlocks).where(eq(curatorUnlocks.tokenHash, sha256(token))).pipe(Effect.orDie)
      })

      const reset = Effect.gen(function*() {
        yield* db.delete(curatorUnlocks).pipe(Effect.orDie)
        yield* db.delete(curatorAccess).pipe(Effect.orDie)
      }).pipe(oneAtATime)

      return Curator.of({ status, setPassphrase, unlock, check, lock, reset })
    })
  )
}
