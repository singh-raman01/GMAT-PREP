import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSecurity } from "effect/http-api"
import { CuratorSession } from "./Curator.ts"

// LAN mode, pairing codes and paired devices (docs/design.md, "Profiles,
// access and LAN mode", decisions 119 to 125).

// A paired device's token, in an HttpOnly, SameSite=Strict cookie.
export const DeviceCookie = HttpApiSecurity.apiKey({ key: "gp_device", in: "cookie" })

// The header on a refusal that says why, so the app can ask for pairing.
export const RefusedHeader = "x-gp-refused"

export const PairingCodeLength = 6
export const PairingCode = Schema.String.check(Schema.isPattern(/^\d{6}$/))

export const MaxDeviceName = 40
export const DeviceName = Schema.String.check(
  Schema.makeFilter((name: string) => name.trim().length >= 1 && name.trim().length <= MaxDeviceName, {
    description: `a name of 1 to ${MaxDeviceName} characters`
  })
)

export const DeviceId = Schema.String.pipe(Schema.brand("DeviceId"))
export type DeviceId = typeof DeviceId.Type

// What a page needs to know before anything else: whether it runs on this
// computer, whether LAN mode is on, and, on another device, whether it is
// paired.
export class PairingStatus extends Schema.Class<PairingStatus>("gmat-prep/api/PairingStatus")({
  fromHost: Schema.Boolean,
  lan: Schema.Boolean,
  // This device's name, when it is a paired device.
  device: Schema.NullOr(Schema.String)
}) {}

export class PairedDevice extends Schema.Class<PairedDevice>("gmat-prep/api/PairedDevice")({
  name: Schema.String
}) {}

// A wrong code, or one that has expired or was used. Five wrong codes in a
// row end the code shown; attemptsLeft 0 says no code is waiting now.
export class PairingCodeWrong extends Schema.TaggedError<PairingCodeWrong>()(
  "PairingCodeWrong",
  { attemptsLeft: Schema.Int },
  { httpApiStatus: 401 }
) {}

// This computer itself needs no pairing.
export class PairingNotNeeded extends Schema.TaggedError<PairingNotNeeded>()(
  "PairingNotNeeded",
  {},
  { httpApiStatus: 409 }
) {}

export class PairingApi extends HttpApiGroup.make("pairing")
  .add(
    HttpApiEndpoint.get("status", "/pairing", { success: PairingStatus }),
    HttpApiEndpoint.post("pair", "/pairing/pair", {
      payload: Schema.Struct({ code: PairingCode, name: DeviceName }),
      success: PairedDevice,
      error: [PairingCodeWrong, PairingNotNeeded]
    })
  )
  .prefix("/api")
{}

export class DeviceView extends Schema.Class<DeviceView>("gmat-prep/api/DeviceView")({
  id: DeviceId,
  name: Schema.String,
  pairedAt: Schema.Number,
  lastSeenAt: Schema.Number,
  revokedAt: Schema.NullOr(Schema.Number)
}) {}

// An address the app could not listen on, and why.
export class LanProblemView extends Schema.Class<LanProblemView>("gmat-prep/api/LanProblemView")({
  address: Schema.String,
  detail: Schema.String
}) {}

export class LanView extends Schema.Class<LanView>("gmat-prep/api/LanView")({
  on: Schema.Boolean,
  // Where other devices open the app, while it listens on the network.
  urls: Schema.Array(Schema.String),
  problems: Schema.Array(LanProblemView),
  // Until when the pairing code shown last works, while it is unused.
  codeUntil: Schema.NullOr(Schema.Number),
  // Paired devices, revoked ones last.
  devices: Schema.Array(DeviceView)
}) {}

export class NewPairingCode extends Schema.Class<NewPairingCode>("gmat-prep/api/NewPairingCode")({
  code: Schema.String,
  expiresAt: Schema.Number
}) {}

export class HostOnly extends Schema.TaggedError<HostOnly>()(
  "HostOnly",
  {},
  { httpApiStatus: 403 }
) {}

export class LanModeOff extends Schema.TaggedError<LanModeOff>()(
  "LanModeOff",
  {},
  { httpApiStatus: 409 }
) {}

export class DeviceNotFound extends Schema.TaggedError<DeviceNotFound>()(
  "DeviceNotFound",
  {},
  { httpApiStatus: 404 }
) {}

// Only on this computer, with the Curator unlocked.
export class CuratorLanApi extends HttpApiGroup.make("curatorLan")
  .add(
    HttpApiEndpoint.get("view", "/lan", { success: LanView, error: HostOnly }),
    HttpApiEndpoint.put("setMode", "/lan", {
      payload: Schema.Struct({ on: Schema.Boolean }),
      success: LanView,
      error: HostOnly
    }),
    HttpApiEndpoint.post("makeCode", "/lan/code", { success: NewPairingCode, error: [HostOnly, LanModeOff] }),
    HttpApiEndpoint.post("revoke", "/lan/devices/:id/revoke", {
      params: { id: DeviceId },
      success: LanView,
      error: [HostOnly, DeviceNotFound]
    })
  )
  .middleware(CuratorSession)
  .prefix("/api/curator")
{}
