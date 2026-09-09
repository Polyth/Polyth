---
name: polyth-testing
description: Choose causal tests and risk-based verification; report exact outcomes and distinguish mocks, integration, live and device evidence.
---
# Risk-based testing and honest completion

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context testing`. This command is a navigation aid, not an audit.

- `package.json`
- `scripts/ci/select-tests.mjs`
- `.github/workflows/ci.yml`
- `docs/agents/verification.md`
- `docs/agents/evidence.md`

## Workflow and constraints
Select checks from behavior and blast radius, not from whichever command finishes fastest. Read the owning test to understand its boundary and fakes. Use existing node:test/assert patterns and deterministic injected dependencies. A happy-dom assertion is not a real browser, provider, database durability or native device test.

For a bug, reproduce the relevant failure before the fix or explain why that was impossible. Test observable behavior, not only the shape of the implementation. Cover denial, cancellation, partial failure, duplicate/stale results, restart or replay when the modified path can encounter them. Do not create a passing test that merely repeats the function's algorithm.

Run the smallest causal test first, then adjacent regressions, typechecks and builds appropriate to changed contracts/imports. Expand to the relevant owner suite or full suite for broad changes. Current generic CI excludes Link-owned tests and an explicit workflow baseline; green generic CI is not equivalent to `npm test` or product readiness. Inspect the selector rather than maintaining a duplicated list.

Record the exact command, cwd, commit/dirty scope, exit status, counts and skipped prerequisites. Distinguish passed, failed, not run, blocked and source-inspected. Test tools may write build/temp output even when an agent is in a read-only role; obey the environment's actual permissions. Never hide failing checks, fabricate coverage or call a review independent when it is the implementer rereading its own summary.

## Verification and handoff
Suggested test locations (confirm current files first): Use the owning area and risk matrix; do not invent a test filename.

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
