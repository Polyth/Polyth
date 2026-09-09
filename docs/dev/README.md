# Developing a Polyth feature

Start with [AGENTS.md](../../AGENTS.md) and the [package-development skill](../../.agents/skills/polyth-packages/SKILL.md). This guide is an implementation checklist, not a frozen API reference. Read the current exported types and a current caller before copying a pattern.

## Choose the owner

Feature logic/routes belong to `packages/<feature>/src/`; feature UI belongs to its `widgets/` directory. Generic shared host behavior belongs to `apps/web`. Tenant infrastructure belongs to tenancy/server, and native provider integration belongs to its backend. Do not create a new feature by editing the host's App/Main switches or package registries.

The manifest's `polyth.serverEntry` and `polyth.webEntry` opt into separate discovery/activation paths. Not every package needs both. Verify its real exports: browser-safe subpaths and runtime entry points can differ. `packages/example-feature/src/serverEntry.ts` is a minimal server/capability example; `packages/usage/widgets/index.tsx` is a concrete web registration/disposal example. Neither is a universal full feature template.

## Build against the existing seams

Use `@polyth/plugins` for server packages and `@polyth/web-sdk` for browser registrations. Read `packages/plugins/src/serverPackage.ts` for exact lifecycle and service contracts. Resolve cross-package services in enable hooks or handlers, not at registration time. Return/execute cleanup on disable and failed startup.

Inside a request use the already validated `rc.space`, then `host.forSpace(rc.space)` for scoped core services. Validate ownership before any operation that uses a legacy/unscoped handle. Store tenant data via `host.spaceStorage(rc.space)`; shared `storageDir` is not a tenant store. Paired access is default-deny; new remote-safe routes need a reviewed `remoteAccess` declaration and negative authorization tests.

Use the existing durable event path for model-visible state. `host.events.append` persists before broadcasting; direct store append alone does not broadcast. Pure browser presentation stays outside canonical history. Define backward-compatible DTO/event additions in the appropriate public contract and inspect every affected consumer.

## Integrate UI without duplicating the host

Read relevant sections of [ui.md](ui.md), [components.md](components.md), [styles.md](styles.md), and [widgets.md](widgets.md) for widget work. Use current web-sdk registrations for surfaces, slots, settings, capabilities, widgets and resource views. The host owns window geometry and shared primitives; packages own content. Follow canonical tokens and scoped CSS, including mobile and user accessibility/performance settings.

The import exceptions in `apps/web/test/packageContainment.test.ts` are authoritative boundary checks, not an invitation to add more exceptions. Do not import a Node-only root into a browser entry, even through a transitive barrel.

## Finish with evidence

Add behavior-focused tests for success, errors, authorization and enable/disable. Add replay/restart/migration cases when state is durable. Run the checks selected by [the verification matrix](../agents/verification.md), then inspect the diff. Update contracts, task routes or a relevant parity row only when supported by actual implementation and evidence; an internal refactor does not need a new parity claim.

[Commands](../agents/commands.md) come from current package manifests/workflows. Root build is web-only. CI exists and its test ownership is split by `scripts/ci/select-tests.mjs`. Do not require a particular private IP or kill a server just because it uses another port. Verify against an authorized existing instance or a deliberately isolated data directory/port; never run two instances against one data directory.
