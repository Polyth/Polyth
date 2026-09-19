---
name: polyth-desktop
description: Develop Electron shell, preload, bundled server lifecycle and desktop distribution without exposing native authority to the renderer.
---
# Desktop shell and distribution

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context desktop`. This command is a navigation aid, not an audit.

- `apps/desktop`
- `docs/dev/desktop.md`
- `.github/workflows/build-apps.yml`
- `docs/agents/verification.md`

## Workflow and constraints
Identify which process owns the behavior: Electron main, preload, renderer, local server, bundled backend or release tooling. Shared web UI remains in the host/package web layer. Do not add renderer Node access to work around a missing browser-safe API; extend the narrow supported bridge only for a demonstrated native need.

Validate IPC payloads, navigation targets and local paths. Keep authentication, secrets and arbitrary filesystem/process authority out of the renderer. A loopback service is not automatically safe against another local process or an untrusted web page. Preserve owned-process cleanup, port/data-directory isolation, single-instance behavior and platform-specific startup.

When changing package discovery or manifests, inspect desktop's packaged server inventory too. A package present in a development workspace may be missing from a bundled release. Confirm native binaries, resources, executable permissions and architecture-specific assets without downloading or executing untrusted binaries by default.

Use the current manual build workflow and desktop guide for signing, notarization and artifact operations. Build, unsigned package, signed distribution and launched-app smoke are different verification levels. Do not publish releases, consume signing credentials or rotate updater settings as an incidental implementation step. Test macOS, Windows and Linux-specific behavior only where evidence exists, and state untested platforms. Preserve user data paths and provide migration/rollback guidance for any persisted settings change.

## Verification and handoff
Suggested test locations (confirm current files first): `apps/desktop/test/configuration.test.ts`; `apps/desktop/test/serverPackages.test.ts`

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
