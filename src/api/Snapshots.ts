import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { CuratorSession } from "./Curator.ts"

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
  size: Schema.NullOr(Schema.Number)
}) {}

// A snapshot that could not be taken: shown until one of its kind succeeds.
export class SnapshotFailureView extends Schema.Class<SnapshotFailureView>("gmat-prep/api/SnapshotFailureView")({
  kind: SnapshotKind,
  at: Schema.Number,
  error: Schema.String
}) {}

// The last full integrity check: "ok", or what SQLite found.
export class IntegrityView extends Schema.Class<IntegrityView>("gmat-prep/api/IntegrityView")({
  at: Schema.Number,
  ok: Schema.Boolean,
  detail: Schema.String
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

// Restore waits while something is under way that it would cut short.
export class RestoreBlocked extends Schema.TaggedError<RestoreBlocked>()(
  "RestoreBlocked",
  { reason: Schema.Literals(["job-running", "session-running"]) },
  { httpApiStatus: 409 }
) {}

// The snapshot's file is not one this app can restore: changed since it was
// taken, damaged, or written by a newer version.
export class SnapshotUnusable extends Schema.TaggedError<SnapshotUnusable>()(
  "SnapshotUnusable",
  { reason: Schema.Literals(["changed", "damaged", "newer"]), detail: Schema.String },
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
    HttpApiEndpoint.post("restore", "/snapshots/:id/restore", {
      params: { id: SnapshotId },
      success: RestoreDone,
      error: [SnapshotNotFound, RestoreBlocked, SnapshotUnusable, SnapshotFailed]
    })
  )
  .middleware(CuratorSession)
  .prefix("/api/curator")
{}
