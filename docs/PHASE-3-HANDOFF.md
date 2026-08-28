# Polyth Phase 3 handoff

## Status

**IMPLEMENTATION COMPLETE — NATIVE VALIDATION PARTIAL.**

Post-implementation QA on `feat/phase-3-validation-closure-778b` produced a
green root build, full repository suite, all-package TypeScript matrix, browser
journeys, Electron startup, Capacitor sync, and Android debug compile. Android
interactive QA was blocked by the API 36 emulator's native Google WebView
`SIGTRAP` under software CPU emulation. iOS compile/simulator/device QA remains
unavailable on Linux. See `docs/phase-3-evidence/validation.md` for exact
commands, counts, fixes, and artifacts.

## Completed

Phase 3 is complete at the code and documentation level on
`feat/phase-3-validation-closure-778b`. Wave 1 specified the product UX, Wave 2
implemented the daily-use UX, Wave 3 deepened agent workflows, Wave 4 added
native iOS and Android client projects, and Wave 5 fixed native deep-link
handling in `7ecebe33` before the independent validation/fix pass.

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
bundle and all 12 Capacitor plugins after the final fixes. Structural inspection
confirmed the bundle id, iOS 15 target, URL scheme, scene lifecycle forwarding,
local-network description, asset catalogs, and Swift package graph. This Linux
VM has no Xcode, Swift, iOS SDK, or simulator, so iOS compilation and
simulator/device QA were not run. Store signing, provisioning, and distribution
are not complete.

## Android status

A real Gradle project exists and has been synchronized with all 12 plugins.
Gradle 8.14.3 compiled the debug app successfully: the fresh run completed 301
tasks and the post-fix run completed 21 tasks with 280 up-to-date. The API 36
x86_64 emulator booted, installed the APK, and resolved the launcher and
`polyth:` scheme to `MainActivity`. Interactive QA is not claimed: Google
WebView crashed natively in `libmonochrome_64.so` with `SIGTRAP` under the VM's
software CPU emulation. No physical-device QA was run.

## Desktop/web regression status

The final root build passed. The final full repository suite passed 1,716 of
1,718 tests with 0 failures and 2 opt-in external integration skips. All 33
TypeScript projects passed. Real-Chromium composer and workflow matrices passed
12/12 and 5/5 across 320–1440 px, compact landscape, keyboard safe-area,
reduced-motion, light/dark, RTL, and 200% zoom cases. Electron built and reached
`Desktop renderer ready` with its embedded server, bundled OpenCode, updater,
and tray initialized.

## Validation performed

Final validation used Node 22.22.2, npm 10.9.7, OpenJDK 21.0.10, and Gradle
8.14.3:

- `npm run build`, `npm run build:mobile`, and `npm run build:desktop` passed.
- `npm test`: 1,718 tests, 1,716 passed, 0 failed, 2 skipped.
- `npx tsc --noEmit`: 33/33 app/package projects passed.
- Focused lifecycle/deep-link matrix: 58/58 passed.
- Real-Chromium composer matrix: 12/12 passed.
- Real-Chromium workflow matrix: 5/5 passed.
- Android `:app:assembleDebug`: 301-task fresh compile passed and final
  incremental compile passed.
- Android emulator launch was attempted and blocked by the system WebView
  native crash described above.
- iOS sync and structural inspection passed; compilation was not attempted
  because Xcode is absent.

## Device/emulator matrix

| Target | Compile/build | Simulator/emulator | Physical device |
| --- | --- | --- | --- |
| Shared web bundle | Final root/mobile/desktop builds passed | Chromium matrices passed at 320–1440 px and compact keyboard/landscape cases | Not run |
| iOS | Sync/structure passed; compile not run because Xcode is unavailable | Not run | Not run |
| Android | Gradle debug APK compile passed | Boot/install/deep-link resolution passed; interaction blocked by native system WebView crash | Not run |
| Electron desktop | Bundle passed | Development app reached renderer-ready state | Not run |

No unlisted device, simulator, emulator, orientation, safe-area, keyboard, deep
link, notification, or hardware-back result should be inferred from this
matrix.

## Remaining known issues

- Android behavior needs a hardware-accelerated emulator or physical device;
  this VM's software-emulated WebView cannot execute successfully.
- iOS behavior still requires Xcode compile, iOS Simulator, and real hardware.
- Dynamic universal/app-link association is deployment-specific; the custom
  `polyth:` scheme is the tested cross-host foundation.
- Local notifications are only a foundation. There is no APNs/FCM registration
  or production remote-push relay.
- Internet-facing servers still require operator-supplied TLS and
  `POLYTH_UI_PASSWORD`; Phase 3 adds no remote relay, certificate pinning, or
  end-to-end pairing.
- Electron installer signing/update installation and sustained production
  performance profiling remain unvalidated.

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
