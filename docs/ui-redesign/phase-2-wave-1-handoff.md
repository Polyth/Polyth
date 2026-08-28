# Phase 2 — Wave 1 handoff: navigation & information architecture

Scope: sidebar, project/session hierarchy, session states, row actions,
sort/filter, new session, add project, drawer/mobile navigation. Branch:
`feat/ui-redesign-phase2-2baf`.

## UX decisions

### Hierarchy: Project → branch/worktree → session (typography, not tree chrome)

Kept the existing three-level structure and its indent/typography contract
(`--nav-indent-*`, `--nav-*-size` tokens): project rows are the heaviest
(650 weight, folder glyph), worktree group heads secondary, session rows
regular-weight with a small fixed indent. No new tree chrome, connectors, or
horizontal-space spend.

### Session row: title first, one contextual trigger

- The title column gets the full row on fine pointers: `.session-btn`
  right-padding dropped from a permanently reserved 44px to 8px. The row's
  single menu trigger (`.session-menu-trigger`) reveals on hover/focus and
  paints over the *faded* status zone instead of reserving a column.
- Coarse pointers and drawer layouts (`(pointer: coarse), (max-width: 820px)`)
  keep the trigger persistent at 44px and re-reserve its footprint so the
  timestamp never slides beneath it; the hover fade is disabled there.
- Session states (no new types): unread = 600-weight title + neutral dot;
  running = pulsing glyph + elapsed timer in accent; waiting for user =
  accent question mark; waiting for approval = `--warning` (amber) check.
  Reply/approval indicators now carry hue; unread stays neutral because the
  strengthened title already flags it.

### Row actions: one entry point per input mode (candidates #4, #8)

- The hand-rolled `.session-menu` (~80 lines of bespoke dismissal/keyboard/
  focus logic + its CSS) is deleted. The row menu is `ui/Menu`, reached by
  the trigger, right-click, long-press (550ms), and Shift+F10/ContextMenu key.
  Focus returns to whichever element opened it (`returnFocusRef` set per
  opening).
- The Shift-hover quick-action layer is **removed**. Swipe remains a
  touch-only accelerator; its Archive/Delete buttons render only while the
  gesture is dragging/revealed (no resting DOM, no extra tab stops). At rest
  a row has exactly two interactive elements: open button + menu trigger.
- Labels are `menuitemcheckbox` entries with color swatches inside the row
  menu; checkbox entries keep the menu open for multi-toggle.

### Project row: two contextual actions

- Grid simplified to `minmax(0, 1fr) auto` — the title track wins, actions
  (`.project-actions`: new session + overflow menu) take only what they need.
- Actions are hover/focus-revealed under `(hover: hover) and (pointer: fine)`
  and persistent (44px) on coarse pointers and in the drawer. The worktree
  button moved into the overflow `ui/Menu` (Select sessions / New session in
  worktree / Import / Rename / Appearance / Git / Close project), which also
  hosts the `sidebar.project.actions` slot as a menu footer.

### Sidebar chrome

- Sort + filter merged into one service-bar `ui/Menu` ("Sort and filter",
  `.sidebar-list-options`) with `menuitemradio` sort entries and a
  `menuitemcheckbox` "Needs attention" filter (candidate #3 shipped: `kind`,
  `checked`, `aria-checked`, check glyph from state, swatches, headings).
  The dedicated `.sidebar-list-controls` row is deleted — one row of chrome
  saved above the list.
- Global "New session" (compose icon, accent) sits next to search; each
  project row keeps its own contextual new-session action. No CTA cards.
- "Add project" is a quiet full-width row after the project list; the
  no-projects state uses the `EmptyState` primitive with an "Open project"
  action. `ProjectFolderDialog`'s focus-restore fallback now targets these.

### ui/Menu primitive extensions (used by all of the above)

`MenuAction.kind` ("action" | "radio" | "checkbox") + `checked` + `swatch`;
`MenuHeading` entries; controlled `open`/`onOpenChange`; `returnFocusRef`
(threaded to `useDismissibleMenu.restoreRef`); `footer` slot. Checkbox
selection does not close the menu. Sheet items map checked state to
`aria-pressed` (sheet buttons are not menuitems).

