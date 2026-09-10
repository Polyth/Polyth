# Bundled workflow samples

Polyth ships three small, real workflows as executable examples. They are not special execution modes: each sample is copied into a project once and then behaves exactly like any workflow the user created in the builder. Users may run, edit, rename, or delete it. Deleted samples are not recreated.

The samples have two jobs:

1. give a new user useful workflows they can run immediately;
2. exercise the workflow engine's canonical orchestration patterns in ordinary product use and tests.

All samples intentionally use the existing DAG engine only. They do not pretend that loops, conditional branches, or explicit human-gate nodes exist before those primitives are implemented.

The composer workflow launcher recognizes an untouched bundled sample by its canonical name, shows its short description, and can run it even when the task field is empty. In that case the sample's bundled example input is used. Entering any task always takes precedence. This behavior needs no workflow schema or API extension; sample metadata comes from the browser-safe catalog.

## 1. Example · Build & Review

**Use case:** software implementation with independent review and verification.

**Example input:**

> Add a compact keyboard-shortcuts help dialog to this application. Reuse existing UI primitives and keep the change minimal.

```text
Codebase Scout
      ↓
Implementation Planner
      ↓
Builder
   ┌──┴──┐
   ↓     ↓
Reviewer Verifier
   └──┬──┘
      ↓
Finalizer
```

What it demonstrates:

- sequential hand-off;
- a node that mutates the working tree;
- independent parallel review and verification;
- fan-in of separate findings into a finalizer;
- ancestor context propagation;
- reuse of the same project/worktree across agent sessions.

Expected behavior:

- Scout and Planner do not edit files.
- Builder performs the requested implementation.
- Reviewer inspects the actual diff and reports actionable findings without editing.
- Verifier runs relevant checks without editing.
- Finalizer repairs only confirmed problems and reruns the relevant checks.
- Default permission policy is `manual` because the example can modify the open project.

This is the most representative engineering sample and should remain conservative: minimal diff, reuse before invention, no speculative abstraction, and no weakening of security/accessibility/data-safety checks.

## 2. Example · Research & Decide

**Use case:** compare options and turn research into a decision rather than a pile of summaries.

**Example input:**

> Choose a database for a small analytics product. Compare PostgreSQL, ClickHouse, and DuckDB for ingest, analytics queries, operations, ecosystem, and cost, then recommend a default and explain when the answer changes.

```text
Research Lead
      ↓
 ┌────┼────┐
 ↓    ↓    ↓
Primary Practical Risk & Cost
 └────┼────┘
      ↓
Evidence Critic
      ↓
Decision Maker
```

What it demonstrates:

- decomposition before research;
- parallel independent perspectives;
- primary-source versus practical/community evidence;
- explicit uncertainty and source quality;
- reconciliation before recommendation;
- one decision node receiving the full ancestor context.

The sample is deliberately domain-neutral. It can be used for technology selection, vendor comparisons, hardware purchases, product strategy, travel choices, or other decisions. Researchers should use available tools and sources, but must mark facts they cannot verify rather than fabricate evidence.

## 3. Example · Content Studio

**Use case:** turn one product/campaign brief into coordinated multi-channel launch material.

**Example input:**

> Launch a privacy-first password manager for freelancers. The tone should be confident and human, never fear-based. Prepare a compact launch package for an English-speaking audience.

```text
Creative Lead
      ↓
  ┌───┴───┐
  ↓       ↓
Audience  Market
  └───┬───┘
      ↓
Messaging Strategist
   ┌──┼──┐
   ↓  ↓  ↓
Landing Email Social
   └──┼──┘
      ↓
Managing Editor
```

What it demonstrates:

- one brief becoming specialized parallel work;
- research feeding a shared strategy rather than independent copy silos;
- fan-out into channel-specific outputs;
- final editorial fan-in;
- artifact-style structured output without requiring a custom package.

The writers must not invent customer quotes, metrics, certifications, traction, urgency, or product capabilities. The final editor keeps unresolved proof requirements visible instead of polishing them into unsupported claims.

## Source layout and seeding

The browser-safe definitions and example metadata live in `packages/workflow/src/sampleCatalog.ts`. Server-only persistence/seeding lives in `packages/workflow/src/samples.ts`.

On the first `GET /api/workflows?projectId=...` for a project, the workflow package copies any not-yet-seeded samples into that project. A small package-owned sidecar (`workflow-samples.json`) records sample keys already offered to each project.

This gives the desired semantics:

- new and existing projects receive the current bundled examples;
- opening the workflow UI a second time does not create duplicates;
- adding a new bundled sample later seeds only that new sample;
- once seeded, examples are ordinary user-owned workflow definitions;
- editing or renaming an example does not cause a replacement copy to appear;
- deleting an example is respected and it stays deleted;
- if the sidecar is missing but an exact sample name already exists, the seeder adopts it rather than duplicating it.

A renamed sample intentionally stops receiving special launcher presentation because it is now user-owned/customized. Its workflow definition continues to work normally.

## Canonical coverage

Together the three samples exercise the workflow primitives we currently want users and tests to understand:

| Primitive | Build & Review | Research & Decide | Content Studio |
| --- | --- | --- | --- |
| Sequential layers | yes | yes | yes |
| Parallel execution | yes | yes | yes |
| Fan-out | yes | yes | yes |
| Fan-in | yes | yes | yes |
| Ancestor context | yes | yes | yes |
| Working-tree tools | yes | optional | optional |
| Independent critique | yes | yes | yes |
| Structured final artifact | summary | recommendation | launch package |

Future samples should be added only when they demonstrate a materially different, already-supported orchestration pattern or cover a major user segment. Avoid a large gallery of near-duplicate templates.

## Smoke tests

For a manual product smoke test:

1. Open any project and open the workflow launcher.
2. Confirm all three `Example · ...` workflows appear once and include a short explanation.
3. With the task field empty, run Research & Decide or Content Studio and confirm the bundled example input is used.
4. Open Workflows and inspect each definition's graph/layers.
5. Run Build & Review and confirm tool actions that can mutate the project require manual permission.
6. Confirm parallel nodes overlap in the run timeline where the selected harness permits it.
7. Edit or rename a sample and reload Workflows; confirm the edited copy remains and no replacement appears.
8. Delete a sample and reload; confirm it remains deleted.
9. Open a different project; confirm that project receives its own three examples.
