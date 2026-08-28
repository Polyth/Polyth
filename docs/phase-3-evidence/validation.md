# Phase 3 validation evidence

Wave 5 created the final handoff before running additional QA, as required.
This file is updated with exact commands and outcomes as validation proceeds.

## Previously recorded evidence

- Wave 3: 12 Multirun tests passed.
- Wave 3: 7 Fusion tests passed.
- Wave 3: 22 background-work, session-status, and notification tests passed.
- Wave 3: TypeScript passed in the touched packages and `apps/web`.
- Wave 4: TypeScript passed in `apps/mobile` and `apps/web`.
- Wave 4: 19 targeted runtime, native-mobile, mobile-foundation, navigation,
  and recovery tests passed.
- Wave 4: `npm run build:mobile` passed and synchronized iOS and Android.
- Wave 4: Android Gradle configuration stopped because `ANDROID_HOME` and an
  Android SDK path were unavailable.
- Wave 4: iOS compilation and simulator/device QA were not run because this
  Linux environment has no Xcode or iOS SDK.

## Wave 5

- `7ecebe33 fix(mobile): harden native deep link parsing` was committed before
  this handoff. It bounds malformed percent-decoding and strips unsupported or
  credential-like query parameters from HTTPS app links.
- Additional Wave 5 commands and results: pending.
