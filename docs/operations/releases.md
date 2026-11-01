# Release operations

Polyth uses one aligned stable version across the applications and public SDK packages:

- root `package.json`
- `apps/mobile/package.json`
- `apps/desktop/package.json`
- `packages/contracts/package.json`
- `packages/package-sdk/package.json`

`scripts/release-version.mjs` validates the shared `X.Y.Z` version and exports the Android/iOS release metadata. Prerelease suffixes such as `1.2.3-beta.1` are intentionally rejected by the stable release flow.

## Automatic version increment

`scripts/bump-version.mjs` computes and applies the next aligned version across the five manifests
and the matching `package-lock.json` entries, so a release never needs hand-edited numbers. The rule
is fixed:

| Commits since the last stable tag | Increment |
|---|---|
| a breaking change (`type!:` or a `BREAKING CHANGE:` trailer) while major is ≥ 1 | major |
| a breaking change while major is 0 (0.x carries no stability promise) | minor |
| `feat` | minor |
| anything else (`fix`, `perf`, `refactor`, `docs`, `chore`, …) | patch |

The base version is the higher of the checked-in manifests and the highest stable tag ever
published, so a bump can never move the version backwards. The Android `versionCode` domain
(`minor` and `patch` ≤ 999) is enforced before anything is written. A manifest set that already
disagrees, a lockfile npm would reformat, or an edit that would touch more than the version fields
all fail the bump instead of producing a half-updated tree.

When `auto` finds nothing new since the last stable tag and the manifests already carry that
version, it keeps the version: retrying a release whose later job failed reuses the same version
instead of consuming the next one.

```bash
npm run version:bump -- --dry-run            # print the next version, change nothing
npm run version:bump -- --bump auto --json   # apply the deterministic increment
npm run version:bump -- --bump patch         # force a level: patch | minor | major
npm run version:bump -- --set 1.2.0          # or set an exact version
```

`--bump auto` reads git history and tags; the explicit levels, `--set` and `--bump none` work
without a repository. When `GITHUB_ENV` or `GITHUB_OUTPUT` is set the script exports
`POLYTH_VERSION`, `POLYTH_PREVIOUS_VERSION`, `POLYTH_BUMP_LEVEL` and `POLYTH_VERSION_CHANGED`.

## Branches: devel and master

