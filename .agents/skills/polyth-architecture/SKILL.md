---
name: polyth-architecture
description: Evolve Polyth core ownership, shared seams and system architecture with explicit consumers, compatibility and failure handling.
---
# Core architecture and system evolution

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context architecture`. This command is a navigation aid, not an audit.

- `packages/kernel`
- `packages/server/src/index.ts`
- `packages/plugins/src/serverPackage.ts`
- `packages/web-sdk/src/index.ts`
- `docs/agents/architecture.md`
- `docs/dev/architecture.md`

## Workflow and constraints
Start from the current dependency direction and ownership boundary, not an idealized rewrite. Identify the concrete failure or capability gap, why an existing package seam cannot solve it, and which consumers must change. Use the architecture-decision template for a change in responsibilities, persistence or trust boundary; ordinary local implementation details need no ADR.

Keep the composition root generic. Features register through packages; providers supply runtimes without vendor dispatch tables spreading through session/core UI. A shared interface should express a proven need used by real consumers. Prefer removing duplicate plumbing to adding another registry, state container or adapter layer.

Plan compatibility and rollout before replacing a seam. Additive contracts are safer than synchronized breaking changes across remote clients. Account for partial initialization, teardown order, optional unavailable packages and old persisted records. Do not interpret a legacy exception as the desired architecture, but do not delete it without tracing live consumers.

For a cross-cutting change enumerate affected packages, public exports, persistence, native shells and tests. Assign non-overlapping implementation ownership when delegating. Verify both successful and failed startup, restart and disposal paths. Measure complexity with actual removed duplication and preserved behavior, not line count alone. A full test suite may be required for broad changes; explain any unavailable validation rather than declaring architecture correct from static reading.

## Verification and handoff
Suggested test locations (confirm current files first): `packages/server/test/packageDiscovery.test.ts`

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
