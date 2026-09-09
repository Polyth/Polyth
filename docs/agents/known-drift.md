# Confirmed documentation drift at the audit baseline

Baseline: `d70f875ecb919a0a7d59488fc7ddafc47915b558`, inspected 2026-09-09. These are historical findings, not permanent present-day capability claims. Recheck a source when its hash changes. The original active entry files listed in `replaced-files.json` are replaced by this kit; deeper documents are retained, not secretly rewritten.

| Previous assertion or shortcut | Evidence / correction | Consequence |
| --- | --- | --- |
| Old AGENTS said no CI exists | `.github/workflows/ci.yml` is real and invokes selected typechecks/build/tests | Read actual command ownership; absence of a root lint script is not absence of CI |
| Every package export has the same root form | `packages/commands/package.json` has a dedicated `./catalog` alongside Node-backed root and other subpaths | Verify the exact import; do not leak Node imports into browser code |
| OpenCode-only project framing | Backend directories and current Codex runtime implement multi-harness machinery | Keep canonical sessions/provider seams; do not infer equal adapter capabilities |
| Historical multi-harness table says Codex has no attachments/usage/steering/compaction | Current `CODEX_CAPABILITIES` declares image/URL, usage, steering and compaction; file/PDF/audio remain declared unsupported in that snapshot | Table is stale. Declaration itself still does not prove every live path works |
| Native bridge/interface implies mobile Link completion | `apps/mobile/src/polythLink.ts` defaults to `MissingNativeCore`; Link architecture explicitly says production native pairing not included | Trace actual native registration/build/call and device evidence |
| A particular private IP/port is mandatory; another port's instance should be killed | Old runbook mixed one developer's live environment with universal guidance | Confirm identity; isolate ports/data; never kill unknown instances |
| Always use a fixed named model and mandatory subagent tree | Cursor role files pinned a model and assumed delegation | New roles are capability/availability based and require evidence |
| General development always requires the live control MCP | Legacy control skill claimed any Polyth interaction | Narrow live-control scope; code work remains usable without MCP |

The old feature tutorial also included a non-self-contained route snippet (`foo` not defined), a scoped-service omission, and test invocation without explicit type stripping. The replacement points to actual source examples and current scoped seams instead of distributing a pretend copy-paste-ready service.

## How to use retained deep documents

`docs/dev/ui.md`, `components.md`, `widgets.md`, `styles.md`, `architecture.md`, Space/Link designs and historical plans remain useful references. Their presence does not imply this audit verified every statement. Read only relevant sections and reconcile exact signatures/numeric limits/readiness claims with current implementation. Old verification counts remain historical evidence, never an exclusion policy for present failures.