| Branch | Holds | Receives | Builds |
|---|---|---|---|
| `devel` | Every package, previews included | Pull requests and direct development | [Nightly](#nightly-builds-from-devel) prereleases |
| `master` | The release line: every package except the unfinished previews | Only promotions from `devel` (and the release workflow's version bump) | Test and stable releases (`release.yml`, the external builder) |

A package's place is decided by `polyth.descriptor.maturity` in its manifest
([package structure](../../.agents/skills/polyth-packages/package-structure.md#2-one-source-of-truth-per-fact-dry-rules)):
`maturity: "in-progress"` packages stay on `devel`; `beta` previews and finished
packages ship on `master`. Graduating a package from `in-progress` is what
brings it to `master` at the next promotion.

**Promotion** (Actions → *Promote devel to master*, `promote.yml`) rebuilds
`master` from a `devel` commit with `scripts/ci/promote-master.mjs`:

1. `check-drift` refuses to continue when `master` changed since the previous
   promotion in a way `devel` does not carry (a hotfix made directly on
   `master`): forward it to `devel` first, or it would be lost.
2. `apply` deletes the folders of the devel-only packages (each is one
   removable folder, `scripts/test/packageRemovability.test.ts`), drops their
   `!packages/<id>` workspace negations, prunes `package-lock.json` through
   `npm install --package-lock-only` (which must settle on a second pass),
   regenerates the i18n wiring and removes their paths from the
   `docs/agents` navigation maps. It refuses when a kept package depends on a
   devel-only one.
3. The result is committed with the previous `master` and the `devel` commit
   as parents and a `Promoted-from: <devel sha>` trailer, reinstalled with
   `npm ci`, and verified (i18n check, package removability, agent kit,
   web build, `release-quality.mjs`) before the fast-forward push to `master`.
   The `push` input off runs the same verification without moving `master`.

Run `node scripts/ci/promote-master.mjs plan` to see what a promotion would
leave on `devel`. Fixes land on `devel` and reach `master` with the next
promotion; only the release workflow writes to `master` directly, and it
forwards its version bump to `devel` ([manual release](#manual-release)).

## GitHub Actions structure

There are five permanent GitHub Actions workflows:

| Workflow | Trigger | Responsibility |
|---|---|---|
| `ci.yml` | Push to `devel`/`master`, pull request to them, manual | Repository validation |
| `promote.yml` | Manual only | Rebuild `master` from `devel`, verify, fast-forward |
| `nightly.yml` | Schedule/dispatch once enabled, manual | `devel` nightly prereleases; manual `test`/`stable` update-feed releases |
| `build-apps.yml` | Manual only | Unpublished smoke/download artifacts |
| `release.yml` | Manual only, enforced `master` | Signed/publishable release artifacts and GitHub Release |

Application packaging never runs merely because code was pushed to `devel` or `master`.

## CI

`ci.yml` has two jobs:

- **Smoke**, on every push and pull request: production web build and the
  streaming/sync tests.
- **Full verification**: agent/repository guidance validation, the deterministic
  `release-quality.mjs` gate (web build, owned TypeScript projects,
  release/workflow contract tests, Polyth Link tests), Rust formatting, Clippy
  and workspace tests. It runs on manual dispatch with `full=true` and, once the
  repository is public, on every push and pull request; while the repository is
  private it stays manual to bound the Actions budget.

Pull requests from forks run with a read-only token and no secrets. The
repository variable `CI_DISABLED=1` stops both jobs before a runner starts.
Release packaging remains separate so ordinary pushes do not spend macOS/Windows/ARM runner time.

## Manual application builds

Use **Actions → Build apps → Run workflow**.

| Target | Output |
|---|---|
| `android-apk` | Installable debug APK |
| `ios-app` | Unsigned iOS Simulator `.app` ZIP |
| `mac-dmg` | Signed + notarized macOS x64 DMG and arm64 DMG (separate artifacts) |
| `windows-exe` | x64 NSIS EXE |
| `linux-appimage` | x64 AppImage |
| `npm-packages` | `@polyth/contracts` + `@polyth/package-sdk` npm tarballs |
| `docker_x64` / `docker_arm64` | Smoke-tested Docker image as a `docker save` archive; `docker_browser` builds the Chromium variant |
| `all` | Every target above |

These jobs use `--publish never`. They are for testing/downloading artifacts, not publishing a release. The manual `mac-dmg` target still signs and notarizes its two DMGs so downloaded apps pass Gatekeeper; it does not create updater ZIPs.

## Manual release

Use **Actions → Release → Run workflow** from `master`.

The workflow refuses another branch and resolves the version from the aligned package manifests before spending release runners.

Its `bump_version` input decides the version: `auto` (default) applies the
[deterministic increment](#automatic-version-increment) for the Conventional Commits since the last
stable tag, `patch`/`minor`/`major` force that level, and `none` releases exactly the version
`master` already declares. When the input is not `none`, the prepare job bumps the manifests, runs
the release-quality gate, and only then commits `chore(release): vX.Y.Z`, pushes it to `master` and
tags that commit — so every build job checks out the version it packages. A failing gate stops
before anything is pushed. The push needs a workflow token permitted to write `master`; a branch
protection rule that requires a pull request fails the release with that message. Re-dispatching
after a failed run reuses the version the pushed bump commit already carries, so no version is spent
unless its tag was created.

Because `master` is rebuilt from `devel` on every [promotion](#branches-devel-and-master), the
prepare job then applies the same version to `devel` (`bump-version.mjs --set`) and pushes it, so
nightlies and the next promotion continue from the released version. That step is best effort: when
`devel` already declares the version or newer it does nothing, and when it cannot push it warns with
the command to run by hand (`npm run version:bump -- --set X.Y.Z` on `devel`); the release goes on.

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

The desktop package updater points to **Polyth/Polyth** by default; builds from the [external builder](#external-builder-feed) point to the builder repository instead. Packaged clients with **Automatic updates** enabled check on startup and periodically, automatically download a discovered update, and install it on app quit/restart. Disabling Automatic updates preserves manual check/download behavior. A found, downloading or ready update is also announced by a card in the main window (see [Desktop](../dev/desktop.md#release-and-updates)).

Required desktop signing secrets (used by both `Build apps → mac-dmg` and `Release`):

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

### Docker images

When `docker_image` is enabled, Release builds the `polyth` and `polyth-browser` targets natively on x64 and arm64 runners, runs `deploy/docker/smoke.sh` against each, and pushes them to `ghcr.io/<owner>/polyth` by digest only. After the publish job succeeds, `docker-publish` creates the multi-arch tags: `X.Y.Z` + `latest` and `X.Y.Z-browser` + `browser`. A draft release gets only the version tags. Uses the workflow `GITHUB_TOKEN` with `packages: write`; no extra secret. See [Running Polyth in Docker](docker.md).

### iOS / TestFlight

Signed iOS is built by the [external builder](#external-builder-feed), not by a
separate service, and runs as part of every `all` build of each [release channel](#release-channels). `buildIos()` in
`scripts/ci/remote-build.mjs` produces a signed `.ipa` only when every App Store
Connect secret is present; otherwise it falls back to the unsigned simulator
archive. The signing commands come from `codemagic-cli-tools`, a pip package the
builder workflow installs into a venv, so `keychain`, `app-store-connect`, and
`xcode-project` run on a plain macOS runner.

The `ios-app` job runs on GitHub's `xcode-27` image (macOS 27), the only one
carrying Xcode 27.1. That SDK is the floor for iPhone Duo: an app built with an
older SDK runs there in a 375×667 pt phone window on both displays, and from
April 2027 App Store submissions need Duo screenshots. The builder's
`POLYTH_IOS_XCODE_VERSION` repository variable and its `ios-app` runner label
must move together; the *Select pinned Xcode* step fails a signing run whose
runner lacks `/Applications/Xcode_<version>.app`.

The nightly signed path, in order:

1. installs dependencies, builds and syncs the web bundle (`npm run build:mobile`) and builds the native Polyth Link XCFramework;
2. asserts the pinned Xcode version (`POLYTH_IOS_XCODE_VERSION`, default `27.1`);
3. resolves the next App Store Connect build number;
4. fetches/creates signing files and signs the application; the Notification Service Extension is best effort, so the app ships without it when its signing files or its archive fail;
5. verifies the archive carries an `Apple Distribution` signature;
6. uploads the IPA to App Store Connect for internal TestFlight testers;
7. on manual `test` and `stable` runs only, `scripts/ci/testflight-distribute.mjs` waits for Apple to finish processing the build — looked up by build number *and* marketing version, since concurrent `test` and `stable` runs can upload the same build number for two versions — (up to `POLYTH_IOS_TESTFLIGHT_WAIT_MINUTES`, default 45), fills an empty *What to Test* (`POLYTH_IOS_WHATS_NEW`, locale `POLYTH_IOS_TESTFLIGHT_LOCALE`, default `en-US`), submits it for external beta review and adds it to every beta group: external groups and internal groups without access to all builds (internal groups with that access get it automatically). A failure there fails the `ios-app` job after the upload.

The external builder's nightly does not run the release-quality gate (`scripts/ci/release-quality.mjs`); `ci.yml` *Full verification*, `promote.yml`, `release.yml` and the `verify` job of [`nightly.yml`](#nightly-builds-from-devel) do. A builder nightly therefore signs and uploads whatever its source ref builds, so run the gate before the 06:00 dispatch (see [Preparing the nightly](#preparing-the-nightly)).

Required secrets: `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_IDENTIFIER`,
`APP_STORE_CONNECT_PRIVATE_KEY`, `CERTIFICATE_PRIVATE_KEY`, `APP_STORE_APPLE_ID`.
Set all five or none; a partial set fails the build instead of silently shipping
an unsigned archive.

The nightly does **not** submit for external beta review — that would send a build
to Apple review every night. To reach external testers, run a manual `test` (or
`stable`) builder run; `POLYTH_IOS_TESTFLIGHT_EXTERNAL=1`/`0` in the job environment
overrides the channel rule. Apple reviews one build per version at a time: while
an earlier build is waiting for beta review, the submission fails with
`ANOTHER_BUILD_IN_REVIEW` (the job names the blocking build; internal groups still
get the new build). Then run the builder's distribute-only **`testflight`** target
(any channel): it rebuilds nothing, takes the newest upload, retries the
submission for up to `POLYTH_IOS_TESTFLIGHT_REVIEW_WAIT_MINUTES` (default 75) and
adds it to every group. Setting the builder repository variable
`POLYTH_IOS_TESTFLIGHT_SUPERSEDE=1` instead expires older builds still waiting for
review so the newest goes in at once. Apple reviews the first build of each marketing
version (usually within a day; later builds are often approved at once); external
testers see the build only after approval. The app's beta review contact details
and test information must already be filled in App Store Connect, or the
submission fails with Apple's error in the job log. Production App Store review
stays explicit.

## Nightly builds from devel

`nightly.yml` builds `devel` and publishes it as a `vX.Y.N-nightly` prerelease of this repository,
the feed of desktop clients on the **Nightly** [channel](#release-channels). It reuses the external
builder's scripts (`remote-build.mjs`, `update-feed.mjs`, `release-notes.mjs`) on this repository's
own runners; no deploy key or second repository is involved.

- **Off until enabled.** Scheduled and dispatched runs start only when the repository variable
  `POLYTH_NIGHTLY` is `1`; a manual **Actions → Nightly → Run workflow** always works (any ref,
  one target or `all`). Enable it once the repository is public: private-repository macOS and
  Windows minutes are expensive, and while the external builder still publishes nightlies, two feeds
  would compete.
- **Triggers.** Three schedule slots (05:17, 09:47, 14:17 Kyiv) and `repository_dispatch` type
  `nightly` (`client_payload.ref` overrides `devel`). Only the first run of each Kyiv day that did
  not fail builds, and a `devel` commit that the newest nightly already holds (its release-notes
  source marker) is not rebuilt.
- **Gate.** The `verify` job runs `release-quality.mjs` on the exact commit first; a red gate
  publishes nothing.
- **Version.** `X.Y.Z` from the `devel` manifests plus build number `N` = run number +
  `POLYTH_NIGHTLY_BUILD_OFFSET` (repository variable, default `0`) gives `X.Y.N-nightly`; `N` must
  exceed `Z` and stay ≤ 999 (Android `versionCode`), so raise the offset when a patch release
  outruns the run number. The public repository starts with the offset above the external
  builder's newest build number (set at the cutover), because installed builder builds never
  downgrade; every scheduled slot, skipped or not, consumes a run number.
- **Publication.** Only a full (`all`) run publishes: draft, upload, then public prerelease, never
  marked Latest. The three newest nightlies are kept; stable and test releases are never pruned here.
- **Test and stable.** A manual run with `channel` `test` or `stable` (set `ref` to `master`) builds
  the same way and publishes `vX.Y.N-beta` (prerelease; the three newest are kept) or `vX.Y.N`
  (marked **Latest**, never pruned), sharing the build-number sequence, so every channel's build is
  newer than the last. These runs do not submit to TestFlight external testing; `release.yml` stays
  the signed manifest-versioned release path.
- **Signing.** The same secrets as the builder sign macOS (`CSC_LINK`, `CSC_KEY_PASSWORD`,
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) and iOS/TestFlight (the five App
  Store Connect secrets under [iOS / TestFlight](#ios--testflight)); without them the builds are
  ad-hoc signed and the iOS job produces a simulator archive.

## External builder feed

Until `Polyth/Polyth` became public (2026-10-31), its GitHub Releases could not serve unauthenticated desktop clients, so builds produced by the external builder repository update from that repository's public GitHub Releases instead; installed builder builds keep that feed until a builder release built with the repository variable `POLYTH_UPDATE_REPOSITORY=Polyth/Polyth` moves them over. Its scheduled nightly builds the ref its dispatch names, `devel` by default, and its manual `test` and `stable` runs build `master` by default; once this repository is public, [`nightly.yml`](#nightly-builds-from-devel) takes over the `devel` nightly and the builder is no longer needed for it. The builder's workflow (it lives in the builder repository and fetches this source with a deploy key) runs `scripts/ci/remote-build.mjs` per target with:

| Variable | Effect |
|---|---|
| `POLYTH_UPDATE_REPOSITORY` | `owner/repo`; electron-builder `publish` → GitHub provider for that repository, baked into the packaged `app-update.yml`. The desktop jobs also collect `latest.yml`, `latest-linux.yml`, a per-architecture `latest-mac.<arch>.partial.yml`, the macOS update `.zip` and blockmaps, and fail if any is missing. |
| `POLYTH_BUILD_NUMBER` | The workflow run number becomes the packaged patch version: manifest `X.Y.Z` + run `N` → `X.Y.N` (N must exceed Z). Every build is therefore newer than the previous one, whatever its channel. `release-version.mjs` applies the same rule, so the iOS marketing version and the Android `versionName`/`versionCode` move with it. The manifests themselves are not changed. |
| `POLYTH_RELEASE_CHANNEL` | `stable` (default), `test` or `nightly`; see [Release channels](#release-channels). Test and nightly append a semver prerelease id to the version: `X.Y.N-beta`, `X.Y.N-nightly`. |
| `POLYTH_GOOGLE_BUILTIN_CLIENT_ID`, `POLYTH_GOOGLE_BUILTIN_CLIENT_SECRET` | Polyth's own Google app (a Desktop OAuth client). `apps/desktop/build.ts` bakes them into the packaged server, so users connect Google without a Google Cloud client of their own; see [Google OAuth clients](../../packages/google/README.md#oauth-clients). Unset = no built-in app. The builder workflow does not pass them yet: it needs repository secrets of these names mapped into the desktop jobs' environment. |

With both variables unset, `remote-build.mjs` produces the same plain smoke artifacts as before.

### Web download section

The running server also reads `POLYTH_UPDATE_REPOSITORY` (runtime environment, not only at build time). When it is `owner/repo`, `GET /api/system/releases` asks the GitHub API for `releases/latest`, filters the payload to the installer assets the feed publishes (`-win-x64.exe`, `-mac-<arch>.dmg`, `-linux-<arch>.AppImage`, `-android.apk`; update metadata and blockmaps are excluded), caches the successful result for ten minutes, and returns it as a bounded DTO. The Settings → About page shows the per-platform links and hides the section entirely when the variable is unset, the lookup fails, or the client is the packaged desktop app. The same repository is used by every channel — the section follows whatever GitHub marks Latest, so it lists stable downloads while desktop clients keep their own channel updater.

After a full (`target=all`) build, the builder's `publish` job runs `node scripts/ci/update-feed.mjs assemble <products> <feed>`. That command merges the two macOS partials into one `latest-mac.yml`, copies only the files the metadata references (plus their blockmaps) and the Android debug APK as `Polyth-<version>-android.apk` (left out, without blocking, when the Android job failed), adds the channel copies of the metadata (below), adds the [macOS 12 build](../dev/desktop.md#macos-12-build)'s `legacy-mac.yml` and its files when the `mac-dmg-legacy` job produced them (no channel copies; a missing one is a workflow warning, never a blocker, and macOS 12 clients then wait for a later stable release), and refuses an incomplete desktop set, mismatched versions, or a version that does not belong to the run's channel. The job writes the [release notes](#release-notes), uploads into a draft release, publishes it, and keeps the three newest releases **of each channel**. A failed non-desktop target (Android/iOS/npm) does not block publication. A missing desktop platform does block it.

The plan job resolves the source ref to one commit (`git ls-remote` with the deploy key; a 40-character SHA is used as is) and every job builds that commit, so a moving branch cannot mix sources within a run.

### Release channels

| Channel | Trigger | Version / tag | GitHub release | Desktop metadata |
|---|---|---|---|---|
| Nightly | Automatic: `nightly.yml` schedule 05:17/09:47/14:17 Kyiv or `repository_dispatch` (first successful run of the Kyiv day only) | `X.Y.N-nightly` | prerelease | `latest*.yml` + `nightly*.yml` |
| Test | Manual: **Actions → Nightly → Run workflow**, channel `test`, ref `master` | `X.Y.N-beta` | prerelease | `latest*.yml` + `beta*.yml` |
| Stable | Manual: **Actions → Nightly → Run workflow**, channel `stable`, ref `master` | `X.Y.N` | release, marked **Latest** | `latest*.yml` + `beta*.yml` |

The manual form also takes `ref` (default `devel`; use `master` for `test` and `stable`) and `target`; only `target=all` publishes a release. A manual `nightly` run is for retrying a failed nightly and is not deduplicated. Every channel's `ios-app` job uploads to TestFlight; only the external builder's `test` and `stable` runs also distributed to external testers ([iOS / TestFlight](#ios--testflight)). Releases from before the channel split (`v0.1.132`–`v0.1.137`, plain `X.Y.N`) count as stable.

The desktop app follows the channel chosen in **Settings → Desktop → Update channel**; until the user picks one, a build follows the channel it was published on (its version's prerelease id; `apps/desktop/src/updaterChannel.ts`). electron-updater's GitHub provider gives the channels their semantics:

- **Stable** — prereleases off; reads `/releases/latest`, which only a stable release becomes.
- **Test** — prereleases on, updater channel `beta`: the newest `-beta` *or* stable release in the releases Atom feed. Stable releases carry `beta*.yml` for these clients.
- **Nightly** — prereleases on, custom channel `nightly`: only `-nightly` releases.

Downgrades stay off, so switching to a channel whose newest build is older waits for that channel's next release. Installs built before the split (`0.1.137` and older) only check stable and stay put until the first stable release. The Atom feed lists about ten releases; per-channel pruning to three keeps every channel's newest release in it. Windows arm64 keeps its `latest-arm64` metadata on stable only; the builder does not produce Windows arm64. The macOS 12 build (`legacy-mac.yml`) follows stable releases only, whatever its channel setting says; see [Desktop](../dev/desktop.md#macos-12-build).

### Preparing the nightly

The nightly build compiles whatever is on its source branch at 06:00 Kyiv — `devel` for both [`nightly.yml`](#nightly-builds-from-devel) and the external builder — so source readiness is decided the night before. The captain template below names `master`, the branch most projects build from; this repository's captain has its charter edited to verify and push `devel` instead, and never pushes `master`, which only [promotion](#branches-devel-and-master) and the release workflow write. The `@polyth/agents` **Agents** feature ships a *Nightly release captain* template that owns the night's unmerged work, pushes verified green `master` before release, and leaves the source ready for the scheduled nightly build and night release: it inspects every open session and isolated worktree, judges and criticises each one against its actual diff, finishes or discards the ones it can settle, merges completed work and de-isolates and archives it, keeps a decision that genuinely needs a person by pinning that session with the options written down, makes small reversible fixes and missing tests, delegates bounded work to Polyth subagents, verifies the blocking gates the nightly runs, and pushes `master` to `origin` once all gates are green. Its charter is a starting point each project reviews and edits in the agent editor; it never signs or publishes, and it does not replace explicit release authorization or the decision to ship.

The captain's authority is deliberately wider than an ordinary session's: it works in the project's own sessions and may commit and merge unmerged work, and pushes verified green `master` to origin for the scheduled nightly build, because leaving finished work unmerged or unpushed is the defect it exists to remove. It must therefore leave nothing behind — every session it touched ends merged and archived, pinned for a person, discarded on purpose, or reported as blocked. Signing, publishing, live-data migration and weakening a security bound or a test remain the person's decisions.

One tool boundary currently bounds that authority: `agent.merge`, `agent.discard` and `agent.resolve` accept only a session the caller itself spawned (`sessionControlTool.ts`, the `session.parentId !== ctx.sessionId` guard), so the captain cannot merge or de-isolate an isolated worktree that belongs to another top-level session. For such a session the captain reviews the diff, reports it, and either delegates a child it owns to carry the work to `master` or records the pending decision for a person; it does not leave the claim that it merged work it cannot reach.

Create it from **Agents → Templates → Nightly release captain** (or start empty and pick the template). It replaces the earlier *Nightly reviewer* template, which only reviewed merged pull requests. Its defaults: daily at 02:30 local time, one rolling conversation, at most 2 runs a day, catch up once after downtime, skip an overlapping run, pause after 2 consecutive failures, decline a request nobody answers within 20 minutes so the run still reports, and notify on every finished run.

### Release notes

`node scripts/ci/release-notes.mjs` writes each release's body (and `title=Polyth X.Y.N · <Channel>` to `$GITHUB_OUTPUT`); the publish job fetches the source with full blob-less history for it.

- **Range**: from the previous release of the channel (nightly → nightly; test → test or stable; stable → stable; a channel's first release → the newest older release of any channel) up to the built commit. Each body ends with a hidden `<!-- polyth-release: channel=… source=<sha> -->` marker, which gives the next release its exact range. Without a usable marker it falls back to the previous release's publication date, then to the newest 50 commits.
- **Sections**: ✨ New, 🚀 Improvements, 🐛 Fixes and a collapsed 🧰 Under the hood, from the conventional-commit type (`feat`, `fix`, `perf`, `docs`, `ci`…), else the subject's leading verb (`Add`, `Fix`/`Stop`/`Keep`, `Document`/`Type`…, Ukrainian `Додай`/`Виправ…` too), else Improvements. A commit that touches only docs, tests, `.agents`, `.github` or Markdown is Under the hood. Each entry carries the first sentence of the commit body. Merge, WIP and `fixup!` commits and repeated subjects are dropped.
- **Contributors**: every human author and `Co-authored-by` trailer, merged by email or exact name through the repository `.mailmap`, counted once per commit, most active first. A `users.noreply.github.com` address becomes an @-mention. AI co-authors (Claude, Cursor, Codex, OpenCode…) are credited separately; bots are skipped. Add new contributor addresses to `.mailmap` to merge identities or get an @-mention.

The builder only sees **pushed** source: `devel` for nightlies, `master` for test and stable runs. Push the source changes before relying on a new builder workflow: an older source has no `update-feed.mjs`, so its publish job fails.

Platform behaviour of feed builds:

- **Windows** (unsigned NSIS) and **Linux** (AppImage) download and install in place, as with official releases.
- **macOS** builds are Developer ID signed and notarized when the builder has all of `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (a partial set fails the build). Notarization runs in `scripts/ci/mac-notarize.mjs` (an `afterSign` hook, not electron-builder's `mac.notarize`): a rejected submission fails the build, while stapling retries for about seven minutes and then ships the notarized app unstapled with a workflow warning, because the Intel runners intermittently cannot reach Apple's ticket service. Such builds install in place. Without those secrets the builds are ad-hoc signed and cannot be installed in place: the app reports the new version, and **Download** opens the release page (see [Desktop](../dev/desktop.md#release-and-updates)). A running ad-hoc build stays in that manual mode, so moving to signed builds needs one manual reinstall.
- Installs that predate the feed (version `0.1.0`) look for updates in `Polyth/Polyth`, whose releases were private then and hold none of the feed builds; they need one manual reinstall from the feed.
- Android and iOS have no in-app update path from this feed. The release's `Polyth-<version>-android.apk` is a debug build, installed by hand; iOS ships through TestFlight.

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

0. Let the *Nightly release captain* agent (see [Preparing the nightly](#preparing-the-nightly)) leave the nightly source branch green and pushed before the 06:00 Kyiv nightly dispatch.
1. Promote the `devel` commit to release with **Promote devel to master** ([branches](#branches-devel-and-master)) only after CI on `devel` is green; a refused drift check means a `master` hotfix must reach `devel` first.
2. Leave `bump_version` on `auto` for the deterministic increment (or force `patch`/`minor`/`major`; use `none` to release the version already on `master`). The workflow applies the aligned version, pushes the bump commit itself and forwards it to `devel` — do not edit the manifests by hand.
3. Run **Build apps** first when you only need smoke artifacts.
4. Run **Release** from `master` for an actual release.
5. Confirm desktop/macOS/Windows signing secrets before release.
6. Choose Android Play and npm publication explicitly.
7. Leave `draft=false` for a real release; this is the moment desktop auto-update becomes visible.
8. Monitor the nightly run (the external builder's until the cutover) and TestFlight processing; promote with a manual `test`, then `stable`, builder run.
