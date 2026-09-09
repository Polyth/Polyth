---
name: polyth-live-control
description: Use an explicitly authorized running Polyth instance through actual discovered tools; never substitute live control for code work.
---
# Authorized live Polyth control

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context live-control`. This command is a navigation aid, not an audit.

- `packages/polyth-mcp`
- `.opencode/opencode.json`
- `docs/agents/security.md`
- `docs/agents/evidence.md`

## Workflow and constraints
Use this skill only for an explicitly authorized interaction with a running Polyth instance, not ordinary repository development. First confirm the intended instance and actual available MCP/tools. A committed MCP configuration or a hardcoded path does not prove the process is running or that the current agent is authorized.

Discover capabilities and exact input schemas before calling actions. Preserve explicit user choices, model/provider/profile and delivery mode. Inspect current state to distinguish an idempotent retry from a second mutation. Do not start paid turns, alter permissions, disable security, cancel another session or change a project's state merely to test connectivity.

The legacy control seam names `polyth_capabilities`, `polyth_control` and `polyth_configure`; use only names exposed by the live tool registry. The internal socket is a protected administrative channel, not an authentication bypass. Never send secret values; secret entry belongs in the authorized UI. Never broaden enabled actions automatically.

Resolve ambiguous destructive operations before executing them, and keep targets explicit. Read-only status queries still must avoid leaking prompts, credentials or tenant data. Report actual operation receipts/results and remaining uncertainty. When the connector is unavailable, perform source-based diagnosis or provide a manual operation plan clearly marked unexecuted. Do not claim control actions occurred from code inspection.

## Verification and handoff
Suggested test locations (confirm current files first): Use the owning area and risk matrix; do not invent a test filename.

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
