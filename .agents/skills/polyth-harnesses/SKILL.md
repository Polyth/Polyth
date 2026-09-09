---
name: polyth-harnesses
description: Integrate native agent runtimes and switch harnesses safely, preserving receipts, release proof, generations and canonical history.
---
# Harness integration and safe switching

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context harnesses`. This command is a navigation aid, not an audit.

- `packages/harness-runtime`
- `packages/backend-codex/src/index.ts`
- `packages/plugins/src/serverPackage.ts`
- `docs/architecture/multi-harness.md`
- `docs/agents/known-drift.md`

## Workflow and constraints
Separate the native provider contract, the Polyth adapter implementation, declared capabilities and end-to-end evidence. Verify the installed/pinned protocol or generated schema before mapping an external operation. Do not assume two ACP profiles or two RPC protocols have identical framing, authentication or cancellation semantics. Provider-specific parsing belongs in its adapter; shared core remains vendor-neutral.

Keep the canonical session while switching runtime legs. Explicit pins must not silently fall back. A return to an earlier harness does not justify reuse of an unsynchronized native history. Inspect the current switch transaction, operation receipt and release evidence before changing it. Timeout, abort acknowledgement, channel closure and missing PID are not positive execution-release proof.

Fence stale observations by authority/generation and reconciliation epoch. Never create a replacement native execution speculatively after a lost receipt. Preserve Linux supervision limits and do not claim the same guarantee on borrowed endpoints, remote execution or other operating systems without implementation evidence.

Advertise only supported modalities, model controls, usage and permission behavior. Unsupported must remain honest, not hidden behind a successful-looking placeholder. Test failed tool outcomes, stream finalization, permission denial, malformed frames, disconnect mid-operation and restart. Native reasoning and private prompts stay outside canonical dialogue. Protocol-fake success is not a paid/live/provider-auth test; record exactly which evidence level exists.

## Verification and handoff
Suggested test locations (confirm current files first): `packages/harness-runtime/test/registry.test.ts`; `packages/harness-runtime/test/rpc.test.ts`; `packages/server/test/harnessSwitch.test.ts`; `packages/backend-codex/test/protocol.test.ts`

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
