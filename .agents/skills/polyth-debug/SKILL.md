---
name: polyth-debug
description: Diagnose reproducible Polyth errors, EPIPE, build failures, attachments and stale UI using causal evidence rather than guesses.
---
# Debugging and regression diagnosis

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context debug`. This command is a navigation aid, not an audit.

- `package.json`
- `scripts/ci/select-tests.mjs`
- `docs/agents/debug-playbook.md`
- `docs/agents/evidence.md`

## Workflow and constraints
Capture the failing command or user action, first causal error, environment, current commit and reproducibility. Keep logs bounded and redact secrets. Preserve the original failure before editing: a before/after reproducer is stronger than a plausible patch. Separate build, startup, request, adapter, persistence, streaming and UI failures.

Follow the narrow failing path and its lifecycle owner. Use a small hypothesis set with a discriminating observation for each. A grep hit, missing optional binary or network timeout is not automatically the root cause. For EPIPE inspect which stream/process closed and whether a mutation may already have happened; do not retry or swallow every error globally.

For browser Node-resolution errors trace the transitive import chain to the wrong package entry. For stale model UI trace selection identity, cache invalidation and response races. For missing attachments distinguish picker/upload, canonical representation, capability admission and native translation. For apparently successful tools distinguish acknowledgement, terminal outcome and persisted event.

Fix the earliest responsible boundary with a regression test. Do not rewrite unrelated subsystems, disable tests, weaken auth or widen timeouts without evidence. Establish alleged pre-existing failures on a comparable base/environment before labeling them unrelated. If live verification is blocked, return the established mechanism, evidence and remaining check, not a fictional root cause. Use the incident template for reproducible diagnostic handoff.

## Verification and handoff
Suggested test locations (confirm current files first): Use the owning area and risk matrix; do not invent a test filename.

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
