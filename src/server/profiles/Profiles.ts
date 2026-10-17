import { and, eq, lt } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Semaphore } from "effect"
import {
  InvalidTimeZone,
  NotUnlocked,
  PinRequired,
  ProfileId,
  ProfileLocked,
  ProfileNameTaken,
  ProfileNotFound,
  ProfileSummary,
  WrongPin
} from "../../api/Profiles.ts"
import { CuratorProfileView } from "../../api/Exports.ts"
import { SnapshotFailed } from "../../api/Snapshots.ts"
import { LastUsedResolutionMs, newToken, sha256, UnlockIdleMs } from "../access/tokens.ts"
import { Db } from "../db/Database.ts"
import { profileUnlocks, profiles } from "../db/schema.ts"
import { Snapshots } from "../snapshots/Snapshots.ts"
import { attemptPin, isLocked } from "./pinLockout.ts"

export interface Unlocked {
  readonly profile: ProfileSummary
  readonly token: string
}

export interface CreateProfile {
  readonly name: string
  readonly pin?: string | undefined
  readonly timeZone?: string | undefined
}

const hostTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

const isValidTimeZone = (timeZone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone })
    return true
  } catch {
    return false
  }
}


const toSummary = (row: typeof profiles.$inferSelect) =>
  new ProfileSummary({
    id: ProfileId.make(row.id),
    name: row.name,
    hasPin: row.pinHash !== null,
    timeZone: row.timeZone,
    rolloverHour: row.rolloverHour
  })

