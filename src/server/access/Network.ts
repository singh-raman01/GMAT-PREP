import { Context, Layer, Option } from "effect"
import type { HttpServerRequest } from "effect/http"
import { hostname, networkInterfaces } from "node:os"
import type { NetworkAddress } from "./reach.ts"

// Facts about this computer's network, and where a request came from, read
// when asked: interfaces change while the app runs, as when a laptop joins
// another network. Tests stand in for all three.
export class Network extends Context.Service<Network, {
  readonly addresses: () => ReadonlyArray<NetworkAddress>
  readonly hostname: () => string
  readonly remoteOf: (request: HttpServerRequest.HttpServerRequest) => string | undefined
}>()("gmat-prep/server/access/Network") {
  static readonly live = Layer.succeed(
    Network,
    Network.of({
      addresses: () =>
        Object.values(networkInterfaces()).flatMap((entries) =>
          (entries ?? []).map((entry): NetworkAddress => ({
            address: entry.address,
            family: entry.family === "IPv6" ? "IPv6" : "IPv4",
            internal: entry.internal
          }))
        ),
      hostname: () => hostname(),
      remoteOf: (request) => Option.getOrUndefined(request.remoteAddress)
    })
  )
}
