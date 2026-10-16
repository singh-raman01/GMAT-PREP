import { eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Semaphore } from "effect"
import {
  InvalidTimeZone,
  NotUnlocked,
  ProfileId,
  ProfileLocked,
  ProfileNameTaken,
  ProfileNotFound,
  ProfileSummary,
  WrongPin
} from "../../api/Profiles.ts"
import { Db } from "../db/Database.ts"
import { profileUnlocks, profiles } from "../db/schema.ts"
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

const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

const newToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")

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
  unlock(id: ProfileId, pin: string | undefined): Effect.Effect<Unlocked, ProfileNotFound | WrongPin | ProfileLocked>
  fromToken(token: string): Effect.Effect<ProfileSummary, NotUnlocked>
  lock(token: string): Effect.Effect<void>
}>()("gmat-prep/server/Profiles") {
  static readonly layer = Layer.effect(
    Profiles,
    Effect.gen(function*() {
      const db = yield* Db
      // Creating a Profile and checking a PIN each read, decide and write. One
      // at a time, so requests sent together cannot share a free attempt count
      // or a free name.
      const oneAtATime = (yield* Semaphore.make(1)).withPermits(1)

      const issueToken = Effect.fn("Profiles.issueToken")(function*(profileId: string) {
        const token = newToken()
        const createdAt = yield* Clock.currentTimeMillis
        yield* db.insert(profileUnlocks).values({ tokenHash: sha256(token), profileId, createdAt })
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
      }, oneAtATime)

      const unlock = Effect.fn("Profiles.unlock")(function*(id: ProfileId, pin: string | undefined) {
        const [row] = yield* db.select().from(profiles).where(eq(profiles.id, id)).pipe(Effect.orDie)
        if (row === undefined) {
          return yield* new ProfileNotFound()
        }
        const pinHash = row.pinHash
        if (pinHash !== null) {
          const now = yield* Clock.currentTimeMillis
          const state = { failedAttempts: row.failedPinAttempts, lockedUntil: row.lockedUntil }
          if (isLocked(state, now)) {
            return yield* new ProfileLocked({ lockedUntil: state.lockedUntil ?? now })
          }
          const correct = pin === undefined
            ? false
            : yield* Effect.promise(() => Bun.password.verify(pin, pinHash))
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
        const token = yield* issueToken(row.id)
        return { profile: toSummary(row), token }
      }, oneAtATime)

      const fromToken = Effect.fn("Profiles.fromToken")(function*(token: string) {
        const rows = yield* db.select({ profile: profiles })
          .from(profileUnlocks)
          .innerJoin(profiles, eq(profileUnlocks.profileId, profiles.id))
          .where(eq(profileUnlocks.tokenHash, sha256(token)))
          .pipe(Effect.orDie)
        const [match] = rows
        if (match === undefined) {
          return yield* new NotUnlocked()
        }
        return toSummary(match.profile)
      })

      const lock = Effect.fn("Profiles.lock")(function*(token: string) {
        yield* db.delete(profileUnlocks).where(eq(profileUnlocks.tokenHash, sha256(token))).pipe(Effect.orDie)
      })

      return Profiles.of({ list, create, unlock, fromToken, lock })
    })
  )
}