export class Profiles extends Context.Service<Profiles, {
  readonly list: Effect.Effect<ReadonlyArray<ProfileSummary>>
  create(input: CreateProfile): Effect.Effect<Unlocked, ProfileNameTaken | InvalidTimeZone>
  unlock(id: ProfileId, pin: string | undefined): Effect.Effect<Unlocked, ProfileNotFound | PinRequired | WrongPin | ProfileLocked>
  fromToken(token: string, use?: boolean): Effect.Effect<ProfileSummary, NotUnlocked>
  lock(token: string): Effect.Effect<void>
  // Deletes a Profile and all it holds, after a snapshot (decision 115):
  // the Learner's own with its PIN, if it has one; any by the Curator, who
  // has entered the passphrase again.
  removeOwn(id: ProfileId, pin: string | undefined): Effect.Effect<void, ProfileNotFound | PinRequired | WrongPin | ProfileLocked | SnapshotFailed>
  removeByCurator(id: ProfileId): Effect.Effect<void, ProfileNotFound | SnapshotFailed>
  // The Curator sets a Profile's PIN anew, or takes it away (decision 116):
  // wrong entries and a lock clear, and every browser must unlock again.
  resetPin(id: ProfileId, pin: string | null): Effect.Effect<ProfileSummary, ProfileNotFound>
  // Every Profile with when it was made and any lock, for the Curator.
  readonly forCurator: Effect.Effect<ReadonlyArray<CuratorProfileView>>
}>()("gmat-prep/server/Profiles") {
  static readonly layer = Layer.effect(
    Profiles,
    Effect.gen(function*() {
      const db = yield* Db
      const snapshots = yield* Snapshots
      // Creating a Profile and checking a PIN each read, decide and write, so
      // they run one at a time: creations together, so two cannot take one
      // name, and PIN checks per Profile, so guesses sent together still count
      // one by one.
      const oneCreationAtATime = (yield* Semaphore.make(1)).withPermits(1)
      const pinChecks = new Map<string, Semaphore.Semaphore>()
      const onePinCheckAtATime = (profileId: string) => {
        let semaphore = pinChecks.get(profileId)
        if (semaphore === undefined) {
          semaphore = Semaphore.makeUnsafe(1)
          pinChecks.set(profileId, semaphore)
        }
        return semaphore.withPermits(1)
      }

      const issueToken = Effect.fn("Profiles.issueToken")(function*(profileId: string) {
        const token = newToken()
        const now = yield* Clock.currentTimeMillis
        yield* db.insert(profileUnlocks).values({ tokenHash: sha256(token), profileId, createdAt: now, lastUsedAt: now })
        return token
      }, Effect.orDie)

      const list = db.select().from(profiles).orderBy(profiles.createdAt).pipe(
        Effect.map((rows) => rows.map(toSummary)),
        Effect.orDie
      )

      const create = Effect.fn("Profiles.create")(function*(input: CreateProfile) {
        const name = input.name.trim()
        const nameKey = name.toLowerCase()
        const timeZone = input.timeZone ?? hostTimeZone()
        if (!isValidTimeZone(timeZone)) {
          return yield* new InvalidTimeZone({ timeZone })
        }
        const taken = yield* db.select({ id: profiles.id }).from(profiles).where(eq(profiles.nameKey, nameKey)).pipe(
          Effect.orDie
        )
        if (taken.length > 0) {
          return yield* new ProfileNameTaken({ name })
        }
        const pin = input.pin
        const pinHash = pin === undefined
          ? null
          : yield* Effect.promise(() => Bun.password.hash(pin, { algorithm: "argon2id" }))
        const createdAt = yield* Clock.currentTimeMillis
        const [row] = yield* db.insert(profiles)
          .values({ id: crypto.randomUUID(), name, nameKey, pinHash, timeZone, createdAt })
          .returning()
          .pipe(Effect.orDie)
        if (row === undefined) {
          return yield* Effect.die("profile insert returned no row")
        }
        const token = yield* issueToken(row.id)
        return { profile: toSummary(row), token }
      }, oneCreationAtATime)

      // The Profile, once its PIN, if it has one, is given right.
      const checkPin = Effect.fn("Profiles.checkPin")(function*(id: ProfileId, pin: string | undefined) {
        const [row] = yield* db.select().from(profiles).where(eq(profiles.id, id)).pipe(Effect.orDie)
        if (row === undefined) {
          return yield* new ProfileNotFound()
        }
        const pinHash = row.pinHash
        if (pinHash !== null) {
          if (pin === undefined) {
            return yield* new PinRequired()
          }
          const now = yield* Clock.currentTimeMillis
          const state = { failedAttempts: row.failedPinAttempts, lockedUntil: row.lockedUntil }
          if (isLocked(state, now)) {
            return yield* new ProfileLocked({ lockedUntil: state.lockedUntil ?? now })
          }
          const correct = yield* Effect.promise(() => Bun.password.verify(pin, pinHash))
          const attempt = attemptPin(state, now, correct)
          yield* db.update(profiles)
            .set({ failedPinAttempts: attempt.next.failedAttempts, lockedUntil: attempt.next.lockedUntil })
            .where(eq(profiles.id, id))
            .pipe(Effect.orDie)
          switch (attempt._tag) {
            case "Rejected":
              return yield* new WrongPin({ attemptsLeft: attempt.attemptsLeft })
            case "Locked":
              return yield* new ProfileLocked({ lockedUntil: attempt.lockedUntil })
            case "Accepted":
              break
          }
        }
        return row
      })

      const unlock = (id: ProfileId, pin: string | undefined) =>
        checkPin(id, pin).pipe(
          Effect.flatMap((row) => issueToken(row.id).pipe(Effect.map((token) => ({ profile: toSummary(row), token })))),
          onePinCheckAtATime(id)
        )

      // A snapshot first; if it cannot be taken, nothing is deleted.
      const remove = (id: ProfileId) =>
        Effect.gen(function*() {
          yield* snapshots.take("pre-deletion")
          yield* db.delete(profiles).where(eq(profiles.id, id)).pipe(Effect.orDie)
        })

      const removeOwn = (id: ProfileId, pin: string | undefined) =>
        checkPin(id, pin).pipe(Effect.andThen(remove(id)), onePinCheckAtATime(id))

      const removeByCurator = (id: ProfileId) =>
        Effect.gen(function*() {
          const [row] = yield* db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, id)).pipe(Effect.orDie)
          if (row === undefined) return yield* new ProfileNotFound()
          yield* remove(id)
        }).pipe(onePinCheckAtATime(id))

      const resetPin = (id: ProfileId, pin: string | null) =>
        Effect.gen(function*() {
          const pinHash = pin === null ? null : yield* Effect.promise(() => Bun.password.hash(pin, { algorithm: "argon2id" }))
          const [row] = yield* db.update(profiles).set({ pinHash, failedPinAttempts: 0, lockedUntil: null })
            .where(eq(profiles.id, id)).returning().pipe(Effect.orDie)
          if (row === undefined) return yield* new ProfileNotFound()
          yield* db.delete(profileUnlocks).where(eq(profileUnlocks.profileId, id)).pipe(Effect.orDie)
          return toSummary(row)
        }).pipe(onePinCheckAtATime(id))

      // An unlock that has gone unused for UnlockIdleMs ends. Use moves its
      // last-used time on, written at most every few minutes; a request the
      // page made on its own is not use.
      const fromToken = Effect.fn("Profiles.fromToken")(function*(token: string, use: boolean = true) {
        const tokenHash = sha256(token)
        const rows = yield* db.select({ profile: profiles, lastUsedAt: profileUnlocks.lastUsedAt })
          .from(profileUnlocks)
          .innerJoin(profiles, eq(profileUnlocks.profileId, profiles.id))
          .where(eq(profileUnlocks.tokenHash, tokenHash))
          .pipe(Effect.orDie)
        const [match] = rows
        if (match === undefined) {
          return yield* new NotUnlocked()
        }
        const now = yield* Clock.currentTimeMillis
        if (now - match.lastUsedAt > UnlockIdleMs) {
          yield* db.delete(profileUnlocks).where(eq(profileUnlocks.tokenHash, tokenHash)).pipe(Effect.orDie)
          return yield* new NotUnlocked()
        }
        if (use && now - match.lastUsedAt > LastUsedResolutionMs) {
          yield* db.update(profileUnlocks)
            .set({ lastUsedAt: now })
            .where(and(eq(profileUnlocks.tokenHash, tokenHash), lt(profileUnlocks.lastUsedAt, now)))
            .pipe(Effect.orDie)
        }
        return toSummary(match.profile)
      })

      const lock = Effect.fn("Profiles.lock")(function*(token: string) {
        yield* db.delete(profileUnlocks).where(eq(profileUnlocks.tokenHash, sha256(token))).pipe(Effect.orDie)
      })

      const forCurator = Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        const rows = yield* db.select().from(profiles).orderBy(profiles.nameKey).pipe(Effect.orDie)
        return rows.map((row) =>
          new CuratorProfileView({
            profile: toSummary(row),
            createdAt: row.createdAt,
            lockedUntil: row.lockedUntil !== null && row.lockedUntil > now ? row.lockedUntil : null
          })
        )
      })

      return Profiles.of({ list, create, unlock, fromToken, lock, removeOwn, removeByCurator, resetPin, forCurator })
    })
  )
}
