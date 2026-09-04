# Polyth Link relay operations

The `polyth-link-relay` binary is an **experimental** packaging wrapper around
upstream `iroh-relay = 1.1.0`. It is not a production TLS/443 product and it
does not reconnect paired devices.

Default listen address is `127.0.0.1:3340`. `metrics_bind` is rejected until
it is implemented. Do not run this as a custom WebSocket application relay.

## What the relay sees

Endpoint identifiers, timing, packet sizes, and connection duration. It
cannot read pairing secrets, HTTP bodies, grants, or session text.

## Current product scope

Polyth Link pairing in this build is **direct-preferred** only. Relay-only
and air-gapped are protocol values in the core library; they are not product
controls, and pairing creation rejects them.

`relayConfigured` / `relayUrls` on host status are taken from the running
Iroh endpoint when bound. They are not hard-coded diagnostics.

## Experimental local run

- Bind `127.0.0.1:3340` (override with `POLYTH_LINK_RELAY_BIND` or a JSON
  `{ "http_bind": "127.0.0.1:3340" }` file)
- No production certificate/key handling
- Health is process liveness of this experimental binary
- Pin client, host, and relay to Iroh 1.1.0 if you experiment with relays
