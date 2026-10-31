---
name: polyth-web-ui
description: Implement Polyth surfaces, widgets, settings and workbench UI without leaking feature ownership into the generic host.
---
# Web UI, widgets and workbench

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context web-ui`. This command is a navigation aid, not an audit.

- `packages/usage/widgets/index.tsx`
- `packages/web-sdk/src/index.ts`
- `apps/web/test/packageContainment.test.ts`
- `docs/dev/ui.md`
- `docs/dev/widgets.md`
- `docs/dev/components.md`

## Workflow and constraints
Choose the existing extension seam by behavior: feature content/surface, widget, slot, settings page, resource view or command. Verify its current web-sdk signature and a live registration. Do not invent a new surface API from historical screenshots or old architecture prose. Packages provide content and metadata; the host owns layout, focus, global geometry and window modes.

Read `GENERIC_SHELL_IMPORTS` and `GENERIC_PACKAGE_IMPORTERS` at their source only when a boundary import is needed. They are controlled exceptions, not instructions to couple every feature to the shell. Never expand an allowlist to conceal feature leakage. Keep CodeMirror behind the editor package's lazy boundary. Avoid pulling Node modules through a package root barrel into browser code; type-only imports do not justify unsafe runtime imports.

Use stable registration IDs and cleanup functions. Preserve settings-search registration, keyboard navigation, disabled/loading/error/empty states, widget configuration and state isolation. Route durable state through the server event path; local presentation state stays local. Memoization should follow measured render pressure, not mask stale data.

Test mount/unmount, package disable/re-enable, duplicate registration, two widget instances, different project/Space and stale async results. An aborted or out-of-date request must not update the newly selected session. Exercise shared primitives on mobile as well as desktop. UI snapshots do not replace interaction assertions, and containment success does not prove browser bundle safety; run the build for import changes.

## Verification and handoff
Suggested test locations (confirm current files first): `apps/web/test/packageContainment.test.ts`

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
