import { describe, expect, test } from "bun:test"
import {
  isOwnAddress,
  judge,
  lanAddressesOf,
  openToUnpaired,
  type Reach,
  reachOf,
  type RequestFacts,
  routePath
} from "../src/server/access/reach.ts"

// Who may reach the server, on this computer and in LAN mode (decisions 119
// to 125).

const interfaces = [
  { address: "127.0.0.1", family: "IPv4", internal: true },
  { address: "::1", family: "IPv6", internal: true },
  { address: "192.168.1.20", family: "IPv4", internal: false },
  { address: "fe80::1c2b:3aff:fe4d:5e6f", family: "IPv6", internal: false }
] as const
const offline: Reach = reachOf(false, interfaces, "Study-PC")
const lan: Reach = reachOf(true, interfaces, "Study-PC")
const request = (facts: Partial<RequestFacts>): RequestFacts => ({
  method: "GET",
  url: "/api/session",
  host: "192.168.1.20",
  remote: "192.168.1.31",
  paired: false,
  ...facts
})

describe("Reaching the server", () => {
  test("with LAN mode off, only this computer's own names are answered, and only from this computer", () => {
    expect(judge(request({ host: "127.0.0.1", remote: "127.0.0.1" }), offline)).toEqual({ _tag: "allow", fromHost: true })
    expect(judge(request({ host: "localhost", remote: undefined }), offline)).toEqual({ _tag: "allow", fromHost: true })
    expect(judge(request({ host: "evil.example" }), offline)).toEqual({ _tag: "refuse", reason: "other-name" })
    expect(judge(request({ host: "192.168.1.20" }), offline)).toEqual({ _tag: "refuse", reason: "other-name" })
    expect(judge(request({ host: undefined }), offline)).toEqual({ _tag: "refuse", reason: "other-name" })
    // A listener still closing when LAN mode went off.
    expect(judge(request({ host: "127.0.0.1", paired: true }), offline)).toEqual({ _tag: "refuse", reason: "lan-off" })
  })

  test("in LAN mode a device must name this computer, as a page using another name could be rebinding it", () => {
    expect(judge(request({ host: "evil.example", paired: true }), lan)._tag).toBe("refuse")
    expect(judge(request({ host: "study-pc.local", paired: true }), lan)._tag).toBe("allow")
    expect(judge(request({ host: "study-pc", paired: true }), lan)._tag).toBe("allow")
    expect(judge(request({ host: "[fe80::1c2b:3aff:fe4d:5e6f]", paired: true }), lan)._tag).toBe("allow")
  })

  test("in LAN mode an unpaired device gets the app's pages and pairing, and nothing else", () => {
    expect(judge(request({ url: "/" }), lan)).toEqual({ _tag: "allow", fromHost: false })
    expect(judge(request({ url: "/assets/index-B7xQ2.js" }), lan)._tag).toBe("allow")
    expect(judge(request({ url: "/practice/1f0c?from=plan" }), lan)._tag).toBe("allow")
    expect(judge(request({ url: "/api/pairing" }), lan)._tag).toBe("allow")
    expect(judge(request({ method: "POST", url: "/api/pairing/pair" }), lan)._tag).toBe("allow")
    expect(judge(request({ url: "/api/profiles" }), lan)).toEqual({ _tag: "refuse", reason: "not-paired" })
    expect(judge(request({ url: "/api" }), lan)._tag).toBe("refuse")
    expect(judge(request({ method: "POST", url: "/" }), lan)._tag).toBe("refuse")
  })

  test("no spelling of an API path that the router undoes gets past pairing", () => {
    const spellings = [
      "/API/profiles",
      "//api/profiles",
      "/api//profiles",
      "/%61pi/profiles",
      "/%2561pi/profiles",
      "/api/profiles;x",
      "/api;/profiles",
      "/api%2Fprofiles",
      "/assets/../api/profiles",
      "/./api/profiles",
      "/api/profiles/",
      "/Api/Pairing/../profiles",
      "/api/pairing%2F..%2Fprofiles"
    ]
    for (const url of spellings) {
      expect([url, judge(request({ url }), lan)._tag]).toEqual([url, "refuse"])
    }
    expect(openToUnpaired("GET", "/API/PAIRING")).toBe(true)
    expect(openToUnpaired("DELETE", "/api/pairing")).toBe(false)
  })

  test("a paired device reaches everything but what only this computer may do, however it is spelt", () => {
    expect(judge(request({ url: "/api/profiles", paired: true }), lan)).toEqual({ _tag: "allow", fromHost: false })
    expect(judge(request({ url: "/api/curator/books", paired: true }), lan)._tag).toBe("allow")
    expect(judge(request({ url: "/api/curator/lands", paired: true }), lan)._tag).toBe("allow")
    for (const url of ["/api/curator/lan", "/api/curator/lan/code", "/API/Curator/LAN/code", "//api/curator/%6Can/code", "/api/curator/lan;x", "/api/curator/lan/", "/api/%E0%A4%A"]) {
      expect([url, judge(request({ method: "POST", url, paired: true }), lan)]).toEqual([url, { _tag: "refuse", reason: "host-only" }])
    }
  })

  test("this computer is known by its own addresses, IPv4 within IPv6 too", () => {
    expect(judge(request({ remote: "::ffff:127.0.0.1", url: "/api/curator/lan/code", method: "POST" }), lan)).toEqual({
      _tag: "allow",
      fromHost: true
    })
    expect(judge(request({ remote: "192.168.1.20", url: "/api/curator/lan" }), lan)).toEqual({ _tag: "allow", fromHost: true })
    expect(judge(request({ remote: undefined }), lan)).toEqual({ _tag: "refuse", reason: "not-paired" })
    const own = lan.ownAddresses
    expect(isOwnAddress("192.168.1.20", own)).toBe(true)
    expect(isOwnAddress("::FFFF:192.168.1.20", own)).toBe(true)
    expect(isOwnAddress("127.0.0.53", own)).toBe(true)
    expect(isOwnAddress("192.168.1.31", own)).toBe(false)
    expect(isOwnAddress(undefined, own)).toBe(false)
  })

  test("paths read as the router reads them", () => {
    expect(routePath("/")).toBe("/")
    expect(routePath("/API//Curator/%6Can/?x=1")).toBe("/api/curator/lan")
    expect(routePath("/api/a;b")).toBe("/api/a")
    expect(routePath("/%2561")).toBe("/%2561")
    expect(routePath("/%E0%A4%A")).toBeUndefined()
  })

  test("other devices reach this computer on its IPv4 addresses that are not loopback", () => {
    expect(lanAddressesOf(interfaces)).toEqual(["192.168.1.20"])
    expect(lan.ownNames.has("study-pc.local")).toBe(true)
    expect(offline.ownNames.has("study-pc.local")).toBe(false)
    expect(reachOf(true, interfaces, "air.local").ownNames.has("air.local.local")).toBe(false)
  })
})
