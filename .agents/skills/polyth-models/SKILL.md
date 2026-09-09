---
name: polyth-models
description: Fix model catalogs, provider settings, thinking effort and capability UI; handle identity-keyed caches and rapid selection races.
---
# Model catalogs, capabilities and provider settings

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context models`. This command is a navigation aid, not an audit.

- `packages/models`
- `packages/opencode`
- `packages/backend-codex/src/index.ts`
- `packages/harness-runtime`
- `docs/agents/known-drift.md`
- `docs/agents/verification.md`

## Workflow and constraints
Trace the catalog's identity, source, cache key and current selection before changing picker behavior. A harness, provider, model, account, profile and thinking effort are distinct concepts. Keep native protocol details inside adapters. Do not encode harness identity into a provider ID or synthesize plausible model names and effort values.

Read live adapter declarations and operation implementations, not the historical multi-harness capability matrix. A declared capability is one evidence layer; validate its request translation and failure behavior. Preserve the distinction between unsupported, unavailable, unauthenticated, loading, stale and an actually empty catalog.

For fast switching, keep the UI responsive with correctly keyed reusable metadata and deduplicate in-flight reads. Scope tenant data by Space and account/project/runtime identity as required. Use revision/generation fencing so a slower previous selection cannot overwrite the current catalog. Invalidate on auth, provider settings, enablement and runtime changes; do not cache credentials or grant decisions as ordinary presentation data.

Separate OpenCode-specific settings from generic model selection. Respect explicit user model/profile choices; unsupported effort must not be silently ignored or guessed. Measure cold and warm latency, request count and stale result rejection. Test rapid A/B/A switching, provider failure, authentication change, disabled packages, two Spaces and unsupported attachments. Reducing visible spinners without reducing incorrect blocking or backend work is not a performance fix.

## Verification and handoff
Suggested test locations (confirm current files first): `packages/backend-codex/test/protocol.test.ts`; `packages/harness-runtime/test/registry.test.ts`

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
