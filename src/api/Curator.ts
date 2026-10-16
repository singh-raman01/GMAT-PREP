import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, HttpApiSecurity } from "effect/http-api"

// The Curator passphrase guards every Curator operation. It is set once, on
// first use, and reset only by a command run on the host computer.
export const Passphrase = Schema.String.check(
  Schema.makeFilter((passphrase: string) => passphrase.length >= 8 && passphrase.length <= 200, {
    description: "a passphrase of 8 to 200 characters"
  })
)

export class CuratorStatus extends Schema.Class<CuratorStatus>("gmat-prep/api/CuratorStatus")({
  passphraseSet: Schema.Boolean,
  // Whether this browser holds a Curator unlock.
  unlocked: Schema.Boolean
}) {}

export class PassphraseNotSet extends Schema.TaggedError<PassphraseNotSet>()(
  "PassphraseNotSet",
  {},
  { httpApiStatus: 409 }
) {}

export class PassphraseAlreadySet extends Schema.TaggedError<PassphraseAlreadySet>()(
  "PassphraseAlreadySet",
  {},
  { httpApiStatus: 409 }
) {}

export class WrongPassphrase extends Schema.TaggedError<WrongPassphrase>()(
  "WrongPassphrase",
  { attemptsLeft: Schema.Int },
  { httpApiStatus: 401 }
) {}

export class CuratorLocked extends Schema.TaggedError<CuratorLocked>()(
  "CuratorLocked",
  { lockedUntil: Schema.Number },
  { httpApiStatus: 423 }
) {}

export class CuratorNotUnlocked extends Schema.TaggedError<CuratorNotUnlocked>()(
  "CuratorNotUnlocked",
  {},
  { httpApiStatus: 401 }
) {}

export const CuratorCookie = HttpApiSecurity.apiKey({ key: "gp_curator", in: "cookie" })

export class CuratorSession extends HttpApiMiddleware.Service<CuratorSession, {
  provides: never
  requires: never
}>()("gmat-prep/api/CuratorSession", {
  security: { cookie: CuratorCookie },
  error: CuratorNotUnlocked
}) {}

export class CuratorAccessApi extends HttpApiGroup.make("curatorAccess")
  .add(
    HttpApiEndpoint.get("status", "/status", {
      success: CuratorStatus
    }),
    HttpApiEndpoint.post("setPassphrase", "/passphrase", {
      payload: Schema.Struct({ passphrase: Passphrase }),
      success: HttpApiSchema.NoContent,
      error: PassphraseAlreadySet
    }),
    HttpApiEndpoint.post("unlock", "/unlock", {
      payload: Schema.Struct({ passphrase: Schema.String }),
      success: HttpApiSchema.NoContent,
      error: [PassphraseNotSet, WrongPassphrase, CuratorLocked]
    })
  )
  .prefix("/api/curator")
{}

export class CuratorSessionApi extends HttpApiGroup.make("curatorSession")
  .add(
    HttpApiEndpoint.post("lock", "/lock", {
      success: HttpApiSchema.NoContent
    })
  )
  .middleware(CuratorSession)
  .prefix("/api/curator")
{}
