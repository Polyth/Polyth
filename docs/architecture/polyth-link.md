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
5. **Remote policy.** Paired devices without `device.full-access` are
   default-deny (see Route matrix). Packages declare
   `remoteAccess` manifests. Unknown routes are rejected before handlers.
   Of `/api/auth/*`, a paired device reaches only `GET /api/auth/status`
   (core route, `core.health.read`); browser identity HTTP stays public-only.
6. **Compression.** HTTP is relayed byte-for-byte, so the request
   allowlist forwards `Accept-Encoding` and the server's gzip (JSON above
   1 KiB, static text) crosses the link; `Content-Encoding` was already on
   the response allowlist. WebSocket frames between client and host are
   raw-DEFLATE (`miniz_oxide`, level 1) per message when both peers agree: the
   client sets `WebSocketOpenV1.deflate`, a host that reads it answers the 101
   with `x-polyth-link-deflate: 1`, and messages of 1 KiB or more travel as
   `TextDeflate`/`BinaryDeflate` frames when that is smaller. Inflation is
   capped at the 8 MiB message ceiling and a deflated frame on a stream that
   did not negotiate it is a protocol error. Older peers neither send nor read
   the field, so a mixed pair keeps plain frames. The host's own leg to the
   server stays uncompressed (a local unix socket).
7. **Mobile proxy.** The Android/iOS native adapter runs the shared Rust Link
   client and loads the bundled web app through a one-time `bootstrapUrl` on
   a Rust-owned `127.0.0.1` listener. The browser receives only non-secret
   connection metadata and the loopback bootstrap URL. The app enters it
   cross-site from its bundled origin, and WebKit does not reliably store or
   send a `SameSite=Strict` cookie set on that response or on a
   redirect/refresh after it (401 "authentication required"). So `GET` of the
   bootstrap URL sets no cookie: it serves a CSP-hashed page whose same-origin
   `POST` to the same URL consumes the one-time nonce and sets the cookie, then
   replaces itself with the target. The page paints the launch veil (brand
   night, the 112 px mark from an embedded WebP; its style is hash-pinned and
   only `img-src data:` is added), so the swap from the Connection Hub to the
   shell never shows a white page (see "Launch and reveal" in
   `docs/mobile/platform-behavior.md`). Capacitor injects its bridge into the
   loopback page too, so `CapacitorHttp` fetch patching must stay disabled:
   it sends non-GET requests through native HTTP, whose cookie jar is not the
   WebView's, and the claimed cookie would never reach the shell. The cookie name carries the proxy port
   (`polyth_link_proxy_<port>`) because cookies are host-scoped, not
   port-scoped, so one proxy's bootstrap cannot overwrite another's session.
   The cookie gates only `/api`, `/ws`, `/__polyth/` and non-read methods
   (`requires_proxy_session`). GET/HEAD of the public static shell is served
   without it. If the shell's `/api/auth/status` still gets 401 on a loopback
   origin, it returns to the connection hub (at most once a minute, then the
   error screen) for a fresh bootstrap. Device identity stays
   native: iOS stores it in Keychain; Android stores an encrypted identity blob
   protected by an Android Keystore key. The privileged Capacitor plugin is
    callable only from the bundled app origin, not from the loopback page. The
    one exception, `presentServerMenu`, is accepted from the loopback page of
    the proxy the app opened: the native side draws the server list itself and
    returns only the kind of choice, so connection metadata still never reaches
    loopback JavaScript (`docs/mobile/polyth-link.md`).
8. **Local numeric pairing.** Nearby discovery supplies only a pinned bootstrap
   hint. The six-digit code is authenticated with OPAQUE using the fixed
   `argon2id-v1-m65536-t3-p1` profile, a 120-second lifetime, and bounded
   per-device, endpoint, and host attempts; it never becomes persistent trust.
9. **Interrupted pairing recovery.** A durable `prepared` record is never an
   active connection. Only the explicit native recovery operation may probe the
   pinned host. It promotes an accepted device, or removes the matching native
   identity and metadata only after an exact authoritative orphan rejection.

## Packages

