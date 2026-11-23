# Polyth Link on mobile

Polyth mobile is a native client for an existing Polyth runtime. Production
Android and iOS builds register the native `PolythLink` adapter and keep the
server, projects, sessions, worktrees and agent processes on the Polyth host.

## Connection Hub

The bundled app opens the Connection Hub whenever it needs to establish or
choose a server connection.

Normal cold start:

1. load trusted Polyth Link connections from native storage;
2. choose the most recently used connection that is active, not revoked, and
   has a secure device identity;
3. reconnect it through the native Link client;
4. load the canonical Polyth web UI from the authenticated loopback proxy.

A cold start therefore does not show onboarding again once a healthy trusted
server exists. Automatic reconnect is intentionally skipped when the user
explicitly chose **Switch Polyth server**, when a pairing link is pending, when
a cross-server deep link needs a target, or when a notification is already
bound to a specific trusted connection.

Inside a connected server the native app offers that choice in two places: the
phone Navigator's title (the Space name with a ▾; with several Spaces, the
last entry of its Space menu, **Switch server**) and the **Switch Polyth
server** command (`apps/web/src/nativeConnections.ts`); a browser renders
neither.

The title opens the app's **native server menu** at itself: every paired
server (the open one on top with a check, unusable ones dimmed) and **Add
server**. The page only calls `PolythLink.presentServerMenu({x, y, width,
height})` with its button's viewport rect; the native side lists and draws the
servers itself (iOS: a glass panel springing out of the button; Android: a
popup scaling out of it), and the page gets back only `switch`, `add`,
`current` or `cancel`, never a server id or label. A picked server stays in
native memory for 60 s; the page then returns to the hub with
`?selectServer=1`, where `prepareMobileLaunch` takes it once through the
bundled-only `consumeServerChoice` and the hub opens it behind the launch veil
(a failure leaves the hub on that server's card). **Add server** returns with
`?selectServer=1&addServer=1` and the hub leads with its pairing card. Where
the menu cannot show (an older app build, a development host, the command
palette), the call falls back to the hub's server list (`chooseMobileServer` in
`apps/mobile/src/runtime.ts`).

### Server zones

