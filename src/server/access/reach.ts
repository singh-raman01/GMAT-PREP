// Who may reach the server (docs/design.md, "Profiles, access and LAN mode",
// decisions 119 to 125): this computer always; in LAN mode, devices on the
// local network once paired. A pure decision over a request's facts, so the
// rules are tested without a network.

export interface RequestFacts {
  readonly method: string
  // The request target's path and query, as sent.
  readonly url: string
  // The Host header's name, without the port, in lower case.
  readonly host: string | undefined
  // The address the request came from, when the server knows it.
  readonly remote: string | undefined
  // Whether it carries the cookie of a paired device not revoked.
  readonly paired: boolean
}

export interface Reach {
  // Whether LAN mode is on now.
  readonly lan: boolean
  // This computer's own addresses: loopback and each interface's.
  readonly ownAddresses: ReadonlySet<string>
  // The names a Host header may give: this computer's loopback names, and in
  // LAN mode its network addresses and host names.
  readonly ownNames: ReadonlySet<string>
}

export type Refusal = "other-name" | "lan-off" | "host-only" | "not-paired"

export type Verdict =
  | { readonly _tag: "allow"; readonly fromHost: boolean }
  | { readonly _tag: "refuse"; readonly reason: Refusal }

export const LoopbackNames: ReadonlyArray<string> = ["127.0.0.1", "localhost", "[::1]"]

// The pairing endpoints, which a device must reach before it is paired.
export const PairingPaths: ReadonlyArray<string> = ["/api/pairing", "/api/pairing/pair"]

// What only this computer may do, even from a paired device: LAN mode itself,
// pairing codes and the paired devices.
export const HostOnlyPrefix = "/api/curator/lan"

// The host name in a Host header, without the port.
export const hostName = (header: string | undefined): string | undefined => {
  if (header === undefined) return undefined
  const value = header.trim().toLowerCase()
  if (value.startsWith("[")) {
    const end = value.indexOf("]")
    return end === -1 ? undefined : value.slice(0, end + 1)
  }
  const colon = value.indexOf(":")
  return colon === -1 ? value : value.slice(0, colon)
}

// An address of this computer itself, IPv4 written inside IPv6 included.
export const isOwnAddress = (remote: string | undefined, own: ReadonlySet<string>) => {
  if (remote === undefined) return false
  const plain = remote.toLowerCase().replace(/^::ffff:/, "")
  return plain === "::1" || plain.startsWith("127.") || own.has(plain)
}

// The path as the router matches it: up to the first ?, ; or #, decoded
// (an encoded % stays encoded), duplicate slashes as one, in lower case,
// without a trailing slash. Undefined when it does not decode.
export const routePath = (url: string): string | undefined => {
  const raw = url.split(/[?;#]/, 1)[0] ?? ""
  let path: string
  try {
    path = decodeURI(raw.replace(/%25/g, "%2525"))
  } catch {
    return undefined
  }
  path = path.replace(/\/{2,}/g, "/").toLowerCase()
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path
}

// A path that reads the same to the router as it is written: plain
// characters only, so no decoding, folding of slashes or cutting at ; can
// make it name another route.
const PlainPath = /^\/(?:[A-Za-z0-9\-._~]+\/?)*$/

const isApiPath = (lowered: string) => lowered === "/api" || lowered.startsWith("/api/")

// What a device that is not paired may still ask for: the app's pages and
// files, which hold no one's data, and pairing itself. Judged on the path as
// written, and only plain paths, so nothing reaches an API route by an
// encoding the router undoes.
export const openToUnpaired = (method: string, url: string) => {
  const raw = url.split("?", 1)[0] ?? ""
  if (!PlainPath.test(raw) || /(^|\/)\.\.?(\/|$)/.test(raw)) return false
  const lowered = raw.toLowerCase()
  if (PairingPaths.includes(lowered)) return method === "GET" || method === "POST"
  return (method === "GET" || method === "HEAD") && !isApiPath(lowered)
}

export const isHostOnly = (url: string) => {
  const path = routePath(url)
  // A path that does not decode reaches no route, but is treated as one
  // that might.
  return path === undefined || path === HostOnlyPrefix || path.startsWith(`${HostOnlyPrefix}/`)
}

export const judge = (facts: RequestFacts, reach: Reach): Verdict => {
  if (facts.host === undefined || !reach.ownNames.has(facts.host)) return { _tag: "refuse", reason: "other-name" }
  // A request whose address is not known is this computer's only while
  // nothing listens on the network.
  const fromHost = facts.remote === undefined ? !reach.lan : isOwnAddress(facts.remote, reach.ownAddresses)
  if (fromHost) return { _tag: "allow", fromHost }
  // Another device: only in LAN mode, as a listener closing may still be
  // finishing its requests.
  if (!reach.lan) return { _tag: "refuse", reason: "lan-off" }
  if (isHostOnly(facts.url)) return { _tag: "refuse", reason: "host-only" }
  if (facts.paired || openToUnpaired(facts.method, facts.url)) return { _tag: "allow", fromHost }
  return { _tag: "refuse", reason: "not-paired" }
}

export const RefusalTexts: Readonly<Record<Refusal, (lan: boolean) => string>> = {
  "other-name": (lan) =>
    lan
      ? "GMAT prep answers only to this computer's own names and addresses."
      : "GMAT prep answers only to this computer. Open it at http://127.0.0.1 or http://localhost.",
  "lan-off": () => "GMAT prep is not open to other devices now. Turn on LAN mode on the computer it runs on.",
  "host-only": () => "Do this on the computer GMAT prep runs on.",
  "not-paired": () => "Pair this device first, with a code shown on the computer GMAT prep runs on."
}

export interface NetworkAddress {
  readonly address: string
  readonly family: "IPv4" | "IPv6"
  readonly internal: boolean
}

// The addresses other devices reach this computer on: IPv4, not loopback.
export const lanAddressesOf = (addresses: ReadonlyArray<NetworkAddress>): ReadonlyArray<string> =>
  [...new Set(addresses.filter((entry) => entry.family === "IPv4" && !entry.internal).map((entry) => entry.address))]
    .sort()

// This computer's addresses and names, from its interfaces and host name.
export const reachOf = (lan: boolean, addresses: ReadonlyArray<NetworkAddress>, hostname: string): Reach => {
  const ownAddresses = new Set(addresses.map((entry) => entry.address.toLowerCase()))
  const ownNames = new Set(LoopbackNames)
  if (lan) {
    for (const address of ownAddresses) ownNames.add(address.includes(":") ? `[${address}]` : address)
    const name = hostname.trim().toLowerCase()
    if (name !== "") {
      ownNames.add(name)
      ownNames.add(name.endsWith(".local") ? name : `${name}.local`)
    }
  }
  return { lan, ownAddresses, ownNames }
}
