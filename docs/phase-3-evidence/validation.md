# Phase 3 validation evidence

## Outcome

**IMPLEMENTATION COMPLETE — NATIVE VALIDATION PARTIAL.**

Independent QA ran on 2026-08-28. The repository, browser flows, Electron
startup, mobile synchronization, and Android source compilation are green.
Android interactive emulator QA was attempted but blocked by a native Google
WebView crash in this VM's software-emulated CPU. iOS compilation and runtime
QA remain unavailable on Linux. This is therefore not a full native-platform
validation claim.

## Environment

- OS: Linux `6.12.94+`, x86_64.
- The initial shell resolved Node `22.14.0`; final validation explicitly used
  the installed Node `22.22.2` runtime. npm was `10.9.7`.
- Java: OpenJDK `21.0.10`.
- Gradle wrapper: `8.14.3` (Kotlin `2.0.21`, Groovy `3.0.24`).
- Android SDK: command-line tools, platform tools, platform 36, build tools
  35/36, emulator, and the API 36 Google APIs x86_64 image under
  `$HOME/Android/Sdk`.
- Chrome: `/usr/bin/google-chrome`.
- Xcode, Swift, and the iOS SDK were not installed.

## Repository

- Base supplied for the validation branch: master `e2c65f30`.
- Branch: `feat/phase-3-validation-closure-778b`.
- Product and test fixes validated through `786cd537`; the documentation commit
  follows this completed pass.
- Planned or implementing rows in `docs/parity/polyth-parity.yaml` remain
  unfinished and are not claimed here.

## Root validation

- `npm run build`: exit 0 after the final fixes. The package widgets and the
  canonical web bundle built successfully.
- `npm test`: exit 0, 1,718 tests, 1,716 passed, 0 failed, 2 skipped. The skips
  are opt-in external/live integrations: the real OpenCode provider list and an
  OpenCode-free-model/Jira agent session. No product regression was skipped.
- `npx tsc --noEmit`: 33/33 app and package `tsconfig.json` projects passed.
  `apps/web` was checked again after the final focus fix.
- `npm run build:mobile`: exit 0 after the final fixes; the current web bundle
  and all 12 native plugins synchronized to Android and iOS.
- `npm run build:desktop`: exit 0 after the final fixes.

## Web

- `composerDiscovery.live.ts`: 12/12 passed against a real Chromium fixture.
  It covered Add-menu truthfulness, sigil insertion, unavailable/error states,
  shell entry, GitHub links, dictation states, model/agent persistence,
  queue/stop behavior, focus order, coarse-pointer targets, and 320/390 px
  phone geometry.
- `workflowOrchestration.live.ts`: 5/5 passed. It covered Chat/Goals discovery,
  compact shortcuts, placement repair, the complete synchronized workflow
  journey, and visual geometry at 320, 375, 667×375, 768, 1280, and 1440 px.
  The matrix also exercised keyboard safe-area geometry, reduced motion, light
  and dark themes, RTL localization, and 200% zoom.
- The final 320 px Add sheet stayed in bounds, retained focus, exposed
  non-overlapping 44 px controls, and remained usable over an active turn.

## Electron

- The final desktop bundle built successfully.
- A development Electron process started its embedded server at
  `http://127.0.0.1:38593`, found the bundled OpenCode `1.18.22`, configured the
  updater, created the system tray, and reported `Desktop renderer ready`.
- The first lease attempt exposed an Electron recursion/data-lock regression.
  `d974ee45` forces the lease holder into Node mode; its focused regression test
  and the subsequent Electron startup both passed.
- Installer packaging, signed distribution, update installation, and broad
  pointer/keyboard interaction inside a packaged binary were not run.

## Android

### Sync

- Capacitor copied the final web bundle and synchronized all 12 plugins
  successfully.

### Compile

- `./gradlew :app:assembleDebug`: exit 0. The fresh compile completed all 301
  tasks; the post-fix incremental compile completed 21 tasks with 280
  up-to-date.
- Debug APK: `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

### Emulator

- An API 36 Google APIs x86_64 AVD booted, reported
  `sys.boot_completed=1`, accepted the debug APK, and resolved both the launcher
  and `polyth://open/p/project-1/s/session-1` to
  `com.polyth.mobile/.MainActivity`.
- Hardware-accelerated startup remained offline in this nested VM. Software
  emulation booted after 700 seconds, but Android's Google
  `TrichromeLibrary.apk!libmonochrome_64.so` raised native `SIGTRAP` while
  constructing the WebView. The trace is outside Polyth code and prevented a
  trustworthy connection, keyboard, back, file-picker, notification, or
  lifecycle interaction pass.
- Emulator QA status: attempted and blocked; not passed.

### Device

- No physical Android device was attached. Device QA was not run.

## iOS

### Sync

- `npx cap sync ios` and the final `npm run build:mobile` both passed with all
  12 plugins.
