---
name: polyth-design
description: Maintain Polyth design, CSS, tokens, accessibility and responsive states while respecting appearance and resource preferences.
---
# Design, styling and accessibility

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context design`. This command is a navigation aid, not an audit.

- `apps/web/src/tokens.css`
- `apps/web/src/theme.ts`
- `apps/web/src/uiPrefs.ts`
- `docs/dev/styles.md`
- `docs/dev/components.md`
- `docs/agents/ui-checklist.md`

## Workflow and constraints
Identify the actual surface and user state before adjusting pixels. Preserve Polyth's restrained, compact visual language: clear hierarchy, quiet materials, consistent spacing and radii, readable technical content. This is a maintenance direction, not permission to redesign unrelated screens or remove controls.

Read the relevant sections of the style and component guides, then inspect current tokens and preference application. Reuse semantic color, type, spacing, radius, motion and hit-area roles; do not freeze copied numeric values or reproduce the token catalog here. Compact visible controls still need adequate coarse-pointer hit areas. Keep feature selectors under their stable package root. Use container responsiveness for embedded content; viewport rules belong to shell-level adaptation.

Respect existing transparency, performance/resource, font-size, density and radius settings. Glass must have an opaque fallback; reduced motion must not remove state information. Phone pickers are compact anchored Quiet Glass popovers beside their trigger; bottom sheets are for destinations, not ordinary selection lists. Fades and masks must not hide actionable or selected text. Do not use decorative color as the only status signal. Verify contrast and text scaling rather than assuming token use guarantees accessibility.

Inspect light/dark, narrow/wide, keyboard open/closed, long labels, translated text, focus, hover and touch. Use real screenshots of the running implementation when available, with viewport and state recorded. Screenshot plausibility alone does not prove interaction correctness. A CSS or build test is not visual verification; label missing browser/device access explicitly. Do not add a screenshot-test framework merely to change one spacing token.

## Verification and handoff
Suggested test locations (confirm current files first): `apps/web/test/packageContainment.test.ts`

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
