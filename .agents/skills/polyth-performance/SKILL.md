---
name: polyth-performance
description: Measure and improve startup, model switching, streaming, rendering and resource use without weakening correctness or security.
---
# Performance, resource use and responsiveness

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context performance`. This command is a navigation aid, not an audit.

- `apps/web/src/store.ts`
- `packages/models`
- `packages/harness-runtime`
- `packages/server/src/index.ts`
- `docs/agents/performance.md`
- `docs/agents/verification.md`

## Workflow and constraints
Define the user-visible latency and a reproducible workload before optimizing. Distinguish cold start, warm navigation, native provider latency, first render, first token and final completion. Record sample count, environment, payload size, cache state and whether measurements come from mocks or a real runtime.

Locate blocking dependency chains, duplicate requests, excessive discovery, repeated parsing, unnecessary renders and overbroad invalidation. Prefer bounded reuse and concurrency only where lifecycle and identity make it safe. A single-flight cache must not leak between Spaces/accounts or preserve denied permissions. A fast stale result is not a correct result.

Preserve ordering, transactional semantics, cancellation, backpressure and ownership. Do not remove reconciliation, durable writes or security checks because they cost time. Bound memory and queue growth, avoid per-event whole-history copying, and release subscriptions when a panel/package becomes inactive. Respect low-resource, transparency and reduced-motion settings.

Compare before and after on the same scenario with multiple samples; report variance or a range instead of a fabricated percentile from one observation. Check behavior under slow/erroring providers and rapid changes of selection. Add a regression assertion for work count or state correctness when timing tests would be flaky. Keep performance instrumentation free of prompt content and secrets. Report an optimization hypothesis as such until measured.

## Verification and handoff
Suggested test locations (confirm current files first): Use the owning area and risk matrix; do not invent a test filename.

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
