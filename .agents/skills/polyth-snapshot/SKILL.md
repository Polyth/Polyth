---
name: polyth-snapshot
description: Implement session Snapshot import and continuity without pretending it is Attach/Sync or trusting unverified native history.
---
# Snapshot import and continuity

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context snapshot`. This command is a navigation aid, not an audit.

- `packages/session-import`
- `packages/harness-runtime`
- `packages/session`
- `docs/architecture/multi-harness.md`
- `docs/agents/known-drift.md`

## Workflow and constraints
First establish the supported operation from current source: snapshot ingestion is not continuous Attach/Sync. Source adapters own native inventory and parsing; generic orchestration owns staging and publication. Do not introduce provider names or transcript-specific branches into the importer core.

Preserve one canonical session and the exact project/Space/cwd relationship. Stage bounded records before atomic publication, validate roles and sizes, and make publication idempotent using the existing request/source identity. Interrupted reads must not appear as completed sessions. Do not resume against an unverified source tail or infer native receipt identity from titles/timestamps.

Import only content supported by the canonical contract. Native reasoning, private system instructions, secrets and speculative summaries do not become confirmed history. Binary attachment capability is adapter-specific; names/MIME references alone are not lossless transfer. Existing source handles must remain opaque and authorization-bound.

Test malformed/empty/oversized sources, cancellation, duplicate requests, lost responses, restart before/after publication, source deletion and known-valid cross-Space handles. First continuation must use the confirmed canonical history even when native source history disappears. Any proposal for Attach/Sync requires durable checkpoints, append verification, divergence and crash recovery, not just another UI option. Record losses and unsupported semantics explicitly.

## Verification and handoff
Suggested test locations (confirm current files first): `packages/session-import/test/snapshot.test.ts`; `packages/server/test/harnessSwitch.test.ts`

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
