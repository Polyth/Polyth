---
name: polyth-knowledge
description: Maintain agent rules, task routes, source evidence and durable project knowledge without duplicated bodies, stale docs or automatic truth refreshes.
---
# Agent knowledge maintenance

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context knowledge`. This command is a navigation aid, not an audit.

- `docs/agents/task-map.json`
- `docs/agents/evidence.json`
- `scripts/agent-kit.mjs`
- `docs/agents/maintenance.md`
- `docs/agents/client-compatibility.md`

## Workflow and constraints
Treat instructions and documentation as maintained product infrastructure. Change the canonical skill or guide, not multiple diverging agent-specific copies. Keep root AGENTS short and place domain detail behind explicit routes. Read only the relevant reference subsection; adding every document to startup defeats the purpose.

Documentation freshness and context size are separate concerns. A code or product change that invalidates an active document must update that owning document, route or evidence in the same change; this does not authorize eager loading of unrelated docs. Route by task/path, inspect the smallest defining code and relevant checks, then expand context only for a real dependency, uncertainty, risk or failure.

When code moves or a public seam changes, update its task-map entry and source evidence. A changed Git blob hash means the cited description needs review; it does not prove a defect or refresh semantic truth. `inventory` is mechanical output from current manifests and paths, never a readiness assessment. Record human/agent review scope and actual evidence separately from generated metadata.

Harvest only durable knowledge. Reusable invariants, architectural decisions, conventions and verified gotchas belong in the appropriate canonical document or ADR with provenance; transient task progress, raw chat summaries, model reasoning and speculative observations do not. If a durable candidate conflicts with current guidance, resolve or explicitly supersede the owning statement instead of accumulating both.

Run the kit structural checks and unit tests after edits. Verify paths, unique skill names, frontmatter, canonical adapters and portable commands. Do not add automatic hooks that run arbitrary scripts, broaden permissions, install dependencies or access credentials. Keep machine-specific settings outside shared instructions.

Archive historical decisions as dated context; do not silently rewrite old test evidence into current verification. Remove obsolete prescriptions from active entrypoints and note the correction with source pointers. A future agent should learn what to read and why, not inherit an unsupported certainty. Optional project memory is a convenience; the repo must remain usable when that service is absent.

## Verification and handoff
Suggested test locations (confirm current files first): `scripts/test/agent-kit.test.ts`

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, documentation impact and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
