# Polyth mobile architecture

## Runtime boundary

Polyth mobile is Mode A: a native client for an existing Polyth runtime.

```text
shared React UI (apps/web and feature packages)
        │
 Electron (apps/desktop)        Capacitor (apps/mobile)
 starts local server/OpenCode   connects to an existing server
```

The iOS and Android processes do not contain Node, SQLite, the Polyth server,
or OpenCode. Projects, worktrees, agent processes, event logs, and server-owned
configuration remain on the desktop/server host. The phone renders the same
React bundle as web and Electron and uses the same REST and WebSocket contracts.

`apps/mobile/capacitor.config.ts` is the native composition root.
`webDir` points at `apps/web/dist`; there is no second React entry or mobile UI
pipeline. `npm run build:mobile` builds the canonical web app and synchronizes
that output into both native projects.

## Connection and first launch

The packaged bundle opens a native connection gate before web authentication or
application boot:

1. enter or select a recent Polyth server;
2. validate `/api/auth/status` using native HTTP;
3. store only the normalized origin in Capacitor Preferences;
4. load that server origin in the WebView;
5. continue through the canonical password lock screen, project restoration,
   and session restoration.

The validation endpoint is intentionally the public auth-status endpoint. It
distinguishes a Polyth runtime from an arbitrary web server without requiring a
password. Passwords are never stored in the mobile host list or accepted in a
URL. If server auth is enabled, the existing same-origin, httpOnly
`polyth_auth` cookie is minted by the normal lock screen after navigation.

The five most recently used origins and the active origin are device-local.
Cold start validates the active host before restoring it. A failed restore
returns to the connection gate with the recent hosts and a bounded network or
certificate error.

## Network model and security

The server remains the security boundary. A server reachable beyond its own
machine must set `POLYTH_UI_PASSWORD`; without it, Polyth has no authentication.
HTTPS is required on untrusted networks. HTTP is supported for explicit
same-LAN development hosts, so Android cleartext WebView traffic and iOS local
network/WebView transport exceptions are declared in the native projects.

Capacitor needs a static `allowNavigation` list but user-entered hosts are
dynamic, so the native configuration permits top-level navigation and the
runtime bridge enforces application behavior:

- same-origin Polyth links stay in the WebView;
- `polyth:` project/session links route through canonical app history;
- other HTTP(S) links open in the platform browser;
- credentials embedded in connection URLs are rejected.

Only a host explicitly validated and selected by the user is loaded as the app
origin. This design does not add certificate pinning, VPN discovery, or
end-to-end pairing. Deployments needing internet access should terminate TLS in
front of Polyth and use the UI password.

## Authentication and reconnect

After connection, API fetches and `/ws` are same-origin, preserving the existing
Strict cookie and WebSocket authentication behavior. `apps/web/src/sync.ts`
remains the only session sync client: it reconnects with bounded backoff,
resubscribes with the last sequence, and deduplicates replay.

Foreground resume asks that existing client to reconnect immediately. It does
not create a second socket, duplicate a projection cache, or invent native
offline state. Wave 2 recovery remains canonical: transient disconnects stay
quiet, then expose the same reconnect affordance while cached session content
remains visible.

## State restoration

Restoration has two layers:

- Capacitor Preferences owns the active/recent runtime origins.
- The canonical web origin owns project, session, view, draft, pane, and
  timeline state through its existing storage and server projections.

Ephemeral menus and popovers are intentionally not restored. Drafts,
attachments, selected project/session, pane resources, and conversation
positions retain their existing durable behavior.

## Deep links

Both projects register the `polyth` URL scheme. Supported links include:

- `polyth://session/<session-id>`
- `polyth://project/<project-id>`
- `polyth://open/p/<project-id>/s/<session-id>`
- `polyth://open?session=<session-id>`

Links use the active validated host and enter through the existing
`/?session=` or `/p/:projectId/s/:sessionId` router. Dynamic server hosts make
universal/app-link domain association deployment-specific; the custom scheme is
the shipped cross-host foundation.

## Native bridge ownership

`apps/mobile/src/nativeBridge.ts` contains platform-only behavior:

- lifecycle and deep-link listeners;
- Android Back dispatch;
- native document/image picker conversion to browser `File` objects;
- platform browser routing;
- native clipboard fallback;
- download-to-cache followed by the native share sheet;
- subtle attachment/connection haptics;
- the semantic native-push bridge; and
- keyboard events.

Android safe-area values come from the Capacitor safe-area plugin and feed the
canonical `--safe-*` tokens. Native keyboard height feeds
`--keyboard-inset`; `--visual-vh` and `--visual-bottom` remain owned by
`apps/web/src/mobileViewport.ts`. Browser and Electron behavior is unchanged.

Native push is owned by the single native controller, not by ordinary web code.
The generic Capacitor push plugin was not used because its normal registration
listener exposes the raw provider token to JavaScript, contradicting this
feature's secret boundary; the narrow app-owned plugin exposes semantic values
only. It keeps APNs/FCM tokens inside native/provider transport code and relay
management capabilities in Keychain/Keystore-backed storage, derives the binding from the saved Link identities plus the
authenticated account input, and exposes only status, enable/disable, and one
bounded pending-open record to the bundled app. Enabling is point-of-use and is
not considered enabled until the authenticated server redeems the short-lived
claim. The relay origin and iOS environment are build-owned; redirects and
non-origin relay configuration are rejected.

A provider payload has only a validated subscription id, notification UUID,
kind, and opaque tag. A receipt never opens content. A user tap records the
saved trusted connection/account mapping, returns to the bundled Connection
Hub, reconnects that exact saved Link connection, and forwards only the UUID to
the authenticated server for canonical notification lookup. Foreground delivery
for that exact mapping is suppressed in favour of WebSocket/in-app state; other
trusted mappings keep their OS notification. Browser/local fallback remains
when native push is disabled or unavailable.

The native controller and relay contract are source-tested. APNs/FCM delivery,
Apple entitlement signing, Firebase project configuration, and physical-device
foreground/background behavior still require externally configured device
verification; no provider call is made during normal tests.

Forgetting a saved Link connection best-effort revokes and erases only its
native mappings before the Link identity is removed. Account deletion
immediately invalidates its paired ingress and notification delivery through
server-side account/membership revalidation; any stale local mapping remains
unable to open content without normal authenticated lookup.
