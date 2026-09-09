---
name: polyth-sessions
description: Modify canonical sessions, queues, events, replay and recovery without losing durability, ordering or execution provenance.
---
# Canonical sessions, events and recovery

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context sessions`. This command is a navigation aid, not an audit.

- `packages/session`
- `packages/server/src/index.ts`
- `packages/plugins/src/serverPackage.ts`
- `apps/web/src/reduce.ts`
- `docs/agents/architecture.md`
- `docs/architecture/multi-harness.md`

## Workflow and constraints
Trace one action from admission through durable mutation, adapter observation, persisted event, broadcast and UI projection. The canonical Polyth session ID is not a native thread ID. Persist model-visible facts before display or runtime delivery; use the existing persist-then-broadcast seam after ownership validation. Pure layout and presentation preferences do not belong in model history.

Preserve ordering, transactional sequence allocation, deduplication and replay. Distinguish confirmed failure from uncertain execution: lost acknowledgements, timeout, disconnect or a stopped UI spinner do not prove an operation did not happen. Reconcile through the existing journal, authority/generation and epoch barriers rather than blindly retrying a mutating operation.

Test reconnect gaps, duplicate/out-of-order observations, restart between persist and broadcast, interrupted turn admission, queue cancellation and rewind/fork-derived effective history. A new event must be safe for old reducers. Do not invent summaries of unconfirmed tool results or copy native reasoning into continuity. The visible user text should remain the user's text when hidden recovery context is supplied separately.

Use isolated databases and deterministic fake runtimes for fault injection. Inspect current locking and persistence primitives before adding new locks or stores. Do not run two servers against the same data directory. Measure and verify projections against event replay, not merely against a single successful UI request. Any migration or permission effect adds the storage/security skill and broader regression checks.

## Verification and handoff
Suggested test locations (confirm current files first): `packages/server/test/harnessSwitch.test.ts`

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
