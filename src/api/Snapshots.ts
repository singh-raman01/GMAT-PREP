import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { CuratorLocked, CuratorSession, PassphraseNotSet, WrongPassphrase } from "./Curator.ts"

// Snapshots of the database and restoring one (docs/design.md, "Data safety
// and operations", decisions 109 to 112).

export const SnapshotKinds = [
  "daily",
  "pre-migration",
  "pre-taxonomy",
  "pre-rescore",
  "pre-deletion",
  "pre-restore",
  "manual"
] as const
export const SnapshotKind = Schema.Literals(SnapshotKinds)
export type SnapshotKind = typeof SnapshotKind.Type

export const SnapshotId = Schema.String.pipe(Schema.brand("SnapshotId"))
export type SnapshotId = typeof SnapshotId.Type

export class SnapshotView extends Schema.Class<SnapshotView>("gmat-prep/api/SnapshotView")({
  id: SnapshotId,
  kind: SnapshotKind,
  takenAt: Schema.Number,
  // In bytes.
  size: Schema.NullOr(Schema.Number),
  // Found in the snapshots folder rather than taken by the app, which never
  // deletes it.
  found: Schema.Boolean
}) {}

// A snapshot that could not be taken, shown until a later one succeeds, or a
// file in the snapshots folder that is not a snapshot the app can use, shown
// while it is there.
export class SnapshotFailureView extends Schema.Class<SnapshotFailureView>("gmat-prep/api/SnapshotFailureView")({
  kind: SnapshotKind,
  at: Schema.Number,
  error: Schema.String
}) {}

// The last full integrity check: no damage, damage with what SQLite found,
// or a check that could not run, with why, which is tried again within the
// hour.
export class IntegrityView extends Schema.Class<IntegrityView>("gmat-prep/api/IntegrityView")({
  at: Schema.Number,
  outcome: Schema.Literals(["ok", "damaged", "not-run"]),
  detail: Schema.String,
  // Whether it ran right after a restore. Damage found then is in the file
  // itself, which a restore cannot repair.
  afterRestore: Schema.Boolean
}) {}

export class SnapshotsView extends Schema.Class<SnapshotsView>("gmat-prep/api/SnapshotsView")({
  // The snapshots kept, latest first.
  snapshots: Schema.Array(SnapshotView),
  failures: Schema.Array(SnapshotFailureView),
  integrity: Schema.NullOr(IntegrityView)
}) {}

export class SnapshotFailed extends Schema.TaggedError<SnapshotFailed>()(
  "SnapshotFailed",
  { detail: Schema.String, diskFull: Schema.Boolean },
  { httpApiStatus: 503 }
) {}

export class SnapshotNotFound extends Schema.TaggedError<SnapshotNotFound>()(
  "SnapshotNotFound",
  {},
  { httpApiStatus: 404 }
) {}

// Restore waits while something is under way that it would cut short: a job
// running or waiting to run, or a Learner's Mock, Sectional or timed set,
// paused or not, named with the Learner's Profile.
export class RestoreBlocked extends Schema.TaggedError<RestoreBlocked>()(
  "RestoreBlocked",
  {
    reason: Schema.Literals(["job-running", "session-running"]),
    learner: Schema.NullOr(Schema.String),
    session: Schema.NullOr(Schema.Literals(["mock", "sectional", "timed-set"])),
    paused: Schema.Boolean
  },
  { httpApiStatus: 409 }
) {}

// The snapshot's file is not one this app can restore: changed since it was
// taken, damaged, written by a newer version, or not this app's database.
export class SnapshotUnusable extends Schema.TaggedError<SnapshotUnusable>()(
  "SnapshotUnusable",
  { reason: Schema.Literals(["changed", "damaged", "newer", "foreign"]), detail: Schema.String },
  { httpApiStatus: 422 }
) {}

export class RestoreDone extends Schema.Class<RestoreDone>("gmat-prep/api/RestoreDone")({
  // The snapshot restored, and the one keeping the database it replaced.
  restored: SnapshotView,
  replaced: SnapshotView
}) {}

export class SnapshotsApi extends HttpApiGroup.make("snapshots")
  .add(
    HttpApiEndpoint.get("list", "/snapshots", { success: SnapshotsView }),
    HttpApiEndpoint.post("take", "/snapshots", { success: SnapshotsView, error: SnapshotFailed }),
    // A restore replaces every Learner's work since the snapshot, so the
    // Curator enters the passphrase again.
    HttpApiEndpoint.post("restore", "/snapshots/:id/restore", {
      params: { id: SnapshotId },
      payload: Schema.Struct({ passphrase: Schema.String }),
      success: RestoreDone,
      error: [
        SnapshotNotFound,
        RestoreBlocked,
        SnapshotUnusable,
        SnapshotFailed,
        WrongPassphrase,
        CuratorLocked,
        PassphraseNotSet
      ]
    })
  )
  .middleware(CuratorSession)
  .prefix("/api/curator")
{}
