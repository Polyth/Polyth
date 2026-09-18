# Maintaining the knowledge system

## One canonical body

Edit AGENTS for universal policy, the owning `.agents/skills/polyth-*/SKILL.md` for domain workflows, and `docs/agents` for deeper reference. Client files are small entry adapters. Do not mirror all skill bodies into every client's directories; clients that scan multiple locations can discover duplicates.

A healthy knowledge system optimizes two different things at once:

1. **Freshness:** active documentation reflects current behavior, contracts and workflows.
2. **Context economy:** an agent loads only the slices needed for the current task.

Never solve freshness by adding more always-loaded prose. Keep `AGENTS.md` compact, route to canonical domain docs, and retrieve those docs on demand.

## When code changes

For a moved entry point, changed export, new package or altered verification owner, update `task-map.json` and the affected prose in the same change. Changes to architecture, public behavior, configuration, operational workflows, verification commands or UX contracts likewise require an owning documentation-impact check before completion. If an active document is known to be wrong, correct it, explicitly supersede it, or move the claim into historical/drift context; do not knowingly leave contradictory active guidance.

Use `inventory` to discover current manifests and declared dependencies without scanning implementation bodies. Inspect actual consumers for contract changes; the mechanical manifest graph is not complete.

Run `doctor <area>` to identify recorded sources that changed or disappeared. Read the relevant changed definitions/callers/tests, resolve affected statements and record actual review coverage. Only then manually update the relevant `gitBlob` in `evidence.json`. Git object IDs can be obtained with `git hash-object -- <path>`; normalize checkout line endings deliberately when recording text. Do not update every hash just to hide warnings. Never change the global historical audit baseline to imply all code was re-reviewed.

A tree-only entry stays tree-only until its implementation is actually reviewed. A hash refresh does not run tests. A new review can add its own dated evidence record/ADR without rewriting historical outcomes. Optional MemPalace/project memory can carry a short pointer, but the checked-in repository remains the portable source.

## Durable knowledge and harvest

At task/session close, consider whether the work revealed knowledge worth keeping. Promote only information that is reusable beyond the current turn:

- stable architecture/invariants -> owning architecture or domain document;
- a consequential choice with alternatives/trade-offs -> ADR;
- stable coding/operational convention -> owning conventions/skill;
- verified recurring pitfall -> the narrow relevant guide;
- moved ownership/source -> task map/evidence.

Discard raw progress logs, conversational summaries, speculative interpretations and information already represented canonically. Keep provenance or source pointers for non-obvious claims. A later contradiction should supersede the old active guidance rather than creating two competing rules.

Harvest is not permission to rewrite broad documentation opportunistically. Update only affected owners, and keep historical evidence append-only where chronology matters.

## Validation gates

`node scripts/agent-kit.mjs check` validates kit structure, frontmatter, internal document links and mapped paths against a full checkout. `--kit-only` validates a standalone overlay without requiring application source. Neither analyzes arbitrary TS semantics or guarantees every inline backtick path exists. `doctor` reports source drift separately. Unit tests exercise the toolkit; application checks remain the owning team's responsibility.

The dedicated Agent Knowledge workflow runs kit checks/tests for knowledge/tooling paths. It does not rebuild apps or publish releases. It is not a universal source-drift gate: code-only changes can still make a document stale, so high-risk tasks should use area-scoped doctor. Do not make this path-filtered workflow a required whole-PR gate without handling skipped workflow semantics.

## Review debt and escalation

If a rule is repeatedly violated, first make its entry point and example clearer, then consider a narrow executable invariant test. Avoid adding vague always-on prose, a sweeping grep that flags string data, or another competing architecture document. Keep changes tied to real failures. Delete obsolete active instructions only with their replacement and a short correction note; retain historical plans as explicitly historical.
