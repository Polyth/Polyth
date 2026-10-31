---
name: polyth-build-release
description: Fix builds and CI or prepare releases using actual scripts and workflow ownership; preserve signing and publication approvals.
---
# Build failures, CI and releases

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context build-release`. This command is a navigation aid, not an audit.

- `package.json`
- `.github/workflows/ci.yml`
- `.github/workflows/build-apps.yml`
- `.github/workflows/release.yml`
- `.github/workflows/promote.yml`, `scripts/ci/promote-master.mjs` (`devel` → `master` promotion; `docs/operations/releases.md#branches-devel-and-master`)
- `.github/workflows/nightly.yml` (`devel` nightlies; `docs/operations/releases.md#nightly-builds-from-devel`)
- `scripts/ci/release-quality.mjs`
- `scripts/release-version.mjs` (validates the aligned version; `scripts/bump-version.mjs` computes and applies the next one — `docs/operations/releases.md#automatic-version-increment`)
- `scripts/ci/remote-build.mjs`, `scripts/ci/update-feed.mjs` (external builder targets and its desktop update feed; `docs/operations/releases.md#external-builder-feed`)
- `scripts/ci/mac-legacy.mjs` (the Intel macOS 12 package on Electron 43, target `mac-dmg-legacy`, feed `legacy-mac.yml`; `docs/dev/desktop.md#macos-12-build`)
- `Cargo.toml`
- `Dockerfile`, `deploy/docker/` and `docs/operations/docker.md` (server container image)
- `docs/agents/commands.md`
- `docs/agents/verification.md`

## Workflow and constraints
Read the actual package scripts, toolchain pins and owning workflow before suggesting a command. Root `build` is a web build, not native distribution. `mobile:sync` writes native generated files and is not an iOS archive. `build:link` builds the declared Rust executables; follow the current workflow for packaging and native test details.

Preserve the distinction between blocking validation, manual smoke builds and explicit release publication. `ci.yml` must stay cheap enough for PR/master; `build-apps.yml` must never publish; `release.yml` owns signing, updater metadata, GitHub Release creation, optional Play publication, optional npm publication and optional GHCR image publication. Never move signing/distribution onto ordinary pushes. `release.yml` does push its own version-bump commit to `master` before building, so the version every job packages is the version the tag names; that commit is its only write to `master`, it happens only after the release-quality gate passes, and the same job forwards the version to `devel`. `promote.yml` is the only other writer of `master`: it rebuilds it from `devel` without the `in-progress` packages and verifies the exact tree before a fast-forward push. `nightly.yml` publishes only `-nightly` prereleases and never prunes other releases.

For a dependency or Node/browser failure trace versions and exports first. Do not update lockfiles, globally install tools, use `npx` to fetch a missing package or add polyfills without a reviewed dependency need. An existing local TypeScript compiler is required for package typechecks; no root typecheck script should be invented.

Validate workflow syntax and trigger/concurrency/permission changes with their implications. Never expose secrets on fork PRs, echo signing material, publish tags/releases or run destructive release steps without authorization. Report local tests, hosted CI, unsigned build, signed build, upload and store review as separate results. Preserve unrelated workflows and include a minimal rerun path for an actual build regression.

## Verification and handoff
Suggested test locations (confirm current files first): Use the owning area and risk matrix; do not invent a test filename.

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
