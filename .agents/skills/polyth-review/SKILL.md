---
name: polyth-review
description: Review actual Polyth diffs and acceptance evidence, prioritizing concrete regressions and clearly labeled uncertainty.
---
# Code review and acceptance

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context review`. This command is a navigation aid, not an audit.

- `AGENTS.md`
- `docs/agents/task-map.json`
- `docs/agents/verification.md`
- `docs/agents/templates/evidence.md`

## Workflow and constraints
Review the requested behavior and actual diff before reading the implementer's claims. Establish the exact base/head and uncommitted scope. Prioritize correctness, security, data loss, uncertain execution, broken imports, race conditions and missing integration above style preferences.

For each finding provide severity, precise path/symbol, trigger, consequence and a practical fix direction. Label suspected risks separately from demonstrated failures. Avoid generic checklists reported as discoveries. Verify that new tests would fail for the original bug and do not only mirror implementation details.

Check package ownership, public consumers, remote/Space boundaries, enable/disable cleanup, browser/native separation and historical-document assumptions. A stub, capability flag, screen or fake success response is not full feature completion. Examine failure states, not only the happy path shown in screenshots.

Report performed checks with exact commands and results, and explicitly name missing provider/browser/device or CI evidence. Do not call a failure pre-existing without a comparable base run. Re-review the final integrated diff after corrective edits. An independent role is valuable only when it inspects source/evidence rather than endorsing a summary; same-agent self-review must be labeled as such.

## Verification and handoff
Suggested test locations (confirm current files first): Use the owning area and risk matrix; do not invent a test filename.

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
