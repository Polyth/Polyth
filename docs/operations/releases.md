# Release operations

Polyth keeps application version metadata behind an **aligned release version gate**: `package.json`, `apps/mobile/package.json`, and `apps/desktop/package.json` must all carry the same stable `X.Y.Z` semver. `scripts/release-version.mjs` validates alignment and exports release metadata to build tooling. GitHub Actions packaging is manual-only; the signed iOS TestFlight path in Codemagic still uses `vX.Y.Z` tags.

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

GitHub Actions intentionally exposes only two workflows.

| Workflow | Trigger | Role |
|---|---|---|
| `ci.yml` | Pull request, push to `master`, manual | Repository validation |
| `build-apps.yml` | Manual only | Build downloadable application artifacts |

No application packaging or publishing is triggered by a push to `master` or by a Git tag.

### CI (`ci.yml`)

Every pull request and every push to `master` runs:

- agent-knowledge structure and installer tests;
- the shared repository quality contract from `scripts/ci/release-quality.mjs`:
  - web production build;
  - TypeScript checks for the owned application projects;
  - stable repository tests;
  - Polyth Link contract tests;
- Rust `fmt`, `clippy`, and workspace tests.

This is the normal merge/master quality gate. Heavy application packaging is deliberately separate.

### Manual application builds (`build-apps.yml`)

Use **Actions → Build apps → Run workflow** and choose one target:

| Target | Runner | Output |
|---|---|---|
| `android-apk` | Ubuntu | Installable debug APK |
| `ios-app` | macOS | Unsigned iOS Simulator `.app` zipped as an artifact |
| `windows-exe` | Windows | x64 NSIS `.exe` installer |
| `linux-appimage` | Ubuntu | x64 AppImage plus packaged-app smoke evidence |
| `all` | Mixed | All four targets above |

These jobs use `--publish never` where electron-builder is involved and never upload to GitHub Releases, Google Play, or the App Store. Artifacts are retained by GitHub Actions for 14 days.

The iOS GitHub artifact is intentionally unsigned and simulator-only. The signed IPA/TestFlight path remains Codemagic. Android Play publication and signed desktop release publication are not automated by the current GitHub Actions set; adding either requires an explicit release workflow rather than overloading the build workflow.

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

1. Bump stable `X.Y.Z` consistently in root, mobile, and desktop `package.json`.
2. Merge to `master` only after `ci.yml` is green.
3. When you need downloadable smoke artifacts, run `build-apps.yml` manually for the required target.
4. For a signed iOS/TestFlight build, create the matching `vX.Y.Z` tag and monitor Codemagic `ios-testflight`.
5. Treat store publication and signed desktop distribution as explicit operator actions until dedicated release workflows are intentionally added.
