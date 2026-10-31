---
name: polyth-orientation
description: Route a Polyth task to the right owner and evidence. Use for unfamiliar areas, ambiguous scope and bounded repository exploration.
---
# Task routing and evidence

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context orientation`. This command is a navigation aid, not an audit.

- `package.json`
- `packages/plugins/src/serverPackage.ts`
- `docs/agents/architecture.md`
- `docs/agents/evidence.md`

## Workflow and constraints
Begin with the requested behavior, not an implementation guess. Record the current branch, HEAD and dirty paths once. Choose the smallest owning area from the task map. Read its skill, actual entry point and one relevant test. Use `context --path` for a known file; use `map` when the domain is unclear. The map is a starting hypothesis, not an exhaustive dependency graph.

Separate policy from evidence: a desired invariant can expose a bug in existing code; a stale document cannot establish an API that the implementation no longer has. Inspect the exported type and one real caller before writing integration code. Record unresolved contradictions with paths and observed facts; never silently pick whichever source makes the task easiest.

Widen exploration only for a concrete missing caller, contract consumer, lifecycle owner or failed check. For public contracts enumerate consumers across the affected graph. An empty search is not proof of absence until scope, generated entries and alternative symbols are considered. Stop exploring when ownership, contract, failure mechanism and verification route are known.

For an unfamiliar provider protocol or SDK, first identify the installed/pinned version, then consult its official documentation or generated schema. Do not perform external research for a local function already defined here. Deliver a change bounded by acceptance criteria; record what remains unknown rather than inferring readiness from filenames.

## Verification and handoff
Suggested test locations (confirm current files first): Use the owning area and risk matrix; do not invent a test filename.

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
