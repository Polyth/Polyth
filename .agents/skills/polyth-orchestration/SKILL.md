---
name: polyth-orchestration
description: Coordinate bounded subagent work or Polyth multirun/fusion/goals/handoff changes using explicit ownership and evidence packets.
---
# Multi-agent execution and handoff

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context orchestration`. This command is a navigation aid, not an audit.

- `packages/multirun`
- `packages/fusion`
- `packages/goals`
- `packages/handoff`
- `packages/workflow`
- `docs/agents/orchestration.md`
- `docs/dev/workflows.md`
- `docs/agents/templates/handoff.md`

## Workflow and constraints
Choose delegation only when the task benefits from separate ownership. In Polyth, delegation means the canonical Polyth control capability: create the worker with `agent.spawn`, never a harness-native Agent/Task/subagent primitive. Every worker is a child session with `parentId`, so nested delegation remains a session tree and ordinary recovery/authorization applies. Pick the worker's harness/model from one `agent.models` call (favorites, recent use and live quota headroom; skip `BLOCKED`/`UNAVAILABLE` rows) rather than guessing an id. Pick its workspace too: `isolation: "isolated"` gives it its own worktree from your last commit, and you must bring every isolated worker back with `agent.merge` (or `agent.discard` on purpose) before finishing — see [workspace choice and integration duty](../../../docs/agents/orchestration.md#choosing-the-workers-workspace). Small fixes stay in one agent. Roles are explorer, implementer and verifier; role names do not guarantee a particular model, price or tool capability. Never fabricate a subagent run or independent review.

For parallel work assign non-overlapping write sets and define the shared contract owner first. Give each worker a short task packet: requested behavior, relevant files/skill, invariants, allowed edits, test plan and evidence required. Do not copy the entire repository or chat into each worker. Parent architecture is a proposal to verify against current contracts, not unquestionable truth.

A worker returns exact changed paths, evidence, unresolved uncertainty and ownership handoff. The integrator checks the combined diff, public consumers and lifecycle interactions; passing isolated branches does not prove the merge. Tests tied to a different SHA or dirty state must not be reused as evidence for the integrated result.

For Polyth's own multirun/fusion/goals/handoff features, trace execution authorization, canonical history, queue ownership, cancellation and artifact provenance in the owning packages. Do not duplicate runtime state or silently spend paid provider quota to test coordination. Token economy means bounded exploration and compact evidence, not skipping tests or asking a cheaper agent to guess.

### Delegated-child cleanup is mandatory

Keep the canonical child session ID for every delegated run. If child creation
throws, times out before confirmed work, or a terminal parent task snapshot
reports `done`/`failed` while the child has no assistant/tool/request evidence,
delete that child through the owning canonical session service (`sessions.delete`
or the product's Delete session action). Do not archive it, hide it in a list,
or retry an uncertain mutation. The server automatically performs this cleanup
for proven-empty terminal children and leaves a deletion tombstone; the agent
still performs the explicit delete when its own create call fails or hangs.

If the parent is still running/unknown or the child has assistant, tool,
permission, question, or secret evidence, preserve the session and report the
canonical ID and uncertainty instead of guessing that it is a false child.

## Verification and handoff
Suggested test locations (confirm current files first): Use the owning area and risk matrix; do not invent a test filename.

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
