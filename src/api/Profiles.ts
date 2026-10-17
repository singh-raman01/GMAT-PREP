import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, HttpApiSecurity } from "effect/http-api"

export const ProfileId = Schema.String.pipe(Schema.brand("ProfileId"))
export type ProfileId = typeof ProfileId.Type

// Surrounding spaces are allowed on input and trimmed by the server; what is
// left must be 1 to 40 characters.
export const ProfileName = Schema.String.check(
  Schema.makeFilter((name: string) => {
    const length = name.trim().length
    return length >= 1 && length <= 40
  }, { description: "a name of 1 to 40 characters" })
)

// A PIN is 4 to 8 digits. It is optional per Profile.
export const Pin = Schema.String.check(Schema.isPattern(/^\d{4,8}$/))

export class ProfileSummary extends Schema.Class<ProfileSummary>("gmat-prep/api/ProfileSummary")({
  id: ProfileId,
  name: Schema.String,
  hasPin: Schema.Boolean,
  timeZone: Schema.String,
  rolloverHour: Schema.Int
}) {}

export class ProfileNotFound extends Schema.TaggedError<ProfileNotFound>()(
  "ProfileNotFound",
  {},
  { httpApiStatus: 404 }
) {}

export class ProfileNameTaken extends Schema.TaggedError<ProfileNameTaken>()(
  "ProfileNameTaken",
  { name: Schema.String },
  { httpApiStatus: 409 }
) {}

export class InvalidTimeZone extends Schema.TaggedError<InvalidTimeZone>()(
  "InvalidTimeZone",
  { timeZone: Schema.String },
  { httpApiStatus: 400 }
) {}

export class WrongPin extends Schema.TaggedError<WrongPin>()(
  "WrongPin",
  { attemptsLeft: Schema.Int },
  { httpApiStatus: 401 }
) {}

// The Profile has a PIN and none was sent. It costs no attempt.
export class PinRequired extends Schema.TaggedError<PinRequired>()(
  "PinRequired",
  {},
  { httpApiStatus: 401 }
) {}

export class ProfileLocked extends Schema.TaggedError<ProfileLocked>()(
  "ProfileLocked",
  { lockedUntil: Schema.Number },
  { httpApiStatus: 423 }
) {}

export class NotUnlocked extends Schema.TaggedError<NotUnlocked>()(
  "NotUnlocked",
  {},
  { httpApiStatus: 401 }
) {}

// The unlocked Profile travels in an HttpOnly cookie, so browsers send it
// without any client code.
export const ProfileCookie = HttpApiSecurity.apiKey({ key: "gp_profile", in: "cookie" })

// Marks a request a page makes on its own, such as the Plan page's timed
// re-read: it does not count as use, so a page left open does not keep its
// Profile unlocked.
export const BackgroundHeader = "x-gp-background"

export class CurrentProfile extends Context.Service<CurrentProfile, ProfileSummary>()(
  "gmat-prep/api/CurrentProfile"
) {}

export class ProfileSession extends HttpApiMiddleware.Service<ProfileSession, {
  provides: CurrentProfile
  requires: never
}>()("gmat-prep/api/ProfileSession", {
  security: { cookie: ProfileCookie },
  error: NotUnlocked
}) {}

export class ProfilesApi extends HttpApiGroup.make("profiles")
  .add(
    HttpApiEndpoint.get("list", "/", {
      success: Schema.Array(ProfileSummary)
    }),
    HttpApiEndpoint.post("create", "/", {
      payload: Schema.Struct({
        name: ProfileName,
        pin: Schema.optional(Pin),
        timeZone: Schema.optional(Schema.String)
      }),
      success: ProfileSummary,
      error: [ProfileNameTaken, InvalidTimeZone]
    }),
    // A PIN that is not 4 to 8 digits is refused before it is checked, so it
    // costs no attempt.
    HttpApiEndpoint.post("unlock", "/:id/unlock", {
      params: { id: ProfileId },
      payload: Schema.Struct({ pin: Schema.optional(Pin) }),
      success: ProfileSummary,
      error: [ProfileNotFound, PinRequired, WrongPin, ProfileLocked]
    })
  )
  .prefix("/api/profiles")
{}

export class SessionApi extends HttpApiGroup.make("session")
  .add(
    HttpApiEndpoint.get("me", "/", {
      success: ProfileSummary
    }),
    HttpApiEndpoint.post("lock", "/lock", {
      success: HttpApiSchema.NoContent
    })
  )
  .middleware(ProfileSession)
  .prefix("/api/session")
{}
