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
   Removing a server account revokes and disconnects every device it paired
   (`SERVER_ACCOUNT_REMOVAL_BUS`, awaited before the credential goes; an
   unreachable host gets the revoke on its next trust sync). A phone keeps one
   identity per host, so a revoked device presents the same EndpointId when it
   pairs again: the host routes a `PairingHello` from an unknown *or revoked*
   peer to pairing, and holds only an active device to `ConnectionHello`.
   Paired under another account, it becomes that account's new device record
   (the old one is deleted); an active device of another account is still
   refused.
4. **Ingress.** Tunnel requests do not enter the public HTTP listener.
   They use a unix-domain internal listener plus a per-boot secret (on
   Windows a named pipe, see *Local IPC on Windows* below). Loopback
   is not an identity. `RequestIngress.kind = "polyth-link"` is built by
   the server, never by headers. Canonical `/ws`, terminal, and package WS
   channels attach to this ingress as well as the public listener.
5. **Remote policy.** Paired devices without `device.full-access` are
   default-deny (see Route matrix). Packages declare
   `remoteAccess` manifests. Unknown routes are rejected before handlers.
   Of `/api/auth/*`, a paired device reaches `GET /api/auth/status` (core
   route, `core.health.read`); a full-access device also reads its own
   account through `GET /api/auth/accounts`, `GET /api/auth/me` and
   `GET /api/auth/cli` (see Route matrix). All other browser identity HTTP
   stays public-only.
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
7. **Stream priorities.** The transport sends the pending stream with the
   highest priority value first (`PRI_*`, `polyth-link-core/src/protocol.rs`):
   control above API and WebSocket, file bodies (`/files`, `/attachment` paths)
   below everything, so a download cannot hold back API answers. A priority only
   orders what has not left the host yet; data already queued on a relay still
   goes first (numbers: [Phone: opening a chat that has photos](../agents/performance.md#phone-opening-a-chat-that-has-photos)).
8. **Mobile proxy.** The Android/iOS native adapter runs the shared Rust Link
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
    loopback JavaScript (`docs/mobile/polyth-link.md`). The server-zone methods
    are accepted from that same page and speak for its server alone; they give
    it the names of the other paired servers and of their projects only after
    the person allowed that server in a native prompt, and never a connection
    id (`docs/mobile/polyth-link.md#server-zones`).
9. **Local numeric pairing.** Nearby discovery supplies only a pinned bootstrap
   hint. The six-digit code is authenticated with OPAQUE using the fixed
   `argon2id-v1-m65536-t3-p1` profile, a 120-second lifetime, and bounded
   per-device, endpoint, and host attempts; it never becomes persistent trust.
10. **Interrupted pairing recovery.** A durable `prepared` record is never an
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
  that a later host unlinks and replaces. On Windows, which has no such
  signal, the owner spawns the host with a stdin pipe and the host exits when
  it closes. Normal shutdown still closes the child explicitly.
  - **Local IPC on Windows** (`src/local_ipc.rs`,
    `packages/tunnel/src/localIpc.ts`). The control channel and the server
    ingress are named pipes, `\\.\pipe\polyth-link-<random>-host` and
    `…-ingress`, with a fresh 128-bit name per server start instead of the
    0700 tunnel directory. The host creates the control pipe as the first
    instance (a process already holding the name makes startup fail rather
    than receive the owner's RPC), rejects remote clients and sets a DACL of
    SYSTEM + the pipe owner only. The ingress pipe is Node's own listener
    (libuv, first instance, default pipe DACL, which also gives Everyone
    read-only access; every request still needs the per-boot secret, which a
    read-only handle cannot send). The host opens it with
    `SECURITY_IDENTIFICATION`, so the server cannot impersonate it.
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
  session. A host closes a revoked device's connection right after saying so,
  and the close can outrun the message, so the close reason `revoked` counts as
  the same answer. A listener whose accept loop dies is rebound on the same port;
  if that fails the session reports `disconnected` so the native shell
  reconnects with a new origin. `status` stays `connected` (with
  `reconnecting: true` and no `transport`) while the link is re-established,
  and also nudges `network_change()` because the shells call it on foreground.
  The same foreground `status` asks the control loop to send a control `Ping`;
  without the matching `Pong` within 5 s the link is treated as lost and
  replaced. After a suspension the old connection still looks open (QUIC
  measures its idle timeout in awake time), so without this probe requests and
  the page's WebSocket hung on it for tens of seconds. Stream data arriving
  meanwhile re-arms the wait, for at most 30 s: a relay path queues the `Pong`
  behind everything already on its way to the phone, and replacing a link that
  is delivering would cut those very transfers. ACKs do not count, because a
  host whose application has stopped still sends them.
  The client does not wait out those 5 s on a silent link. If 1.5 s pass
  (`LIVENESS_HEDGE_AFTER`) with neither a `Pong` nor any stream data, it dials
  a spare connection next to the old one. A host keeps two connections per
  device, so the spare does not displace the old link. If the spare
  completes while the old link is still silent, the client moves to it at
  once. If a `Pong` or data arrives first, the client drops the spare. If the
  deadline passes first, the reconnect uses the spare instead of dialing again.
  A link that died during suspension is therefore back after about 1.5 s plus
  one handshake, not 5 s plus one handshake. A rejection the spare receives
  (for example, a revoked device) ends the session as usual.
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
- `polyth-link-client stdio <data dir>` — the desktop app's transport to the same
  client: JSON lines over stdin/stdout, on Windows too, with no socket on disk. End of
  stdin is the owner leaving and closes the sessions. `connect` takes an optional
  `preferredPort` so a page keeps its origin, falling back to a free port.
  `POLYTH_WEB_PACKAGES_DIR` serves package bundles from `<id>/dist/web` without a
  fallback to the shell, for builds that keep them apart. See
  [Polyth Desktop](../dev/desktop.md#connecting-to-another-polyth).

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
surface as the local web UI. Tunnel-only routes are pairing, devices, server name,
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
paired device. From the `/api/auth/*` tree, Link ingress answers
`GET /api/auth/status`, and for a full-access device (an unguarded account)
`handlePaired` in `@polyth/identity` (gated in `packages/server/src/http.ts`)
also answers that device's own `GET /api/auth/accounts`, `/me` and `/cli`, plus
`GET` of an account's `guardrails`, `limits` and `permissions`. An owner of a
credential-backed installation additionally creates and changes people:
`POST /api/auth/accounts` and `/accounts/:id/{profile,login,password,status,guardrails,limits,permissions}`.

That administration keeps one server-side identity session per device
(`packages/identity/src/pairedDevice.ts`); its token never leaves the server and
its row is left out of the browser's session list. The device grant is the
request credential (no cookie, so no CSRF/same-origin check applies), but every
change first needs the person's password via `POST /api/auth/reauthenticate`,
which elevates that session for five minutes exactly like a browser's recent
sign-in; without it the answer is `403 reauth-required`, which Settings → Users
turns into its password prompt. Elevation is per device and per process.

Everything else over Link stays refused: the device's own name, password,
passkeys, sessions and command-line tokens, terminal sign-in approval, provider
configuration and every other identity route need a browser identity session
(same origin, CSRF, owner re-authentication) and stay public-HTTP-only. Those
answers keep `readOnly: true` (and `canManageTrust: false`), so Settings → Users
shows the owner's own card as browser-only and Command line stays read-only. A
password-less `local` installation also keeps the read-only people list
(`canManage: false`), because a device has no credential to confirm.

A route that refuses paired devices itself must let a full-access device
through (`principalHasFullAccess`), as `/api/system/info` and
`/api/system/releases` (Settings → About) do; `principal.kind` alone does not
say what the device may do. Its data directory stays a generic label off
loopback.

See `packages/server/src/remotePolicy.ts` and each package `serverEntry`.

## Owner UX

The desktop Link page (`packages/tunnel/widgets`) shows the device list and
host status only. Pair device creates the invitation immediately (QR, numeric
code when the host issues one, a copyable pairing link for a computer, safety
words); an expired QR fades back so it never looks scannable until New code.
An optional "Access" disclosure picks a narrower preset (an even 2×2 control in
the dialog), which reissues the invitation. Each device's
Permissions disclosure holds the Full access switch; switching it off keeps the
device's other grants and reveals presets plus per-capability toggles
(`widgets/permissions.ts` names every capability, pinned by test). Fingerprint,
diagnostics and identity reset live under Advanced. The host card's **Name on
other devices** field sets the server name (see below). The phone connection screen
has one primary action (Scan QR code, or tapping a known computer). Nearby/code
pairing are quiet links, network failures render on the affected server card,
and manual/insecure URLs stay under Advanced. Phones cannot edit grants.

## Pairing for another person

A pairing belongs to the account that created it: the device it admits acts as
that account (`tunnel_pairing_owner`, `claimPairing`). The one exception is an
instance owner pairing a teammate's Polyth app, which is how a person without
a public address invites someone (`POST /api/tunnel/pairing` with
`forUserId`):

- Only the instance owner may name another account
  (`requireInstanceOwnerAuthority`), and only a member of the current Space
  (`tenancy.membership`). Anything else is refused before the Link host is
  asked.
- The device joins `forUserId`'s account. Its default is `full-remote`
  (decided 2026-11-26): full access on a device is bounded by the account
  it belongs to, so it reaches what that person reaches when signed in here
  and nothing of the owner's. Owner-only, admin and other people's private
  data stay behind that account's checks, and a guarded account's ceiling
  removes full access altogether (`principalHasFullAccess`). The narrower
  `developer` profile proved too tight for a teammate's own Polyth: people
  messages, mentions, model and harness lists were outside its route table.
- The pairing is still the owner's. The owner sees the safety words and
  approves; the teammate's account can neither read nor approve it.
- The device records its issuer (`tunnel_device.issued_by`).
  `GET /api/tunnel/devices/issued` lists the devices an owner paired for
  others, and the issuer may read, revoke and forget them but not change
  their grants, while it is still the instance owner. Removing the
  teammate's account revokes them like any of its devices, and a disabled
  account's device stops authenticating at once (`canonicalAuth`
  `accountExists`).
- Issuing is audited (`tunnel_audit` `pairing-issued-for-account` with
  issuer, account and profile, never the ticket).

On the Link page the instance owner's Pair device dialog has a **For** choice
(Me, or a member of the current Space: `widgets/people.ts`, from
`GET /api/auth/accounts` `canManage` and the active Space's members). For a
teammate it defaults to Full access (that person's own rights), names whom the device will act as, and
tells the owner to send the pairing link, which the teammate pastes into
Polyth Desktop's server list. The settings target
`{ sectionId: "pair-for", itemId: <accountId> }` opens the dialog with that
person chosen. Settings → Users → Add user links here. **Devices you connected
for others** lists the issued devices with Revoke, then Forget.

The ticket keeps the protocol's 2-minute lifetime (`pairing_ttl_ms`, enforced
by the clients too), so the owner and teammate pair together, for example on
a call. A one-time invitation instead carries an invitation ticket with a
lifetime of up to 7 days.

### One-time invitations

An invitation is a ticket marked `invitation: true` that the person can open
later, without the owner and teammate being online together. Its lifetime is
up to 7 days and it expires by wall clock.

- Issuing: `POST /api/tunnel/invitations` `{forUserId, name?, locale?, profile?, ttlMs?}`.
  `forUserId` must be another member of the current Space; the profile
  defaults to `full-remote` and the TTL to 7 days (1 hour … 7 days allowed).
  A new invitation cancels the issuer's earlier pending one for that person,
  and an older Link host answers `501 unsupported`. The answer carries
  `{id, forUserId, profile, url, link, expiresAt, qrModules}`.
- Listing and cancelling: `GET /api/tunnel/invitations` returns the caller's
  pending invitations and `joined` (`[{forUserId, at}]`, the newest used
  invitation per person, for Settings → Users), and `DELETE /api/tunnel/invitations/:id` cancels one,
  answering the same 404 for an unknown id, someone else's invitation and a
  no-longer-pending one. These routes are local/full-access only (not in
  `TUNNEL_REMOTE_ACCESS`); each requires `tunnelPairingManage` and instance
  owner authority.
- Storage: the `tunnel_invitation` table in `tunnel.db` keeps the pairing id,
  issuer, `for_user_id`, profile, ticket, share URL, label, created and
  expiry times, state (`pending|used|cancelled|expired`), device id, the
  issuing `space_id`, the name the person was added with (`for_name`) and the
  issuer's `locale`. The
  ticket is kept so the host can be given it back after a restart, which makes
  the link a bearer credential until it is used or expires. Audit rows and
  events carry only ids, never the ticket or URL.
- Commit: when a committing pairing belongs to an invitation, the device is
  stored in `forUserId`'s account with `issuedBy` the owner, the row becomes
  `used`, and `invitation-used` is audited and emitted as
  `tunnel/invitation-used` to the issuer. The issuer also gets a notice in the
  Space they invited from (`server.person-notices` `notify`: inbox row, live
  card and push, kind `message`, the person's monogram), written in the
  language the owner invited in (`locale`, one of the package catalogs; English
  otherwise) because the server knows no other;
  opening it shows the person in Settings → Users. Invitations made before
  `space_id` was kept send no notice. A cancelled, used or expired
  invitation stores nothing (`pairing.storage_failed`).
- Restart: after every trust sync Node sends its pending invitations to the
  Link host with `pairing.restore`; rejected entries become `expired` or
  `cancelled`. Identity rotation cancels all pending invitations.
- The Link page section **Invitations not opened yet** lists the owner's
  pending invitations with Copy link and Cancel.

## Joined Spaces

A person here can join a Space on another Polyth server; this server is then
that person's Link client (`packages/tunnel/src/joined*.ts`, driving one
`polyth-link-client stdio` process per person; `POLYTH_LINK_CLIENT` overrides
the binary, then a packaged copy, then the newer of the `target/release` and
`target/debug` builds, so a stale release build from before `stdio` existed
cannot shadow a fresh `npm run build:link`). A client that ends before its
first answer is reported as `link-client-start-failed` ("could not start … may
be older than this Polyth"), not as the other server being unreachable. The
package decides nothing about routing: the host picks the
requests that follow a joined Space and calls `server.joined-spaces`.

- **Which requests go there** (`packages/server/src/joinedSpaceRouting.ts`).
  Sign-in, personal preferences, the Space list, the package bundle
  (`/api/packages`, `/api/package-assets`, `/api/plugins`: the page runs this
  server's code, never the other server's), Link, the CLI, system and health
  stay here in the person's own Space. This computer's secrets and its
  connections to other machines (`/api/secure-safe`, `/api/credential-vault`,
  `/api/ssh`, `/api/providers/custom`, `/api/mcp`) answer 404
  `not-available`. Every other `/api` path and `/ws` goes to the other
  server, which decides what the device may do (a teammate's device has full
  access, bounded by that person's rights there). An explicit
  `x-polyth-space` decides alone; a stale joined cookie falls back to the
  person's own Space. Client caches that hold this server's personal data
  must not migrate into a joined Space (the Git profile cache reads the
  `polyth_space` cookie for this).

- **Who.** Every account, for itself only. `/api/tunnel/joined/*` needs a
  signed-in session (or the verified loopback user) on public HTTP; paired
  devices, access tokens and internal services are refused, and the routes are
  not in the paired-device table. Servers, pairing attempts and Space ids
  (`rmt_` + hash of account, connection and remote Space) answer 404 to anyone
  else.
- **Keys.** `<dataDir>/packages/tunnel/joined/<hash of account>/` (mode 0700,
  outside every Space): the client's device identities and a cached Space list.
  The client's environment carries no provider credentials. The other server
  sees the chosen server name, or "Polyth server", never the host name.
- **Connection.** Opened at package enable for everyone who has one and kept
  open, with backoff after a lost link or a dead client. Spaces are re-read on
  connect and every 5 minutes; offline, the last list stays with
  `online: false`.
- **Forwarding.** Only `/api/*` and `/ws`, through the client's loopback proxy
  with its proxy-session cookie. This server's cookies, authorization, CSRF,
  origin and forwarding headers never cross; Link also drops `Idempotency-Key`
  and every header outside its allowlist. Bodies are buffered (25 MiB, else
  413) because the proxy needs `content-length`. Responses lose `set-cookie`
  and headers that would act on this origin, and gain
  `Content-Security-Policy: sandbox` and `nosniff`, so the other server cannot
  run a page as this one. Offline answers 503 without contacting it.
- **Space choice.** HTTP carries `x-polyth-space`. A WebSocket upgrade carries
  only path and protocols, so the Space is first activated there, one upgrade
  at a time per connection until its 101. This needs the device's session
  control grant unless that Space is already selected. A server (or Link host)
  too old to pass the header is detected on connect; HTTP for any Space but its
  selected one then answers 503 asking for an update.
- **Removal.** Deleting a server runs the client's `forget` (identity
  included). Removing an account stops its client and deletes its directory.
  Neither revokes the device on the other server; its owner does that there.
- **Notifications** (`joinedNotices.ts`). The person's notifications there
  reach them here whichever Space they have open. Each joined Space gets one
  `/ws` socket (notification frames are per Space; the Space is selected like
  any upgrade) and a read of `/api/notifications` on every (re)connect and each
  minute, which delivers the newest 50 unread rows of the last 24 hours per
  Space and withdraws rows read or cleared there. An older server is only
  watched in its selected Space and never switched. Rows the other server
  itself relays from a third one are skipped. Each goes to
  `server.person-notices` with the key `rmt:<connection>:<key>` and
  `joinedSpace`. This server keeps one inbox row per person and key, listed,
  read and cleared from any of their own Spaces, never in a session's history;
  a later notice of the key replaces it and a cleared one does not return. The
  live frame and push legs go to that person only, and while one device is in
  use only it is alerted. Leaving the server (or its revoking the device)
  withdraws what was delivered; disabling the package keeps it. Opening one
  switches to the joined Space and lands on its session URL; the list names the
  source as "<space> · <server>".

## Device names

Each phone names itself when it pairs: iOS sends `UIDevice.current.name`
(the model, "iPhone"/"iPad", on iOS 16+ without the user-assigned-name
entitlement), Android the name set in Settings (`Settings.Global.DEVICE_NAME`)
or maker and model. Older apps sent the placeholder "This phone"; the tunnel
package shows a placeholder as the platform ("iPhone", "Android",
`src/deviceLabel.ts`). One account's devices never share a name: a new pairing
stores the first free numbered form ("iPhone 2"), and device rows of older
same-named pairings are numbered by pairing time when listed. The desktop app
sends its platform ("Mac", "Windows PC", "Linux PC"), never the host name, which
often carries a person's name to someone else's server.

## Server name

Phones show a server by the name its owner gives it. The tunnel package keeps
it in `tunnel.db` (`tunnel_setting` key `server-name`; empty means the short OS
host name). `GET /api/tunnel/server-name` returns `{ name, fallback, editable }`
to a local tunnel admin; `PUT` with `{ name }` is the server owner's only
(`usr_owner`), because every member's phones see it, and emits
`tunnel/server-name-changed`. Names are one printable line of at most 80
characters (`cleanServerName` in `src/serverName.ts`, `clean_label` in
`polyth-link-core`).

The name reaches phones two ways. New pairing tickets carry it as
`host.label` (QR and six-digit code alike). The host also holds it
(`host.set_label`, sent after trust sync and before `endpoint.start`, and on
every change) and returns it in `ConnectionAccepted.host_label`, so a phone
that paired earlier stores the current name on its next connection. The field
is optional in both directions: older hosts send none, older clients ignore it.
A name the person gave the server on their phone always wins (see
`docs/mobile/polyth-link.md`, "Server names").
