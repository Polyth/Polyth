# Phase 3 Wave 2 — product UX handoff

Wave 2 status: **complete**. Its production changes are already shipped on
`feat/phase-3-product-ux-mobile-bb96`; Wave 3 must build on them rather than
reimplementing them.

## Implementation order completed

This maps the shipped work to the execution order in
`phase-3-product-ux.md` §3:

1. **Command slot bridge:** `c67b044e` added the validated package command
   adapter in `apps/web/src/commandBridge.ts`.
2. **Palette re-base and phone surface:** `93f920bf` and `19647387` moved the
   existing palette onto the adaptive overlay and added pure phone/desktop
   ordering in `apps/web/src/paletteOrdering.ts`.
3. **Shared session status:** `6105ebfd` introduced
   `apps/web/src/sessionStatus.ts` and reused the projection-derived taxonomy.
4. **Recovery surfaces:** `b564478f` and `6fd69dce` added delayed reconnect,
   unavailable-send retry, and failed-turn recovery without replacing useful
   session content.
5. **Session search:** `0fb92a22` and `a85d3ec0` added project and status
   facets while preserving the palette/content-search boundary.
6. **Starter picker:** `cd8b02c3` and `caf258ec` made the canonical picker
   adaptive and reachable through the palette without changing never-auto-send.
7. **Shell polish:** `2ee6a997` and `ed1815f8` made bottom navigation
   phone-only, exposed the notification-centre shortcut, quieted the context
   gauge below 60%, and documented phone Canvas scope.
8. **Palette session verbs:** `18acfc44` added the existing session actions
   through `apps/web/src/sessionActions.ts`; delete remains outside the palette.

The optional dense-label follow-up shipped in `e3ad80f2` and `49ff3a9f` as a
local searchable sheet when a session has more than six labels. Architecture
documentation was updated in `c0146a64`. Merge commit `5382016f` reconciled
master while retaining the feature-branch implementations.

## Decision mapping

- **D1–D3:** one registry and one palette remain; package commands cross the
  typed slot bridge, `Mod+K` remains the palette, and form-factor ordering is
  adaptive rather than forked.
- **D4:** the palette acts and jumps; Session Search owns transcript/content
  search and now supports all-projects plus running/waiting facets.
- **D5–D6:** the existing starter model and session hero remain canonical;
  the adaptive picker fills the composer and never sends.
- **D7–D8:** session continuity uses shared projection status, and palette
  actions reuse the frozen session verb set.
- **D9:** recoverable failures remain inline and preserve useful state.
- **D10:** the existing notification architecture gains its declared default
  phone shortcut and hotkey.
- **D11–D13:** entry remains resume-first; the palette is a phone sheet, and
  compact/tablet widths use the desktop navigation hierarchy.
- **D14–D15:** phone Canvas remains deferred and no native/platform fork was
  introduced.
- **D16:** the context gauge appears only at 60% or greater, Canvas scope is
  explained, and dense labels use a searchable sheet.
- **D17:** shared session status remains the integration seam for deeper
  Multirun and Fusion work in Wave 3.
- **D18:** all surfaces stay in one adaptive web codebase.

## Key files

- `apps/web/src/commandBridge.ts`
- `apps/web/src/components/CommandPalette.tsx`
- `apps/web/src/paletteOrdering.ts`
- `apps/web/src/sessionActions.ts`
- `apps/web/src/sessionStatus.ts`
- `apps/web/src/components/SessionSearch.tsx`
- `apps/web/src/components/mobile/StarterPicker.tsx`
- `apps/web/src/components/sidebar/SessionList.tsx`
- `apps/web/src/components/workspace/WorkspaceBottomNav.tsx`
- `apps/web/src/components/recovery/`
- `docs/dev/architecture.md`

## Behavioral guardrails

- A transient disconnect is quiet for three seconds, then becomes a reconnect
  pill. OpenCode `503 unavailable` remains an inline retry with the draft
  preserved. Raw WebSocket errors are never user-facing.
- Typing in the session list must not trigger a full list rerender. Dense-label
  filtering is local state inside the label sheet.

## Validation state

No tests were rerun while creating this handoff. Wave 3 validation must run the
targeted Multirun, Fusion, status, and web tests plus the `apps/web` typecheck;
the final Wave 3 handoff must record the exact commands and results.

## Wave 3 starting point

Read this handoff, `phase-3-product-ux.md`,
`phase-3-wave-1-handoff.md`, `packages/multirun`, `packages/fusion`, and
`apps/web/src/sessionStatus.ts` before implementation.

The principal UX risk is `MultiRunView`: it currently renders full-markdown run
cards side by side. On phones it must become overview → selected-run detail;
desktop should retain a summary and selected detail without becoming a
benchmark dashboard.
