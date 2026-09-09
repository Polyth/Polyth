---
name: polyth-storage
description: Change persistence, schemas and migrations with scoped storage, interruption recovery, compatibility and isolated fixtures.
---
# Persistence and migrations

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context storage`. This command is a navigation aid, not an audit.

- `packages/session`
- `packages/tenancy`
- `packages/plugins/src/serverPackage.ts`
- `docs/agents/security.md`
- `docs/agents/templates/migration.md`

## Workflow and constraints
Identify the owner and consistency model: canonical session events, tenant-owned service records, deployment-wide metadata or browser-only preferences. Use the existing store and atomic-write primitives. Do not create a second session database or persist secrets in ordinary JSON because it is convenient.

Plan the migration from actual old records, including absent/partial fields and default-Space adoption. Preserve forward compatibility and stable IDs. Define failure and reopen behavior before transforming data. A backup is not a rollback strategy until restore has been tested on isolated data, and a schema downgrade may be unsupported.

Exercise fresh creation, upgrade from a realistic old fixture, repeated migration, interruption/reopen and concurrent access under the supported locking model. Validate indexes/queries as well as transformed bytes. For filesystem state validate symlink/traversal and atomic replace semantics; for SQLite use the existing transaction boundary and check replay/projections where involved.

Never point tests at the user's live data directory or run two servers against the same store. Do not log row contents that may contain prompts, tokens or private documents. Distinguish schema validation from operational readiness on a large dataset. Document estimated resource pressure as an estimate until measured, and keep irreversible changes behind an explicit reviewed operation with a recovery plan.

## Verification and handoff
Suggested test locations (confirm current files first): Use the owning area and risk matrix; do not invent a test filename.

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
