# Polyth Phase 3 handoff

## Completed

Phase 3 is complete at the code and documentation level on
`feat/phase-3-product-ux-mobile-bb96`. Wave 1 specified the product UX,
Wave 2 implemented the daily-use UX, Wave 3 deepened agent workflows, and Wave
4 added native iOS and Android client projects. Wave 5 fixed native deep-link
handling in `7ecebe33`.

This handoff does not claim complete polyth/Paseo parity. Rows still marked
`planned` or `implementing` in `docs/parity/polyth-parity.yaml` remain
unfinished.

## Product UX added

- One adaptive command palette with package command registration, desktop and
  phone ordering, and existing session actions without a destructive delete
  action.
- Shared session status across the sidebar, recents, mobile navigation, and
  palette.
- Responsive session search and starter selection; starters fill the composer
  but never auto-send.
- Inline reconnect, unavailable-send retry, and failed-turn recovery that
  preserve drafts and useful session content.
- Phone-only bottom navigation, a notification-centre shortcut, a quiet context
  pressure indicator, and searchable dense-label selection.

## Advanced agent workflows

- Multirun presents setup, truthful progress, one selected response, reported
  usage, pick, and continue-in-chat actions in adaptive desktop and phone
  layouts.
- Fusion leads with one synthesized answer and progressively discloses source
  provenance and disagreements.
- Active Multirun and Fusion work contributes to durable projection-owned
  background-work counts, shared `Working` session status, and the existing
  bounded notification flow.
- The composer remains the canonical agent selector. Phase 3 adds no competing
  global agent switcher, separate activity feed, or speculative task hierarchy.

## Mobile architecture

Mobile uses Mode A: the Capacitor app is a client of an existing Polyth server.
OpenCode, Node, SQLite, projects, worktrees, and agent processes do not run
on-device. The iOS and Android shells consume the canonical React bundle and
use the existing REST, WebSocket, event-reduction, draft, recovery, and
navigation contracts.

The native layer owns runtime-host onboarding, lifecycle events, system insets,
keyboard mapping, native file selection, external browsing, clipboard,
download-to-share, haptics, and local-notification foundations.

## iOS status

A real Xcode/SPM project exists and has been synchronized with the shared web
bundle and Capacitor plugins. This Linux VM has no Xcode, iOS SDK, or simulator,
so iOS compilation and simulator/device QA were not run. Store signing,
provisioning, and distribution are not complete.

## Android status

A real Gradle project exists and has been synchronized. Gradle 8.14.3 started,
configured the app and plugin projects, then stopped because `ANDROID_HOME` was
unset and no SDK path was available. This is not an Android source compilation
success. No Android emulator or physical-device QA was run.

## Desktop/web regression status

Wave 4 recorded a passing `apps/web` TypeScript check and 19 passing targeted
mobile/web recovery tests. Wave 3 recorded passing targeted Multirun, Fusion,
background-work, session-status, and notification tests. A complete green
repository suite was not recorded before this handoff was created; see
`docs/phase-3-evidence/validation.md` for Wave 5 validation updates.

## Validation performed

Recorded implementation-wave validation used Node 22.22.2:

- Wave 3: 12 Multirun tests, 7 Fusion tests, and 22 background-work,
  session-status, and notification tests passed; touched-package and web
  TypeScript checks passed.
- Wave 4: `apps/mobile` and `apps/web` TypeScript checks passed; 19 targeted
  runtime, native-mobile, mobile-foundation, navigation, and recovery tests
  passed; `npm run build:mobile` passed and synchronized both native projects.
- Wave 4 Android Gradle validation stopped at the missing SDK boundary.
- Wave 5 fixed malformed percent-decoding bounds and stripped unsupported or
  credential-like HTTPS deep-link query parameters in `7ecebe33`. Further Wave
  5 QA is recorded separately as it is run.

## Device/emulator matrix

| Target | Compile/build | Simulator/emulator | Physical device |
| --- | --- | --- | --- |
| Shared web bundle | Wave 4 mobile build passed | Browser-targeted automated tests only | Not run |
| iOS | Not run; Xcode unavailable on Linux | Not run | Not run |
| Android | Gradle started, then stopped because the SDK was unavailable | Not run | Not run |
| Electron desktop | No Wave 5 packaging run recorded | Not run | Not run |

No unlisted device, simulator, emulator, orientation, safe-area, keyboard, deep
link, notification, or hardware-back result should be inferred from this
matrix.

## Remaining known issues

- Native compilation and behavior require Xcode/iOS Simulator and Android SDK
  environments, followed by real-hardware testing.
- Dynamic universal/app-link association is deployment-specific; the custom
  `polyth:` scheme is the cross-host foundation.
- Local notifications are only a foundation. There is no APNs/FCM registration
  or production remote-push relay.
- Internet-facing servers still require operator-supplied TLS and
  `POLYTH_UI_PASSWORD`; Phase 3 adds no remote relay, certificate pinning, or
  end-to-end pairing.
- A complete green full-repository suite was not recorded at handoff creation.

## Native features deferred

- Share-into-Polyth, including Android intent ingestion and an iOS Share
  Extension/app-group queue.
- Direct camera capture and its dedicated source-choice and permission UX.
- Production push delivery, dynamic runtime discovery, universal/app-link
  deployment setup, store metadata, signing, and release automation.
- Certificate pinning, remote relay, and end-to-end pairing.

## Security considerations

- The selected runtime host remains the security boundary. Credentials in
  connection URLs are rejected, only normalized validated origins are stored,
  and passwords are handled by the existing same-origin lock screen and
  httpOnly cookie.
- HTTPS is required on untrusted networks. Explicit HTTP support is limited to
  development/same-LAN deployments and does not make unauthenticated remote
  exposure safe.
- Native file selection retains scoped access and reuses existing attachment
  count, path-jail, upload, event-log, and send validation.
- Commit `7ecebe33` bounds deep-link percent decoding so malformed
  `polyth://session` and `polyth://project` links cannot throw and blank the
  app. It also prevents HTTPS app links from copying unsupported or
  credential-like query parameters onto the validated host.
- Notification text remains bounded and redacted; secrets must not enter
  configuration responses, logs, deep links, or stored runtime origins.

## Recommended Phase 4

Record these as Phase 4 candidates only: store pipelines, signing, TestFlight,
production push backend, share extension, runtime discovery, credential
hardening, crash reporting, and real-hardware profiling. Prioritize native
compile/device matrices and credential hardening before distribution work.
Nothing in this section is implemented or started by Phase 3.
