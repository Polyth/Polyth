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

The Connection Hub remains the recovery and server-management surface. It shows
trusted servers, reconnect/switch state, revoke or identity failures, and
pair-another-server actions. Forgetting a connection removes that native trust
record; it is not presented as an ordinary server URL.

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
