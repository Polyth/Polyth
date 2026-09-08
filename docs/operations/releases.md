# Release operations

Polyth ships four release surfaces from an **aligned release version gate**: `package.json`, `apps/mobile/package.json`, and `apps/desktop/package.json` must all carry the same stable `X.Y.Z` semver. Tag releases use `vX.Y.Z` matching that version. `scripts/release-version.mjs` validates alignment and exports release metadata to GitHub Actions and Codemagic.

Prerelease suffixes (`1.2.3-beta.1`, `1.2.3+build`) are rejected for store releases.

## Version gate

Run locally:

```bash
node scripts/release-version.mjs
```

Exports (names only):

| Variable | Purpose |
|---|---|
| `POLYTH_VERSION` | Stable semver without `v` prefix |
| `POLYTH_RELEASE_TAG` | Tag form (`vX.Y.Z`) |
| `POLYTH_ANDROID_VERSION_CODE` | Bounded Android `versionCode` (`major*1_000_000 + minor*1_000 + patch + 1`, minor/patch ≤ 999) |
| `POLYTH_IOS_MARKETING_VERSION` | iOS `MARKETING_VERSION` |
| `POLYTH_IOS_CURRENT_PROJECT_VERSION` | iOS build number |

Tag validation runs only in real tag contexts (`GITHUB_REF_TYPE=tag`, `CM_TAG`). Manual desktop/Android builds derive version metadata without requiring a tag.

## GitHub Actions

| Workflow | Trigger | Role |
|---|---|---|
| `ci.yml` | PR, push to `master`, manual | Generic repository validation on Linux |
| `polyth-link.yml` | Link-related code paths, push to `master`, manual | Rust + Polyth Link contract tests only |
| `desktop-release.yml` | Tag `v*`, manual (`all`/`macos`/`linux`/`windows`) | Desktop packaging/releases |
| `android-release.yml` | Tag `v*`, manual | Signed Android AAB + optional Play upload |

Pull requests never build desktop installers, Android release AABs, or iOS archives.

### Generic CI (`ci.yml`)

- `npm ci`
- `npm run build:web`
- TypeScript checks (contracts, plugins, server, tunnel, terminal, mobile, desktop)
- Stable repository tests from `scripts/ci/select-tests.mjs ci` (excludes Polyth Link contract tests and known baseline-red workflow orchestration UI tests)
- `scripts/test/release-version.test.ts`

### Polyth Link CI (`polyth-link.yml`)

Does **not** repeat generic CI. It adds only:

- `cargo fmt`, `cargo clippy`, `cargo test`
- Polyth Link contract tests from `scripts/ci/select-tests.mjs polyth-link`

Documentation-only changes under `docs/**` do not trigger this workflow.

### Desktop release policy

| Context | Platforms | Signing | Publish |
|---|---|---|---|
| Tag `v*` | Linux + macOS universal; Windows only if `WIN_CSC_*` secrets exist | macOS required; Windows required when included | `electron-builder --publish always` to GitHub Releases |
| Manual dispatch | Selected target (`all` includes Windows even without signing secrets) | macOS/Windows signing required only for tagged releases | `--publish never`; 7-day GitHub artifacts |

Missing Windows signing credentials do **not** block macOS/Linux tag releases.

macOS tag releases still require all five macOS/notarization secrets.

### Android release policy

| Context | Build | Play upload |
|---|---|---|
| Manual, `publish=false` (default) | Signed AAB artifact | No |
| Manual, `publish=true`, `track=internal` | Signed AAB artifact | Internal track (`completed`) when `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` is set |
| Manual, `publish=true`, `track=production` | Signed AAB artifact | Production track as **draft** when service account is set |
| Tag `v*` | Signed AAB artifact | Internal track (`completed`) when service account is set |

A tag never publishes a live production Android release automatically.

### Required GitHub secrets

**Desktop (macOS tag releases):**

| Secret | Platform |
|---|---|
| `CSC_LINK` | macOS signing certificate (base64 `.p12`) |
| `CSC_KEY_PASSWORD` | macOS certificate password |
| `APPLE_ID` | Apple ID for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | Apple Developer team ID |

**Desktop (Windows tag releases, only when Windows is in the matrix):**

| Secret | Platform |
|---|---|
| `WIN_CSC_LINK` | Windows signing certificate (base64) |
| `WIN_CSC_KEY_PASSWORD` | Windows certificate password |

**Android:**

| Secret | Purpose |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | Release keystore (base64) |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Key alias |
| `ANDROID_KEY_PASSWORD` | Key password |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Optional Play Console API service account JSON |

Gradle reads signing paths from workflow env vars (`ANDROID_KEYSTORE_PATH`, etc.); those are not stored as secrets.

## Codemagic (iOS TestFlight)

Workflow: `ios-testflight` in `codemagic.yaml`.

| Setting | Value |
|---|---|
| Trigger | Tag matching `v*.*.*` |
| App Store Connect integration | `polyth-apple` |
| Bundle ID | `com.polyth.mobile` |
| Node | `22.14.0` (matches `.nvmrc`) |

Configure in Codemagic UI:

1. App Store Connect API integration named **`polyth-apple`**
2. iOS code signing for `com.polyth.mobile` (App Store distribution)
3. Environment group **`ios_config`** containing:
   - `APP_STORE_APPLE_ID` — numeric App Store Connect application ID (App Information → Apple ID)
4. Repository connected with tag-triggered builds

### iOS versioning behavior

- `MARKETING_VERSION` comes from `POLYTH_IOS_MARKETING_VERSION` (aligned package semver).
- `CURRENT_PROJECT_VERSION` is resolved at build time by `scripts/ci/resolve-ios-build-number.sh`:
  1. Requires `APP_STORE_APPLE_ID` from the `ios_config` group.
  2. Queries App Store Connect with `app-store-connect get-latest-testflight-build-number --silent` and `get-latest-app-store-build-number --silent` (stdout only; stderr is not captured).
  3. Uses **max(latest TestFlight, latest App Store) + 1**.
  4. Treats empty successful stdout as build number `0` before incrementing.
  5. Fails the build on any non-zero CLI exit or non-numeric stdout. Authentication, invalid application IDs, and API errors are never treated as “no previous builds”.
- Versions are injected through `xcodebuild` archive arguments. The Xcode project file is not mutated with `agvtool`.
- Publishing uploads the IPA to App Store Connect/TestFlight.
- `submit_to_testflight` (optional manual input `submitToBetaReview`) controls **beta review submission**, not the upload itself.
- `submit_to_app_store` remains `false`; production App Store review is never automatic.

## Release checklist

1. Bump stable `X.Y.Z` consistently in root, `apps/mobile`, and `apps/desktop` `package.json`.
2. Merge to `master` and confirm `ci.yml` is green.
3. Create and push annotated tag `vX.Y.Z`.
4. Monitor `desktop-release.yml`, `android-release.yml`, and Codemagic `ios-testflight`.
5. Verify GitHub Release assets (desktop), Play internal track (Android), and TestFlight build (iOS).
6. Promote to production manually in each store console.