The phone Navigator also lists the other paired servers as **zones** with their
projects, and a tap on a project moves the app to that server at that project
(UI in [ui.md](../dev/ui.md#server-zones-in-the-navigator); the same idea as
[Polyth Desktop](../dev/desktop.md#server-zones)). A phone can be paired with any
number of servers.

- **No connection is kept for a zone.** Only the open server has a page and a
  Link session. Its page lists its own projects while it is open
  (`PolythLink.reportZoneProjects`: id, name, icon and colour of the root
  projects of its current Space, never a path), and the Link client keeps the
  last list per server in `zones.json` beside `connections.json`. A zone is a
  snapshot from that server's last visit; a server not opened since the app
  learned zones is a heading with one row that opens it.
- **The rules live in the shared Link client**
  (`crates/polyth-link-client/src/zones.rs`, methods `zones.view`,
  `zones.report`, `zones.allow`, `zones.fold`, `zones.open`), so iOS and Android
  cannot drift. The native plugins only decide who is asking and draw the
  question.
- **A page speaks only for its own server.** The five plugin methods
  (`serverZones`, `reportZoneProjects`, `allowServerZones`, `foldServerZone`,
  `openServerZone`) answer only the page of the proxy the app opened, and the
  sender is the connection behind that proxy, never a value from the call. A
  list is validated and bounded (200 projects, names of 120 characters, icons
  of 4 KiB).
- **A server sees the others only after the person allowed it.** Until then
  the page gets `access: "ask"` and no name, and the Navigator shows one row,
  *Show my other servers here*. `allowServerZones` raises a native alert that
  names the server in the app's own words; only **Allow** records the
  permission, per server. An allowed page gets each zone's name, its projects
  and a random key for it, never a connection id.
- **A tap goes only where a zone leads.** `zones.open` accepts a zone the
  sender may see and a project that zone listed. The native side then holds
  that server for the hub exactly as a pick from the server menu
  (`consumeServerChoice`), and the page returns to the hub with
  `?selectServer=1` and `/p/<id>` as the pending path (`mobileServerZones` in
  `apps/mobile/src/runtime.ts`). A revoked pairing holds nothing: the hub shows
  its server list.
- Zones are ordered by name so they stay put. Forgetting a server drops its
  list, its fold and its permission. Servers reached by address (the developer
  path) have no zones.

Evidence: the client rules and the shell's store are unit-tested, the native
methods are covered by source assertions (`apps/mobile/test/serverZones.test.ts`),
and the Navigator was rendered in a browser with a stand-in for the plugin.
Nothing here has run on a device yet.

The Connection Hub remains the recovery and server-management surface. It shows
trusted servers, reconnect/switch state, revoke or identity failures, and
pair-another-server actions. Forgetting a connection removes that native trust
record; it is not presented as an ordinary server URL.

### Server names

A saved server shows the name its owner set on the Link page (the computer's
host name until then; see [Server name](../architecture/polyth-link.md#server-name)).
The hub's ••• menu offers **Rename**: the row turns into a field ("Name on this
phone", the server's own name as placeholder), Save stores it and **Use
computer's name** drops it. The name stays on this phone only: the bundled-only
`PolythLink.renameConnection({ connectionId, label })` calls the Link client's
`connections.rename`, which keeps it as `customLabel` in `connections.json`
beside the server's `hostLabel`. `connections.list` returns `hostLabel` as the
name to show (`customLabel`, else the server's), plus `serverLabel` and
`customLabel`, so the native server menu shows the same name. Pairing the same
server again keeps the phone's name; a blank name goes back to the server's.

## Pairing

The production pairing choices are:

- **Scan QR** — primary flow. iOS uses the app-owned AVFoundation scanner.
  Android uses Google Code Scanner restricted to QR format with auto-zoom.
- **Find nearby** — native local discovery lists advertising Polyth hosts.
- **Enter code** — the user chooses a discovered host and enters the six-digit
  code shown by that computer.

Both QR and numeric pairing finish through the same Polyth Link trust flow. When
the native core returns a safety phrase, the phone shows the words and requires
the user to compare them with the computer before continuing. Final trust still
waits for host approval.

Pairing tickets are short-lived and remain process-memory bootstrap material;
they are not durable device credentials.

The phone names itself to the computer: JavaScript passes no label, so the
native plugin sends the device name (see "Device names" in
`docs/architecture/polyth-link.md`). After the computer revoked the phone, or
removed the account it was paired to, scanning a new invitation pairs it again
with the same per-host identity; the old server entry does not have to be
deleted first.

## Native trust and storage

Private device identity material never enters JavaScript.

- iOS stores Link identity material in Keychain.
- Android protects Link identity material with Android Keystore-backed storage.
- JavaScript receives only bounded connection metadata, pairing state and the
  loopback bootstrap result needed to load the canonical UI.
- Device keys, invite secrets and transport credentials are not written to
  localStorage, browser-visible SQLite, logs or QR payload history.

The native Link client owns direct/relay transport, local proxy lifecycle,
connection recovery and secure identity use. The web app remains the canonical
Polyth UI after connection.

## QR scanner behavior

Android ships `com.google.android.gms:play-services-code-scanner:16.1.0` and
requests the `barcode_ui` module at install time. Google Code Scanner handles
its camera surface outside the WebView and returns only the scanned barcode
value to the Capacitor plugin.

iOS exposes `scanPairingQr` from the app-owned `PolythLink` plugin. A
WebView `BarcodeDetector` path remains a fallback for environments where the
native scanner is unavailable; it is not the primary production Android/iOS
path.

## Development server URLs

Manual HTTP(S) server addresses remain under **Advanced connection options**.
They validate the target Polyth runtime and then use the ordinary same-origin
web authentication path, but they are explicitly development connections and
must not be represented as paired or trusted Polyth Link devices.

## Deep links and server selection

Pairing links (`polyth://pair?…`) open the Connection Hub and start the secure
pairing flow when the native adapter is available.

Project/session links also return to the bundled Connection Hub instead of
blindly applying the link to whichever server happened to be active. The user
chooses the correct server unless the navigation intent is already bound to a
specific trusted connection, such as a validated native push tap.

## Verification boundary

Source wiring, unit tests and native compilation can establish that the
adapters are included and callable. QR camera presentation, LAN discovery,
background/foreground recovery and network behavior still require explicit
device verification on the affected Android/iOS build; do not infer
device-tested status from the bridge alone.