## Touched files

- `apps/web/src/components/ui/Menu.tsx`, `components/a11y/Menu.ts`,
  `components/ui/index.ts` — primitive extensions.
- `apps/web/src/components/sidebar/SessionList.tsx` — row rewrite (menu,
  trigger, swipe-only quick actions, Shift-hover machinery removed).
- `apps/web/src/components/Sidebar.tsx` — service bar, project rows, empty
  state, add-project row.
- `apps/web/src/components/ProjectFolderDialog.tsx` — focus-restore fallback.
- `apps/web/src/components/mobile/SessionMenu.tsx` — deleted (orphaned since
  the feature-package refactor; drawer + row menu cover it).
- `apps/web/src/styles.css` — nav geometry/reveal rules; dead CSS removed
  (`.session-menu*`, `.session-more-btn`, `.quick-armed`, `.sidebar-sort*`,
  `.sidebar-list-controls`, `.project-worktree-btn`, `.project-actions-menu`,
  `.side-open-project`, `.label-dot`, menu z-index hacks); menu
  check/swatch/heading styles.
- `apps/web/src/i18n/locales/*` — one new key `sidebar.listOptions` (12
  locales).
- Tests: `sessionRowMenu` (rewritten), `sidebarNavigationGeometry`,
  `sidebarHeaderPolish`, `sidebarFolderMode`, `interactionPolish`,
  `responsiveShell`, `uiPrimitives` (+2 Menu semantics tests).
- Dev QA: `scripts/ui-nav-check.mjs` (new), `scripts/ui-sidebar-check.mjs`
  (updated to the merged menu).

## Validated

- `npm run build`, `npx tsc --noEmit` (apps/web), `npm test`: 1546 pass /
  0 fail (2 pre-existing skips).
- Browser QA (playwright + real server, seeded projects/sessions; statuses
  patched onto API responses): desktop 1280, tablet 768 touch, phone 390,
  narrow 320. Verified: hover/focus trigger reveal + status fade; row menu
  via trigger, right-click, Shift+F10 with arrow cycling, Escape, correct
  focus return; project action reveal + overflow menu; merged sort/filter
  roles and stay-open checkbox; long titles ellipsize; 100-session density
  (38px rows); EmptyState for zero projects; add-project row; persistent
  44px triggers with reserved padding on touch (timestamp never clipped);
  phone menus present as sheets.

## Known issues / for later waves

- Sheet-presented menus keep the P1 convention of no `menu`/`menuitem` roles
  (buttons + `aria-pressed`); if Wave 2+ adds richer sheets, revisit.
- `scripts/ui-evidence.mjs`, `ui-states.mjs` and other legacy dev scripts may
  still reference pre-P2 selectors; only `ui-sidebar-check.mjs` was updated.
- Sheet checkbox entries currently close the sheet only for non-checkbox
  entries (same as desktop); sheet stays open on label toggles — intended,
  but phone UX for many labels may want a dedicated "Labels…" subsheet
  (candidate for phase-3).
- The `.session-worktree-label` pill on pinned rows can still crowd very
  narrow sidebars with long branch names; acceptable now (it ellipsizes),
  flagged for a future pinned-row treatment.
- Wave 2 (chat/thinking/tools) note: the row-status derivation
  (`sessionBadges.ts`) is untouched; navigation now expects approval =
  `--warning` hue — keep chat-surface approval affordances consistent.

## Product decisions taken (phase-2-candidates)

- **#3 Menu radio/checkbox semantics — shipped** (see candidates file).
- **#4 Row-action consolidation — decided:** hover-reveal trigger on fine
  pointers / persistent trigger on coarse; Shift-hover layer dropped; swipe
  kept as touch accelerator only.
- **#8 Session-row menu on ui/Menu — shipped**, including long-press,
  context-menu, Shift+F10 entry points and label toggles.

Statuses recorded inline in `phase-2-candidates.md`.
