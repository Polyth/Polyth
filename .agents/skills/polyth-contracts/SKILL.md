---
name: polyth-contracts
description: Change public DTOs, events, types and exports; trace consumers and protect the browser versus Node import boundary.
---
# Public contracts and browser boundaries

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context contracts`. This command is a navigation aid, not an audit.

- `packages/contracts`
- `packages/web-sdk/src/index.ts`
- `packages/plugins/src/index.ts`
- `packages/commands/package.json`
- `docs/agents/architecture.md`
- `docs/agents/verification.md`

## Workflow and constraints
Read the export actually consumed, the defining type and its relevant producers/consumers. Enumerate use sites before changing shared DTOs, service keys, events or package exports. Do not assume every package root maps to the same index or is browser-safe. The commands catalog subpath illustrates a deliberate browser/Node split; preserve it.

Keep boundary data serializable and validate untrusted input at the boundary. Prefer additive optional fields with defined absent behavior; do not silently change units, ID meanings, event semantics or error codes. Old clients and persisted events must degrade predictably. Unknown event types must not crash reducers. Distinguish TypeScript compile-time declarations from runtime validation and runtime exports.

For browser code use verified browser-safe subpaths and `import type` where appropriate. Node filesystem/process imports cannot be fixed by marking them external in a browser build, adding dummy polyfills or suppressing esbuild errors. Trace the transitive import chain to its wrong boundary instead.

Test serialization, malformed/unknown fields, old payloads, new consumers and backward-compatible defaults. Run touched consumers' typechecks and browser builds when exports move. Do not weaken assertions or cast through `any` merely to silence drift. Record exact compatibility assumptions and the version or migration boundary; “contracts-first” does not mean designing speculative APIs before there is a demonstrated caller.

## Verification and handoff
Suggested test locations (confirm current files first): `apps/web/test/packageContainment.test.ts`

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
