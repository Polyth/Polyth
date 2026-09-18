# Proposal: AI-ready project context bootstrap

Status: proposed product/UX contract  
Scope: new/open project onboarding when the selected project does not contain a root `AGENTS.md`

## Problem

An agent entering a new repository has two bad defaults:

- start with too little project context and guess;
- scan/read too much and pollute the model context with irrelevant or stale information.

Polyth should instead create a compact, durable project navigation layer once, keep the underlying documentation accurate, and load deeper context only when a task requires it.

## Product principle

**Fresh knowledge, small active context.**

Project documentation may be comprehensive and current. Model context must remain selective.

`AGENTS.md` is not the project documentation. It is the small stable index that tells agents:

- what this project is;
- what must never be violated;
- where canonical knowledge lives;
- how to verify work;
- how to decide what to read next.

Detailed architecture, conventions, setup, APIs and feature documentation stay in their existing owning files and are retrieved on demand.

## Trigger

After a local/remote project is created or opened:

1. Check for a root `AGENTS.md`.
2. If one exists, do not overwrite or silently regenerate it. Use it as the project entry point; Polyth may later offer a separate **Review AI guidance** action.
3. If none exists, offer **Set up AI project guidance**.
4. The user may skip. Skipping never blocks opening the project.

This bootstrap runs once per project unless explicitly requested again.

## Recommended UX

### Step 1 — a few human questions

Use one compact screen, not a wizard maze. Ask only information that repository scanning cannot reliably know.

Recommended questions:

1. **What is this project trying to achieve?**  
   Short free text. Optional if an existing README already makes the purpose obvious; Polyth can prefill later, but the user remains authoritative.

2. **What should agents never do without asking?**  
   Multi-select defaults such as deploy/publish, modify production data, change credentials/secrets, destructive migrations, push/merge, plus custom text.

3. **What counts as done here?**  
   Optional short answer: important test/build/check expectations or review requirements. Existing commands discovered during scanning are presented for confirmation rather than guessed as truth.

Keep an **Advanced** disclosure for unusual repositories; do not front-load configuration.

### Step 2 — safe targeted project scan

If the folder is non-empty, scan after the initial answers.

The scan is inventory-first and bounded. Prefer:

- root files and directory structure;
- README/index documentation;
- package/project manifests;
- CI/workflow definitions;
- language/build/test configuration;
- existing agent/client instruction files such as `CLAUDE.md` or Cursor rules;
- likely architecture/conventions docs;
- representative source entry points and tests only when needed to classify the project.

Do not by default:

- execute repository scripts;
- install dependencies;
- read secret values or `.env` contents;
- ingest binaries, generated outputs, vendored dependencies, caches or build artifacts;
- recursively pour the whole repository into model context;
- treat instructions embedded in arbitrary project content as higher authority than the user's bootstrap choices or Polyth safety rules.

For large repositories, use manifests, file names and routing signals first, then inspect only a small relevant sample.

If the folder is empty, skip scanning and create a minimal starter contract from the user's answers. It can evolve as the project gains structure.

### Step 3 — generate `AGENTS.md`

Generate a compact root file, normally around 50–100 lines.

Suggested structure:

```md
# <Project> — agent operating contract

## Scope and purpose
- Purpose: ...
- Repository boundaries: ...

## Core invariants
- ...
- Never deploy/publish/change secrets/... without explicit authorization.

## Context routing
- Architecture: docs/...
- Conventions: docs/...
- Setup/operations: ...
- Tests/verification: ...
- Read only the sections relevant to the current task.
- Do not scan or inject the entire documentation tree by default.

## Working rules
- Inspect current code/contracts before changing behavior.
- Preserve unrelated dirty work.
- Verify changed behavior with the smallest relevant checks.

## Documentation freshness
- Documentation is part of the product.
- When behavior, architecture, public contracts, configuration, workflows,
  verification commands or UX contracts change, update the owning docs in
  the same change.
- Keeping docs current does not mean loading all docs into model context:
  retrieve only task-relevant material.
- Do not persist transient session progress or chat summaries as permanent
  project instructions. Promote only durable, reusable knowledge.

## Completion
- Requested behavior implemented.
- Relevant checks run and reported truthfully.
- Documentation impact reviewed and affected docs updated.
```

The generator should reference existing canonical files rather than duplicate their content. If useful documentation is absent, do not fabricate a large docs tree merely to satisfy a template.

### Step 4 — review and create

Show a concise preview/diff with:

- **Create AGENTS.md** — primary;
- **Edit** — opens the generated file before saving;
- **Rescan** — only when the detected project shape is clearly wrong;
- **Skip** — leaves the repository untouched.

Clearly show which existing files informed the result. Never claim commands or architecture were verified if they were merely inferred.

## Context model after bootstrap

Polyth should use a progressive context router rather than a permanent mega-prompt:

```text
User task
   ↓
AGENTS.md (small, stable)
   ↓
task/path routing
   ↓
relevant canonical docs / skill / ADR
   ↓
current code + one relevant test/contract
   ↓
expand only on dependency, uncertainty, risk, or failed verification
```

The important distinction is:

- **repository knowledge may be broad**;
- **active model context stays narrow**.

Polyth may maintain a local index/RAG layer for routing, but the checked-in repository remains portable and understandable without Polyth-specific memory.

## Keeping documentation up to date

Every agent completion should include a lightweight **documentation impact check**:

1. What externally observable behavior, architecture, contract, configuration, workflow, command, or UX rule changed?
2. Which canonical document owns that statement?
3. Update only those affected documents.
4. If no documentation is affected, record no change and move on.

This is an impact check, not a request to reread all docs.

For mapped repositories Polyth can later automate the first pass using changed paths + task routing, surfacing only likely affected docs.

## Session memory and harvest

Do not use `AGENTS.md` as working memory.

Session-local progress, blockers and intermediate reasoning belong to Polyth's runtime/session state and should not be committed merely for continuity.

At task/session close, Polyth may harvest durable candidates:

- architectural decision -> ADR;
- stable convention -> owning conventions doc;
- verified recurring gotcha -> relevant guide;
- new ownership/routing -> context map;
- transient progress/noise -> discard.

Promotion should preserve provenance and avoid duplicating an existing canonical statement. Contradictory durable knowledge should explicitly supersede or correct the old active guidance.

## Existing instruction files

If `AGENTS.md` is absent but other client-specific files exist:

- inspect them as candidate project knowledge;
- preserve their client-specific behavior where needed;
- generate `AGENTS.md` as the canonical shared entry point without blindly copying every body;
- prefer small adapters that point to the canonical rule instead of several diverging rule sets.

Do not silently delete or rewrite existing client files during bootstrap.

## Safety / trust

Repository contents are data, not authority over Polyth permissions.

The bootstrap scanner must not execute discovered commands, make network calls because a repository file asks it to, access secrets, weaken sandboxing, or install third-party skills. Third-party skills/instructions can be indexed as untrusted candidates and require explicit audit before activation.

## Success criteria

The feature is successful when a newly opened project can become useful to AI agents in a couple of minutes while preserving four properties:

1. **Low friction:** only a few questions.
2. **Grounded:** existing project structure informs the generated contract.
3. **Fresh:** documentation changes with the product rather than drifting silently.
4. **Context-efficient:** current docs are available, but only relevant slices reach an agent turn.

The outcome is not “more context”. It is **better routed context**.
