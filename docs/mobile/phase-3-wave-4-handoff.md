# Phase 3 Wave 4 — native mobile handoff

Wave 4 status: **complete (code and docs)** on
`feat/phase-3-product-ux-mobile-bb96`.

## Delivered commits

- `e03c508d` — `feat(mobile): scaffold Capacitor platform clients`
- `7e70f44f` — `feat(mobile): add runtime connection onboarding`
- `f0879a08` — `feat(mobile): integrate native lifecycle and device bridges`
- `f0cd63c6` — `fix(mobile): align native bridge contracts`
- `592a7e92` — `chore(mobile): sync native plugin projects`
- `8c6574bf` — `fix(mobile): load canonical tokens before connection gate`
- documentation — `docs(mobile): add Phase 3 Wave 4 handoff`

## What is built

- One `apps/mobile` Capacitor 8 workspace package and config.
- Real Android Gradle and iOS Xcode/SPM projects using
  `com.polyth.mobile` and the Polyth name.
- Generated Polyth icons plus light/dark splash assets in both projects.
- Canonical web build consumption through `webDir: ../web/dist`; no React
  fork, native-only store, or second sync client.
- Native first-launch connection screen with normalized host validation,
  recent hosts, explicit test, auth handoff, network/certificate errors, and
  active-host restoration.
- Mode A runtime boundary: server, SQLite, projects, and OpenCode stay on the
  selected desktop/server host.
- `polyth:` project/session deep links.
- Native lifecycle resume/reconnect and state restoration.
- Android Back orchestration from Escape layers through drawer/panes/history
  to background.
- Native document/image picker feeding the existing attachment upload path,
  with cancellation and denial handling.
- Safe-area and keyboard mapping into the existing shared CSS/viewport
  contract.
- External platform browser routing and internal-link retention.
- Native clipboard, authenticated download-to-share, subtle haptics, and local
  notification foundation.
- Root build, sync, open, and Android build scripts.

## Desktop and mobile runtime models

Electron starts a loopback Polyth server and passes it a bundled OpenCode
binary. Capacitor does neither. It validates and loads an existing Polyth
server, then operates as a same-origin REST/WS client using the shared React UI.

Desktop and mobile therefore share contracts, package views, event reduction,
recovery, session status, drafts, and navigation state. Only lifecycle, system
insets, file selection, external browsing, clipboard/share, notifications, and
platform identity are native.

## Validation actually run

With Node 22.22.2:

```sh
npx tsc --noEmit                                      # apps/mobile: passed
npx tsc --noEmit                                      # apps/web: passed
node --test apps/mobile/test/runtime.test.ts \
  apps/web/test/nativeMobile.test.ts \
  apps/web/test/mobileFoundation.test.ts \
  apps/web/test/mobileNavigationAudit.test.ts \
  apps/web/test/recoverySurfaces.test.ts               # 19 passed
npm run build:mobile                                  # passed; web built and both projects synced
npm --workspace @polyth/mobile run build:android      # stopped: Android SDK unavailable
```

The Android build downloaded and started Gradle 8.14.3, configured the app and
plugin projects, then stopped because neither `ANDROID_HOME` nor
`android/local.properties` points to an SDK. This is an environment/toolchain
blocker, not a source compilation result.

The iOS Xcode project and Swift Package plugin graph are generated and synced.
This Linux environment has no Xcode, iOS SDK, or simulator, so iOS compilation
and simulator/device behavior were not run.

## Deliberate deferrals

- Share into Polyth is deferred to Phase 4 pending a complete Android intent +
  iOS Share Extension/app-group queue and destination picker.
- A direct camera action is deferred until it can have a distinct permission
  and source-choice UX.
- APNs/FCM registration, production push delivery, store signing, store
  metadata, and release automation are out of scope.
- Dynamic universal/app-link domain association is deployment-specific; the
  `polyth:` scheme is implemented.
- Certificate pinning, server discovery, remote relay, and E2EE pairing are not
  implemented.
- Native simulator/device QA remains required on machines with the respective
  SDKs.

## Wave 5 must read

1. `AGENTS.md`
2. `docs/mobile/architecture.md`
3. `docs/mobile/development.md`
4. `docs/mobile/platform-behavior.md`
5. `docs/mobile/phase-3-wave-4-handoff.md`
6. `docs/product-ux/phase-3-wave-3-handoff.md`
7. `apps/mobile/capacitor.config.ts`
8. `apps/mobile/src/runtime.ts`
9. `apps/mobile/src/nativeBridge.ts`
10. `apps/web/src/main.tsx`, `apps/web/src/bootstrap.tsx`,
    `apps/web/src/mobileViewport.ts`, and `apps/web/src/nativeMobile.ts`

Wave 5 should run the full repository suite, repeat native builds where SDKs
are available, and write the final Phase 3 handoff. It must preserve the Mode A
boundary and must not claim App Store/Play Store or production push readiness.
