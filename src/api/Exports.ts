import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { CuratorLocked, CuratorSession, PassphraseNotSet, WrongPassphrase } from "./Curator.ts"
import { Pin, PinRequired, ProfileId, ProfileLocked, ProfileNotFound, ProfileSession, ProfileSummary, WrongPin } from "./Profiles.ts"
import { SnapshotFailed } from "./Snapshots.ts"

// Exports, Profile deletion and PIN resets (docs/design.md, "Data safety and
// operations", decisions 113 to 116).

// Everything a Profile holds, table by table as the database keeps it, with
// no PIN or unlock.
export class ProfileExport extends Schema.Class<ProfileExport>("gmat-prep/api/ProfileExport")({
  format: Schema.Literal("gmat-prep-profile"),
  version: Schema.Literal(1),
  exportedAt: Schema.Number,
  profile: Schema.Struct({
    id: ProfileId,
    name: Schema.String,
    hasPin: Schema.Boolean,
    timeZone: Schema.String,
    rolloverHour: Schema.Int,
    createdAt: Schema.Number
  }),
  tables: Schema.Record(Schema.String, Schema.Array(Schema.Record(Schema.String, Schema.Unknown)))
}) {}

// The install's archive: the database, the Books and the figures.
export class InstallExportView extends Schema.Class<InstallExportView>("gmat-prep/api/InstallExportView")({
  name: Schema.String,
  // In bytes.
  size: Schema.Number,
  at: Schema.Number
}) {}

export class ExportFailed extends Schema.TaggedError<ExportFailed>()(
  "ExportFailed",
  { detail: Schema.String, diskFull: Schema.Boolean },
  { httpApiStatus: 503 }
) {}

// A Profile as the Curator sees it, to reset its PIN or delete it.
export class CuratorProfileView extends Schema.Class<CuratorProfileView>("gmat-prep/api/CuratorProfileView")({
  profile: ProfileSummary,
  createdAt: Schema.Number,
  // Locked by wrong PINs until then.
  lockedUntil: Schema.NullOr(Schema.Number)
}) {}

export const InstallExportPath = "/api/curator/export/file"

export class SessionDataApi extends HttpApiGroup.make("sessionData")
  .add(
    HttpApiEndpoint.get("export", "/export", { success: ProfileExport }),
    // Deletes the signed-in Profile, with its PIN if it has one.
    HttpApiEndpoint.post("remove", "/delete", {
      payload: Schema.Struct({ pin: Schema.optional(Pin) }),
      success: HttpApiSchema.NoContent,
      error: [ProfileNotFound, PinRequired, WrongPin, ProfileLocked, SnapshotFailed]
    })
  )
  .middleware(ProfileSession)
  .prefix("/api/session")
{}

export class CuratorDataApi extends HttpApiGroup.make("curatorData")
  .add(
    HttpApiEndpoint.get("profiles", "/profiles", { success: Schema.Array(CuratorProfileView) }),
    HttpApiEndpoint.post("resetPin", "/profiles/:id/pin", {
      params: { id: ProfileId },
      // A new PIN, or none to take it away.
      payload: Schema.Struct({ pin: Schema.NullOr(Pin) }),
      success: ProfileSummary,
      error: ProfileNotFound
    }),
    HttpApiEndpoint.post("removeProfile", "/profiles/:id/delete", {
      params: { id: ProfileId },
      payload: Schema.Struct({ passphrase: Schema.String }),
      success: HttpApiSchema.NoContent,
      error: [ProfileNotFound, WrongPassphrase, CuratorLocked, PassphraseNotSet, SnapshotFailed]
    }),
    // The latest archive of the install, if one was made.
    HttpApiEndpoint.get("installExport", "/export", { success: Schema.NullOr(InstallExportView) }),
    HttpApiEndpoint.post("exportInstall", "/export", { success: InstallExportView, error: ExportFailed })
  )
  .middleware(CuratorSession)
  .prefix("/api/curator")
{}
