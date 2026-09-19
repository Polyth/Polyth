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
- `scripts/ci/release-quality.mjs`
- `scripts/release-version.mjs`
- `Cargo.toml`
- `codemagic.yaml`
- `docs/agents/commands.md`
- `docs/agents/verification.md`

## Workflow and constraints
Read the actual package scripts, toolchain pins and owning workflow before suggesting a command. Root `build` is a web build, not native distribution. `mobile:sync` writes native generated files and is not an iOS archive. `build:link` builds the declared Rust executables; follow the current workflow for packaging and native test details.

Preserve the distinction between blocking validation, manual smoke builds and explicit release publication. `ci.yml` must stay cheap enough for PR/master; `build-apps.yml` must never publish; `release.yml` owns signing, updater metadata, GitHub Release creation, optional Play publication and optional npm publication. Never move signing/distribution onto ordinary pushes.

For a dependency or Node/browser failure trace versions and exports first. Do not update lockfiles, globally install tools, use `npx` to fetch a missing package or add polyfills without a reviewed dependency need. An existing local TypeScript compiler is required for package typechecks; no root typecheck script should be invented.

Validate workflow syntax and trigger/concurrency/permission changes with their implications. Never expose secrets on fork PRs, echo signing material, publish tags/releases or run destructive release steps without authorization. Report local tests, hosted CI, unsigned build, signed build, upload and store review as separate results. Preserve unrelated workflows and include a minimal rerun path for an actual build regression.

## Verification and handoff
Suggested test locations (confirm current files first): Use the owning area and risk matrix; do not invent a test filename.

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