- `@polyth/tunnel` — product package (Polyth Link UI, device store, host process).
- `@polyth/pairing-qr` — encode/decode/preview only.
- `crates/polyth-link-core` — protocol owner and shared transport/proxy primitives.
- `crates/polyth-link-host` — Node/desktop host process owned by exactly one
  Polyth parent. It forwards each proxied HTTP request to the server's ingress
  socket with `Connection: close` and `Content-Length`, and keeps its write
  half open until the answer is in: Node's HTTP server (`httpAllowHalfOpen`
  false) ends a half-closed request socket, so a host that shut its write half
  after the request lost every answer not written in the same tick — any
  endpoint awaiting I/O reached the phone as "Load failed" (fixed 2026-10-12;
  `tests/pair_and_http.rs` answers like Node). The server's response head may
  take up to `response_head_timeout_ms` (120 s); only a browser's request head
  keeps the 10 s `header_read_timeout_ms`. On Linux it arms `PR_SET_PDEATHSIG` before binding the control
  socket, so a hard-killed owner cannot leave an orphan holding a socket path
  that a later host unlinks and replaces. Normal shutdown still closes the
  child explicitly.
- `crates/polyth-link-client` — shared client state machine for pairing,
  reconnect, revocation handling and the authenticated loopback proxy.
  A live session outlives its QUIC connection: when the control stream ends
  without revocation (phone suspended past the idle timeout, network
  hand-off, host restart or `Shutdown`), the client keeps the loopback
  listener, port, bootstrap cookie and origin, and re-opens a trusted
  connection on the session's existing endpoint (immediately, then 0.25 s →
  10 s backoff; `network_change()` before each attempt). Proxied `/api` and
  `/ws` requests park up to 15 s for the new link instead of failing; requests
  already in flight on the dead link fail as before (a mutation stays
  outcome-unknown). Only an authoritative host answer — revoked, unknown
  device, identity or version mismatch — or `disconnect`/`forget` ends the
  session. A listener whose accept loop dies is rebound on the same port;
  if that fails the session reports `disconnected` so the native shell
  reconnects with a new origin. `status` stays `connected` (with
  `reconnecting: true` and no `transport`) while the link is re-established,
  and also nudges `network_change()` because the shells call it on foreground.
  The same foreground `status` asks the control loop to send a control `Ping`;
  without the matching `Pong` within 5 s the link is treated as lost and
  replaced. After a suspension the old connection still looks open (QUIC
  measures its idle timeout in awake time), so without this probe requests and
  the page's WebSocket hung on it for tens of seconds.
  `status` and `connect` first prove the origin is served: a loopback probe
  must be *accepted by this proxy's accept loop* (a reclaimed iOS listener
  can fail silently, and a bare TCP connect could reach another local
  listener on the same port). On failure the loop drops its socket and
  rebinds the same port; if the probe still fails within 2.5 s the listener
  is closed, `status` reports `disconnected` and `connect` replaces the
  session instead of returning the dead origin's bootstrap.
- `apps/mobile` Connection Hub — WKWebView drops a failed navigation to the
  loopback origin without any page event, so the hub arms an 8 s watchdog
  after each launch; if the page is still there the connection stops
  reading "Connected" and the next attempt `disconnect`s it first so a new
  proxy is started. When the open server's page itself bounces to the hub
  because its local proxy stopped answering (`init.ts` proxy probe, the
  `bootstrap.tsx` session bounce) it passes `?resume=1`: the hub re-opens
  the server that is still connected natively at the same path without a
  tap, at most once per 60 s. Other carried paths (OS deep links) still wait
  for an explicit choice.
- `crates/polyth-link-uniffi` — stable native C ABI over the shared client.
  It contains no second pairing or transport implementation.

## Host readiness and recovery

The tunnel package supervises its own Link host. A lost control connection,
child exit, or unanswered control RPC makes the host unavailable. Health checks
run every five seconds; failed recovery uses backoff capped at thirty seconds.
Concurrent invitation requests share one recovery attempt. A replacement starts
only after the previous owned child has a confirmed exit; an unconfirmed release
keeps pairing unavailable.