- Structural inspection confirmed bundle id `com.polyth.mobile`, iOS 15
  deployment target, the `polyth` URL scheme, SceneDelegate forwarding for URL
  and user-activity events, local-network usage text, generated assets, and the
  Capacitor Swift package graph.

### Compile

- Not run. `xcodebuild` and `swift` are unavailable on this Linux host. No fake
  compile success is claimed.

### Simulator

- Not run; an iOS simulator and SDK require macOS/Xcode.

### Device

- Not run; no signed build or physical iOS device was available.

## Deep links

- Commit `7ecebe33` behavior remains covered, and `4e2128d5` added malformed
  canonical path coverage.
- Runtime tests passed for canonical project/session links, unsupported
  schemes, malformed `%` encodings, encoded slash rejection, and stripping of
  action, token, password, and fragment data. Credential-like query data is
  never copied onto the selected Polyth host.
- The Android package manager independently confirmed that the custom
  `polyth:` scheme resolves to `MainActivity`.

## Lifecycle

- A focused 58/58 reliability matrix passed. It covered native Back priority,
  remote startup deadlines, late-forward disposal, daemon rotation,
  owned-target restart single-flight behavior, PID reuse, bind collisions,
  generation fencing, REST/SSE timeout and replay policy, missed attention
  reconciliation, durable queue recovery, hard backend death, worktree
  isolation, and data-directory lease exclusion.
- The full 1,718-test pass independently included these lifecycle contracts.

## Accessibility

- Browser gates verified accessible names and ARIA state, sequential focus
  order, focus containment/restoration, topmost-modal behavior, keyboard
  Escape, 200% zoom, reduced motion, and at least 44×44 px coarse-pointer
  controls.
- Regressions fixed during validation included undersized mobile navigation,
  compact Add/dictation controls, drag handles losing pointer movement, and the
  opening pointer gesture returning focus behind a sheet.
- The final workflow launcher baseline intentionally retains its visible focus
  ring rather than blurring a modal control.

## Performance

- A local 1440×900 headless-Chrome spot check reported response end at 3 ms,
  DOMContentLoaded at 150 ms, load at 151 ms, 195 resources, 744,683 transferred
  bytes, no observed long tasks, and no console errors.
- Wall-ready time was 1,901 ms and includes an intentional 1,500 ms observation
  window. These local fixture numbers are a regression spot check, not a
  production network/device benchmark.

## Fixes

- `4e2128d5`: hardened deep-link canonicalization, preserved colliding
  worktree/root backend mappings, made the desktop build runnable on the
  available Node runtime, and repaired compact-shell CSS contracts.
- `d974ee45`: prevented recursive Electron lease-holder launches.
- `e4eb5746`, `a197e3c3`, `ee244feb`, `26de0c4a`, and `22384cbb`: restored
  touch reordering, 44 px navigation/composer/dictation targets, and
  non-overlapping compact composer controls.
- `01c19fe6`, `3e9f5839`, `630d24af`, and `e1e41c26`: repaired sheet initial
  focus, protected newer modals, guarded late pointer echoes, and registered
  the real touch opener before the sheet mounts.
- `fc9c31c4`: deferred compact-composer collapse until the destination click
  completes, preventing mobile tap retargeting during layout changes.
- Test harness and visual evidence were aligned in `ab60e0b6`, `7caf33cb`,
  `4b04d5d5`, `b1fb233b`, `d3a48814`, `f6fbe4f2`, `7093c2ca`, `e043e735`, and
  `786cd537`.

## Unresolved gaps

- Android needs rerun on a hardware-accelerated emulator or physical device;
  this VM's software WebView crash blocks interactive native evidence.
- iOS still needs Xcode compile, simulator, signing, and physical-device QA.
- Physical safe areas, native keyboard transitions, document picker,
  notification permission/taps, external-browser handoff, haptics, and
  hardware Back remain device-level gaps.
- Electron installer/signing/update paths and sustained production performance
  profiling remain outside this validation pass.
- Deployment-specific universal/app-link association remains unvalidated. The
  custom `polyth:` scheme is the tested cross-host foundation.

## Artifacts

- `/opt/cursor/artifacts/phone_320_add_menu.png`
- `/opt/cursor/artifacts/phase3_postfix_build.log`
- `/opt/cursor/artifacts/phase3_tests_strict_final.log`
- `/opt/cursor/artifacts/phase3_final_typechecks.log`
- `/opt/cursor/artifacts/phase3_composer_live_final.log`
- `/opt/cursor/artifacts/phase3_workflow_live_strict.log`
- `/opt/cursor/artifacts/phase3_workflow_visual_strict.log`
- `/opt/cursor/artifacts/phase3_postfix_native_bundles.log`
- `/opt/cursor/artifacts/phase3_postfix_android_gradle.log`
- `/opt/cursor/artifacts/phase3_electron_runtime_ready.log`
- `/opt/cursor/artifacts/phase3_android_emulator.log`
- `/opt/cursor/artifacts/phase3_android_webview_crash_excerpt.log`
- `/opt/cursor/artifacts/phase3_performance_spotcheck.log`
