---
name: polyth-packages
description: Build or extend Polyth feature packages through discovered entries, scoped services, supported UI seams and lifecycle cleanup.
---
# Feature package development

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context packages`. This command is a navigation aid, not an audit.

- `packages/example-feature/src/serverEntry.ts`
- `packages/plugins/src/serverPackage.ts`
- `packages/usage/widgets/index.tsx`
- `packages/web-sdk/src/index.ts`
- `docs/dev/README.md`
- `docs/agents/security.md`

## Workflow and constraints
Decide whether this is a feature package, infrastructure, host work or a shared contract. Extend the existing owner when its lifecycle and data boundary fit; do not manufacture a package for every helper. Read the target manifest and exports. Server and web entries are optional independently: the example-feature server example does not imply it contains browser UI.

Use `polyth.serverEntry` for discovered server registration and `polyth.webEntry` for browser activation. Resolve cross-package services lazily in an enable hook or handler: registration order is not dependency order. Validate tenant-owned IDs through `host.forSpace(rc.space)` before using append or any unscoped legacy handle. Persist package tenant state through `host.spaceStorage(rc.space)`.

Return and dispose registrations, timers, subscriptions, sockets and jobs in the correct lifecycle. Exercise disable/re-enable and failed enable, not just initial boot. A package may not impersonate another capability owner. Paired-device routes are default-deny; declare a reviewed `remoteAccess` policy rather than broadening the gateway.

The host owns window geometry and shared primitives; the feature owns content, service logic and scoped CSS. Register UI through web-sdk without hand-wiring App/Main or host registries. Copy only the minimal current pattern, not a sibling's entire implementation or undocumented imports. Changes to shared seams require consumer checks. Verify discovery, containment, enable/disable and ownership failures, then build the browser graph when web entries or exports change.

## Verification and handoff
Suggested test locations (confirm current files first): `apps/web/test/packageContainment.test.ts`; `packages/plugins/test/serverPackage.test.ts`; `packages/server/test/packageDiscovery.test.ts`

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
