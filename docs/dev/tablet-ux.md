# Tablet / iPad UX

Status: in progress (`worktree-tablet-ux`). Ponytail **ultra** — smallest change
that meets the spec, no parallel component trees, no new shell mode.

## Inspection: what already exists

The tablet spec describes a lot of behaviour Polyth already ships. Verified in
this codebase:

| Spec ask | Already implemented |
|---|---|
| §3 three workspace states (chat / split / focus) | `store.paneMode`: _none_ / `pinned` / `fullscreen`, plus `dynamic` (floating). `surfaces.decideDock` + `CHAT_FLOOR` + the layout guard in `ContextRail.tsx`. |
| §3 open-as-slide-over → pin → split → focus → return | `dynamic` overlay → `togglePanePin` → `pinned` → `togglePaneFullscreen`. `closeWorkspacePane` returns to chat. |
| §4 resizable divider, min/max, touch + keyboard resize | `.rail-resize` separator, `clampDockWidth`, pointer + arrow-key handlers in `ContextRail.tsx`. |
| §4 package preferred min width / split ratio | `RailSurface.presentation.minWidth` / `defaultRatio` / `preferredMaxWidth`. |
| §5 remember layout per context | `polyth.workspacePane.v2.<projectId>` (widths, heights, pinned-open set), `polyth.railPrefs`, `widgets/workspaceMode.ts` (`polyth.workspaceMode.v1.<projectId>`). |
| §6 portrait / narrow: nav off-canvas drawer + tools off-canvas | `shellMode === "compact"` (≤820px): `.sidebar.open` drawer + `.sidebar-backdrop`; contextual panels → `.panel-sheet`; workspace panes → full-screen layer. `Sidebar.tsx` / `ContextRail.tsx` already branch on this. |
| §1 selection UI only after entering select mode | `Sidebar.tsx` `selectMode` state; the bulk bar is `{selectMode && …}`; "Select sessions" lives in the project `⋯` menu. Already correct. |
| §1 compact search that expands | `compact`: search is behind the toolbar `SearchIcon` (`searchOpen`); `wide`: always-on field. Already correct. |
| §2 dock generated from the same source as other package nav | `.rail-icon-col` in `ContextRail.tsx` is built from `useResolvedCapabilities()` + `visibleSurfaces()` — not a hand-maintained list. |
| §11 touch-first, pointer-enhanced | media queries already split `(pointer: coarse)` / `(hover: hover)` throughout `styles.css`. |
| §14 frosted glass system | `tokens.css` `--material-glass-*` + the two `@supports … blur` blocks in `styles.css`. |
| §12 container-responsive layout primitive | `@container` already used for `usage-dashboard`, `feature-panel`, `composer-widget`, `workspace-panel`, etc. `styleArchitecture.test.ts` rewards it and rejects `@media max-width` for those surfaces. |

The single JS breakpoint seam is `responsiveShell.ts` (`COMPACT_MAX_WIDTH = 820`,
`PHONE_MAX_WIDTH = 480`). `responsiveShell.test.ts` pins those literals as a
contract; the CSS twins them with `(max-width: 820px)` / `(max-width: 480px)`.

## The actual gap

On desktop (`@media (min-width: 821px)`) `.railbar` is **already
`position: absolute; inset-inline-end: 0`** — out of flow, zero layout width.
The `.rail-icon-col.plugin-strip` (~44px) floats on the right edge over the
conversation's gutter.

That is fine at desktop widths where the gutter is wide. At iPad-class widths
(≈1024–1366 landscape, and portrait > 820) the sidebar (272px) leaves a
workspace narrow enough that the conversation gutter shrinks below the strip
width, so the strip **overlaps chat text**, and the shell reads as a cramped
three-column desktop.

Nothing else in the spec needs new architecture — the pane model already does
overlay / pin / split / focus, and ≤820 already does the off-canvas story.

## Change (this branch)

**One container-query layout state on `.app-shell`.** No JS, no new `ShellMode`,
no `responsiveShell.ts` / contract-test churn, no parallel components.

1. `.app-shell { container: app-shell / inline-size; }` (it is already
   `position: relative`, so `.railbar` anchoring is unchanged).

2. `@container app-shell (max-width: 1400px)` — "wide shell, tablet-class width":
   - Collapse `.rail-icon-col.plugin-strip` from a full-height edge bar to a
     compact top-anchored floating cluster (auto height, glass, rounded). This
     is the spec's "subtle edge affordance / compact trigger" (§2).
   - Give the three chat surfaces (`.timeline`, `.composer-chat`, activity strip)
     a right inset that clears the cluster's lane, restated from the existing
     `max(--gutter, (100% - --chat-measure)/2)` centring formula + the cluster
     width. Content never renders under the affordance; no symmetric column is
     reserved.
   - Opening a tool → existing `dynamic` pane (slide-over, does not resize chat)
     → user pins → existing `pinned` split → expand → existing `fullscreen`.
   - `> 1400px` (real desktop) keeps the current permanent strip untouched (§16).
   - `≤ 820px` keeps the current `compact` drawer/sheet shell untouched (§6, §16).

## To do

- [ ] Plan doc committed + pushed
- [ ] `.app-shell` container + `@container` tablet layout state in `styles.css`
- [ ] Verify pinned-split / dynamic-overlay / fullscreen still correct in the band
- [ ] Verify chat text, code blocks, tool output clear the affordance (no overlap)
- [ ] Verify ≤820 compact and >1400 desktop unchanged
- [ ] `styleArchitecture.test.ts` + `responsiveShell.test.ts` + `moduleView.test.ts` green
- [ ] Add one assertion: `.app-shell` uses `container: app-shell / inline-size`
- [ ] `npm run build:web` (typecheck) green
- [ ] Inspect final diff for duplicated responsive logic
- [ ] Open PR to `master`

## Deliberately NOT doing (challenge the spec)

- **No new `tablet` `ShellMode`.** ~20 call sites + `paletteOrdering` +
  `responsiveShell.test.ts` "contract" assertions for one layout state that a
  container query expresses in one block. Add it only if a real interaction
  turns out to need JS, not CSS.
- **No composer / activity / header restructure.** They are shared with desktop
  (§16 "Desktop must remain excellent … do not fix tablet by altering desktop").
  The idle composer and the thin activity strip already exist; the wide header's
  tool rail is desktop-intentional. Revisit only if the band still feels heavy
  after the rail change.
- **No navigator rebuild.** 272px is already inside the spec's 280–310 target,
  and the selection / search chrome complaints (§1) are already addressed in
  `Sidebar.tsx`.
- **No widening of `COMPACT_MAX_WIDTH`.** Portrait iPad (834–1024) stays in the
  wide shell but, with the rail no longer overlapping, is a usable
  nav + workspace + on-demand tools layout. Widening the breakpoint is a
  behaviour change for half-snapped desktop windows and breaks a pinned
  contract test — not worth it for this branch.
