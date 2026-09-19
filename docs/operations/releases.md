# Release operations

Polyth uses one aligned stable version across the applications and public SDK packages:

- root `package.json`
- `apps/mobile/package.json`
- `apps/desktop/package.json`
- `packages/contracts/package.json`
- `packages/package-sdk/package.json`

`scripts/release-version.mjs` validates the shared `X.Y.Z` version and exports the Android/iOS release metadata. Prerelease suffixes such as `1.2.3-beta.1` are intentionally rejected by the stable release flow.

## GitHub Actions structure

There are three permanent GitHub Actions workflows:

| Workflow | Trigger | Responsibility |
|---|---|---|
| `ci.yml` | PR, push to `master`, manual | Fast blocking repository validation |
| `build-apps.yml` | Manual only | Unpublished smoke/download artifacts |
| `release.yml` | Manual only, enforced `master` | Signed/publishable release artifacts and GitHub Release |

Application packaging never runs merely because code was pushed to `master`.

## CI

`ci.yml` runs the normal blocking validation:

- agent/repository guidance validation;
- production web build;
- TypeScript validation for the stable core/mobile baseline;
- deterministic release/workflow contract tests;
- Rust formatting, Clippy, and workspace tests.

Release packaging remains separate so ordinary pushes do not spend macOS/Windows/ARM runner time.

## Manual application builds

Use **Actions → Build apps → Run workflow**.

| Target | Output |
|---|---|
| `android-apk` | Installable debug APK |
| `ios-app` | Unsigned iOS Simulator `.app` ZIP |
| `mac-dmg` | Unsigned macOS x64 + arm64 DMG/ZIP pairs |
| `windows-exe` | x64 NSIS EXE |
| `linux-appimage` | x64 AppImage |
| `npm-packages` | `@polyth/contracts` + `@polyth/package-sdk` npm tarballs |
| `all` | Every target above |

These jobs use `--publish never`. They are for testing/downloading artifacts, not publishing a release.

## Manual release

Use **Actions → Release → Run workflow** from `master`.

The workflow refuses another branch and resolves the version from the aligned package manifests before spending release runners.

### Desktop

The release builds:

- Linux AppImage x64 + arm64;
- Windows signed NSIS x64 + arm64;
- signed/notarized macOS x64 + arm64 DMG/ZIP pairs.

The updater metadata is shipped alongside the installers:

- `latest.yml` — Windows x64;
- `latest-arm64.yml` — Windows arm64;
- `latest-mac.yml` — macOS x64 + arm64 files; the updater chooses the native architecture;
- `latest-linux.yml` and architecture-specific Linux metadata emitted by electron-builder.

After the deterministic release gate passes, the prepare job creates/reuses a **draft GitHub Release** for the aligned tag. The signed desktop jobs publish their binaries and electron-builder updater metadata into that draft. The final publish job reconciles every release artifact, performs optional external publication, and only then marks the release public. Desktop auto-update therefore never sees a half-uploaded release.

The desktop package updater points to **Polyth/Polyth**. Packaged clients with **Automatic updates** enabled check on startup and periodically, automatically download a discovered update, and install it on app quit/restart. Disabling Automatic updates preserves manual check/download behavior.

Required desktop release secrets:

- macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
- Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`

### Android

When the `android` input is enabled, Release builds a signed release APK and AAB.

Required secrets:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

`play_track` controls optional Google Play publication:

- `none` — build only;
- `internal` — publish completed internal release;
- `production` — upload as a production draft.

Google Play publication additionally requires `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.

### npm SDK packages

When `npm_packages` is enabled, Release packs:

- `@polyth/contracts`
- `@polyth/package-sdk`

The tarballs are also attached to the GitHub Release. `publish_npm=true` publishes those exact tarballs to npm with provenance after checking whether the same version already exists, making a release-job retry safe.

npm publication requires `NPM_TOKEN`.

Internal first-party workspaces are deliberately **not** bulk-published just because they lack `private: true`; the public npm release allowlist is explicit.

### iOS / TestFlight

The release workflow creates/reuses the stable `vX.Y.Z` tag together with the draft GitHub Release **after release validation but before the platform build fan-out**. Codemagic's `ios-testflight` workflow watches that tag and can build/upload TestFlight in parallel with the desktop/Android release jobs. The GitHub Release stays draft until the GitHub release pipeline succeeds, so desktop auto-update remains hidden while artifacts are incomplete.

Codemagic keeps one release-quality gate, then:

1. resolves the next App Store Connect build number;
2. syncs the quality-gated web build;
3. builds the native Polyth Link XCFramework;
4. signs the application;
5. uploads the IPA to TestFlight.

Production App Store review is still explicit and is not submitted automatically.

## Version metadata

Run locally:

```bash
node scripts/release-version.mjs
```

Exports:

| Variable | Purpose |
|---|---|
| `POLYTH_VERSION` | Stable semver without `v` |
| `POLYTH_RELEASE_TAG` | `vX.Y.Z` |
| `POLYTH_ANDROID_VERSION_CODE` | Android versionCode |
| `POLYTH_IOS_MARKETING_VERSION` | iOS marketing version |
| `POLYTH_IOS_CURRENT_PROJECT_VERSION` | iOS build number seed/override |

## Release checklist

1. Bump the aligned version in root, mobile, desktop, contracts, and package-sdk manifests (and update the lockfile).
2. Merge to `master` only after CI is green.
3. Run **Build apps** first when you only need smoke artifacts.
4. Run **Release** from `master` for an actual release.
5. Confirm desktop/macOS/Windows signing secrets before release.
6. Choose Android Play and npm publication explicitly.
7. Leave `draft=false` for a real release; this is the moment desktop auto-update becomes visible.
8. Monitor Codemagic/TestFlight after the release tag is created.
