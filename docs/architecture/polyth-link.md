# Polyth Link architecture

Polyth Link is application-layer remote access to the canonical Polyth
HTTP and WebSocket surface. It is not a VPN, SOCKS proxy, port forwarder,
or unauthenticated share link.

## Trust boundaries

1. **Iroh transport.** Peers authenticate with EndpointIds. Direct QUIC is
   preferred; encrypted relay is fallback. Path changes do not change the
   logical host.
2. **Pairing.** A 120-second memory-only invitation carries a 256-bit
   secret. The secret is never sent raw; the client proves knowledge with
   HMAC-SHA-256 bound to the handshake transcript after the Iroh
   connection exists.
3. **Device grants.** Persistent trust is SQLite in
   `<dataDir>/tunnel/tunnel.db`. Revoke is targeted per `deviceId` and awaited
   through host RPC; a host failure returns HTTP 503 `state: "partial"`.
4. **Ingress.** Tunnel requests do not enter the public HTTP listener.
   They use a unix-domain internal listener plus a per-boot secret. Loopback
   is not an identity. `RequestIngress.kind = "polyth-link"` is built by
   the server, never by headers. Canonical `/ws`, terminal, and package WS
   channels attach to this ingress as well as the public listener.
5. **Remote policy.** Paired devices are default-deny. Packages declare
   `remoteAccess` manifests. Unknown routes are rejected before handlers.
6. **Mobile proxy.** When a native adapter exists, the WebView loads a
   one-time `bootstrapUrl` on loopback. `origin` is the bare loopback origin.
   Private keys never enter JavaScript. Production Android/iOS native pairing
   is not included yet.

## Packages

- `@polyth/tunnel` — product package (Polyth Link UI, device store, host process).
- `@polyth/pairing-qr` — encode/decode/preview only.
- `@polyth/tunnel-relay` — operations around upstream `iroh-relay = 1.1.0`.
- `crates/polyth-link-core` — protocol owner.
- `crates/polyth-link-host` — Node/desktop host process.
- `crates/polyth-link-uniffi` — ticket-parse FFI only, not a native pairing core.

## Canonical API

Remote clients use the same `/api/*` and `/ws` (plus declared `/ws/<package>`)
surface as the local web UI. Tunnel-only routes are pairing, devices,
diagnostics, and transport status. There is no `/mobile-api`.

Static mobile assets are served by the local proxy, not tunneled from the host.

## Route matrix (paired-device)

Remote access is default-deny. Core HTTP that is remote-safe is listed in
`CORE_REMOTE_ACCESS`. Packages without `remoteAccess` are local-only.
Privileged capabilities (pairing, grants, identity rotate, password,
package install, secure-safe export, shutdown) never ride in Full remote.

See `packages/server/src/remotePolicy.ts` and each package `serverEntry`.

