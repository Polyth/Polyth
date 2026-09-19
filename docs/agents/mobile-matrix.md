# Mobile readiness and regression matrix

Shared responsive web, Capacitor bridge, native implementation, release build and real device behavior are different layers. Use the matrix for the affected feature. Mark each cell **not implemented / declared / unit-tested / native-built / device-tested / unknown**, with revision and evidence. Do not fill it from a marketing claim or a previous handoff.

The TypeScript boundary still defaults fail-closed to `MissingNativeCore`, but current Android and iOS projects register real `PolythLink` and discovery plugins and production connection UI installs that adapter. This is source-level wiring evidence, not a permanent readiness claim: native compilation and physical-device behavior remain separate verification layers.

| Flow | Required scenarios | Boundary to inspect |
| --- | --- | --- |
| Connection setup | First launch, configured server, invalid URL, unreachable server, required authentication, cancel/retry | ConnectionScreen, runtime, native proxy and server auth |
| Multiple servers | A/B/A, same project/session IDs on distinct servers, old pending response, forget/disconnect, credential isolation | Identity-keyed caches, listeners, active server state |
| Local discovery | Permission denied, no server, multiple servers, unreachable/stale candidate, bounded scan, platform restriction | Actual discovery mechanism; do not assume browser subnet scanning/native mDNS exists |
| QR/digital pairing | Scan/input, malformed/expired/replayed ticket or code, wrong host identity, confirmation, cancel, timeout | Ticket parser, native core, host invitation/grant flow |
| Paired connection | Direct/relay fallback, trusted host identity, revoked/partial revoke, unknown route | Native proxy, Link ingress, route policy, live grants |
| Streaming/reconnect | Packet loss, server restart, duplicate/gap events, foreground return, interrupted mutation | Canonical WS/event recovery, epochs and receipt semantics |
| App lifecycle | Screen lock, background suspension, foreground, process termination, fresh launch | Platform lifecycle; no promise of a permanent background socket |
| Notifications | Denied permission, local delivery, actual push delivery if implemented, routing after tap, duplicate suppression | LocalNotifications is not APNs/FCM registration and push transport |
| Haptics | Supported/unsupported device, disabled preference, success/error distinction | Shared haptic preferences and native bridge |
| File/audio/camera | Cancel, deny, oversized/unsupported MIME, safe URI access, cleanup | Native picker/capture, upload, canonical representation, adapter modality |
| Deep links | Cold/warm start, malformed route, wrong server/Space, pairing versus content link | Native registration, parsing, auth and pending-link lifecycle |
| Keyboard/gestures | Safe areas, rotation, input focus, multiline/composition, back/escape, scroll versus swipe | Shared viewport, sheets, back handlers, native keyboard events |
| OS widgets | Snapshot refresh, stale/offline display, secure data sharing, tap routing, OS constraints | Actual WidgetKit/AppWidget/native extension, not a web dashboard widget |
| Release | Native plugin linked, permissions declared, identifiers/resources aligned, signed installation | Platform projects, CI/CodeMagic, device smoke |

## Review order

First read the target function/registration, then the required platform configuration and native implementation, then tests for that boundary. Confirm build inclusion. Finally exercise the behavior on an actual affected OS/device or label that step unrun. Do not rewrite the entire app to another UI stack without a concrete, reviewed blocker.

## Privacy and state

Private keys stay native. Server/account/Space changes invalidate or partition state; an old callback must not populate a new server's view. Permission requests follow user intent and use minimal scope. OS widgets and notifications must not leak sensitive prompts on a locked device. Retain authoritative conversation state on the server; any local read cache must not become a second event authority.

## Evidence record

For each tested flow record build/commit, OS version, device/simulator distinction, connection transport and expected/observed outcome. A simulator or mocked plugin can be useful evidence, but it is not automatically a physical-device networking/background/notification test. State the actual limitation.