Recovery clears old connection identities and closes their paired sockets, then
creates fresh ingress, synchronizes durable device grants, and binds the endpoint.
Invitation creation waits for those steps. It does not replay an RPC interrupted
by host failure. Memory-only invitations from the previous host must be created
again. Host readiness changes are published as `tunnel/host-status-changed` so the
Link settings page can refresh its controls. Missing host binaries still require
the operator's Link build or packaged installation; recovery does not install or
build software.

Current native hosts return bit-packed QR modules within the normal 64 KiB
control-frame limit. For installed older hosts, the Node client accepts a larger
response only when it matches a pending `pairing.create` and contains a square
boolean QR matrix of at most 200 modules per side. Its frame and incomplete
buffer remain bounded by 64 KiB plus six bytes per possible module. Other RPCs,
events, malformed matrices and outgoing requests retain the normal limit.

## Canonical API

Remote clients use the same `/api/*` and `/ws` (plus declared `/ws/<package>`)
surface as the local web UI. Tunnel-only routes are pairing, devices,
diagnostics, and transport status. There is no `/mobile-api`.

Static mobile assets are served by the local proxy, not tunneled from the host.
`apps/web/dist` is only the shell: per-package web bundles live in
`packages/<id>/dist/web` and are served by the host, and only `/api` and `/ws`
reach the host. Package code imports the shell's `/shell-api/*` modules, so a
package must be the same build as the bundled shell. The mobile `sync`/`copy`
scripts therefore run `apps/mobile/scripts/bundle-package-assets.mjs` after
Capacitor copies the web dir: it copies every package in the bundled
`packages-manifest.json` (entry, stylesheets, chunks) into the generated, gitignored
`ios/App/App/public/packages/<id>/` and `android/.../assets/public/packages/<id>/`,
and fails the build if a manifest-listed file is missing. On the loopback origin
`webEntries.ts` keeps the bundled URLs for those packages and loads only
host-only packages (installed later, or newer) through the authenticated,
read-only mirror `GET /api/package-assets/manifest` and
`/api/package-assets/<id>/<file>` (`httpCore.ts`; rules under `core.sessions.read`
in `CORE_REMOTE_ACCESS`). A host without the mirror still gets the bundled
catalog. Without any of this every package entry 404ed and the app showed only
shell-owned widgets. Host-only packages can still skew against the bundled shell.

## Route matrix (paired-device)

A device the owner trusts like this computer holds `device.full-access`
(`principalHasFullAccess`): it skips the route table, holds every capability,
counts as a local UI principal and may administer Link. New pairings default to
the `full-remote` profile, which carries it. The owner narrows a device by
replacing its grants; identity, revoke and live grant updates are unchanged,
and a guarded account's ceiling still binds its devices.

Without full access, remote access is default-deny. Core HTTP that is
remote-safe is listed in `CORE_REMOTE_ACCESS`. Packages without `remoteAccess`
are local-only. Privileged capabilities (full access, pairing, grants, identity
rotate, password, package install, secure-safe export, shutdown) are never
grantable to guarded accounts or CLI tokens; the owner may grant them to a
paired device. Link ingress still answers only `GET /api/auth/status` from the
`/api/auth/*` tree — browser identity stays public-HTTP-only.

See `packages/server/src/remotePolicy.ts` and each package `serverEntry`.

## Owner UX

The desktop Link page (`packages/tunnel/widgets`) shows the device list and
host status only. Pair phone creates the invitation immediately (QR, numeric
code when the host issues one, safety words). An optional "Access"
disclosure picks a narrower preset, which reissues the invitation. Each device's
Permissions disclosure holds the Full access switch; switching it off keeps the
device's other grants and reveals presets plus per-capability toggles
(`widgets/permissions.ts` names every capability, pinned by test). Fingerprint,
diagnostics and identity reset live under Advanced. The phone connection screen
has one primary action (Scan QR code, or tapping a known computer). Nearby/code
pairing are quiet links, network failures render on the affected server card,
and manual/insecure URLs stay under Advanced. Phones cannot edit grants.
