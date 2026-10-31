---
name: polyth-refactor
description: Simplify Polyth code while preserving observable behavior, dynamic registration, public contracts and lifecycle ownership.
---
# Refactoring and simplification

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context refactor`. This command is a navigation aid, not an audit.

- `package.json`
- `apps/web/test/packageContainment.test.ts`
- `docs/agents/architecture.md`
- `docs/agents/verification.md`

## Workflow and constraints
Define the behavior that must remain unchanged and the concrete duplication or complexity being removed. Find all consumers of the symbol or export being moved. Capture baseline tests and representative failure behavior before restructuring; do not use a refactor as cover for unrequested feature changes.

Prefer incremental owner-preserving changes. Move feature code back to its package and reuse canonical primitives, but preserve necessary host infrastructure and audited exceptions. Remove an abstraction only after proving no runtime registration, lazy entry, generated inventory or external consumer depends on it. Text search alone is insufficient for dynamic discovery.

Keep browser/Node exports, package lifecycle, event ordering, security and migration contracts intact. Avoid cosmetic whole-repo reformatting, dependency updates or renames that obscure the causal diff. Fewer lines are not automatically simpler if semantics become implicit or unsafe.

Test both the previous public behavior and changed boundary paths. For a large restructure check all consumers, builds and relevant suites; compare errors, cleanup, optional capability states and persisted data compatibility. Record any intended behavior change separately. Do not delete uncertain code merely because it looks unused, and do not introduce general-purpose frameworks to remove a small local duplication.

## Verification and handoff
Suggested test locations (confirm current files first): Use the owning area and risk matrix; do not invent a test filename.

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
