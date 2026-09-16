# Tablet / iPad UX

Status: implemented (`worktree-tablet-ux`, PR #141). Smallest change that meets
the spec: no parallel component trees, no new shell mode, no device detection.
Two seams move — the compact-shell boundary (a constant) and the idle right
rail (one container query). Everything else the spec asks for already shipped.

## Inspection: what already exists

The tablet spec describes a lot of behaviour Polyth already ships. Verified in
this codebase:

| Spec ask | Already implemented |
|---|---|
| §3 three workspace states (chat / split / focus) | `store.paneMode`: _none_ / `pinned` / `fullscreen`, plus `dynamic` (floating). `surfaces.decideDock` + `CHAT_FLOOR` + the layout guard in `ContextRail.tsx`. |
| §3 open-as-slide-over → pin → split → focus → return | `dynamic` overlay → `togglePanePin` → `pinned` → `togglePaneFullscreen`. `closeWorkspacePane` returns to chat. |
| §4 resizable divider, min/max, touch + keyboard resize | `.rail-resize` separator, `clampDockWidth`, pointer + arrow-key handlers in `ContextRail.tsx`. |
| §4 package preferred min width / split ratio | `RailSurface.presentation.minWidth` / `defaultRatio` / `preferredMaxWidth`. |
| §5 remember layout per context | Project records mirror `polyth.workspacePane.v2.<projectId>` (widths, heights, pinned-open set) and `widgets/workspaceMode.ts` (`polyth.workspaceMode.v1.<projectId>`); `polyth.railPrefs` remains device-local. |
| §6 portrait / narrow: nav off-canvas drawer + tools off-canvas | `shellMode === "compact"` (≤`COMPACT_MAX_WIDTH`, 960px): `.sidebar.open` drawer + `.sidebar-backdrop`; contextual panels → `.panel-sheet`; workspace panes → full-screen layer. `Sidebar.tsx` / `ContextRail.tsx` already branch on this. |
| §1 selection UI only after entering select mode | `Sidebar.tsx` `selectMode` state; the bulk bar is `{selectMode && …}`; "Select sessions" lives in the project `⋯` menu. Already correct. |
| §1 compact search that expands | `compact`: search is behind the toolbar `SearchIcon` (`searchOpen`); `wide`: always-on field. Already correct. |
| §2 dock generated from the same source as other package nav | `.rail-icon-col` in `ContextRail.tsx` is built from `useResolvedCapabilities()` + `visibleSurfaces()` — not a hand-maintained list. |
| §11 touch-first, pointer-enhanced | media queries already split `(pointer: coarse)` / `(hover: hover)` throughout `styles.css`. |
| §14 frosted glass system | `tokens.css` `--material-glass-*` + the two `@supports … blur` blocks in `styles.css`. |
| §12 container-responsive layout primitive | `@container` already used for `usage-dashboard`, `feature-panel`, `composer-widget`, `workspace-panel`, etc. `styleArchitecture.test.ts` rewards it and rejects `@media max-width` for those surfaces. |

The single JS breakpoint seam is `responsiveShell.ts` (`COMPACT_MAX_WIDTH`,
`PHONE_MAX_WIDTH = 480`). `responsiveShell.test.ts` pins those literals as a
contract; the CSS twins them with `(max-width: …px)` / `(max-width: 480px)`.

## The two gaps

**1. The compact-shell boundary sat at 820.** `≤ 820` = drawer navigator;
`≥ 821` = a permanent navigator (`SIDEBAR_DEFAULT_WIDTH` 332px, user-resizable
280–440). An ~834px portrait iPad — or a half-snapped desktop window —
therefore got a persistent navigator with a cramped workspace beside it: the
"desktop squeezed into a tablet" the spec names outright. 820 was never a space
decision, just the old phone-vs-not line.

**2. The idle right rail read as a third column.** On the wide shell
`.railbar` is **already `position: absolute; inset-inline-end: 0`** — out of
flow, zero layout width — but its `.rail-icon-col.plugin-strip` (~44px) is
full-height and floats over the conversation's gutter. Fine at desktop widths
where the gutter is wide; at tablet-class widths the persistent navigator
squeezes the gutter below the strip width and the strip **overlaps chat text**.

Nothing else in the spec needs new architecture — the pane model already does
overlay / pin / split / focus, and the compact shell already does the whole
off-canvas story (drawer nav, sheet panels, full-screen panes).

## Change (this branch)

No new `ShellMode`, no parallel components, no device detection. Two seams move.

### A. Compact-shell boundary 820 → 960 (`responsiveShell.ts`)

`COMPACT_MAX_WIDTH` is now `960`, chosen from the real space budget:
`SIDEBAR_DEFAULT_WIDTH` (332px) + ~620–628px of comfortable primary workspace
≈ 960. Below 960 the existing `compact` shell owns the layout: navigator as a
drawer, panels as sheets, panes full-screen — the spec's single-stage portrait
composition, already built, now reached at every width that cannot afford a
persistent navigator beside a usable workspace.

- Every portrait iPad (768 / 810 / 820 / 834) → drawer navigator, single stage.
- Half-width / half-snapped desktop windows ≤960 (incl. half of a 1920 screen)
  → drawer navigator.
- 1024 portrait → **wide**: 684px primary workspace / ~580px conversation lane
  beside the 332px navigator is comfortably usable (rendered). This is a space
  decision, not an orientation one — a portrait tablet wide enough keeps the
  persistent navigator.
- Every landscape iPad (1080 / 1180 / 1194 / 1366) → persistent navigator.
- CSS twins move with the constant: `(max-width: 820px)` → `960`,
  `(min-width: 821px)` → `961`, `(max-width: 1100px) and (min-width: 821px)`
  header rule → `961`, the `@container` band lower bound → `961`;
  `sidebarPresentation.ts` `SIDEBAR_NARROW_QUERY` → `(max-width: 960px)`.
  (Five pre-existing bare `@media (max-width: 900px)` rules are unrelated and
  stay.) `responsiveShell.test.ts` pins the literal and the boundary matrix
  (`834` / `959` / `960` / `961` / `1024` / `1080` anchors); the CSS-contract
  test now checks `(max-width: 960px)` **and** `(min-width: 961px)`.

**The 960 → 961 seam is a real shell transition, not a smooth ramp.** Shell-mode
classification is monotonic (`compact` → `wide`, one rank change, no
regression), but the *layout* changes hard across that one pixel. Rendered, at
viewport height 900 with the default navigator width:

| | 960px (compact) | 961px (wide) |
|---|---|---|
| primary workspace | 960px | ~621px |
| conversation content lane | ~936px | ~517px |
| composer width | 960px | ~621px (left edge aligned with the timeline) |
| navigator | drawer (0 layout width) | persistent, `SIDEBAR_DEFAULT_WIDTH` 332px (user-resizable 280–440) |
| idle tool rail | none | bounded floating cluster + ~80px reserved right lane |
| document overflow | 0 | 0 |

One pixel of container growth brings the 332px navigator plus an ~80px launcher
lane into flow. Both sides are intentionally usable: 960 is a clean full-width
chat, 961 is a persistent-nav layout whose ~517px conversation lane is ~1.6×
`CHAT_FLOOR` (320px) — narrower than the 768px `--chat-measure` target until the
viewport reaches ~1270px, but not starved. The seam is *placed*, not eliminated:
moving it up from the pre-PR 820 line puts the step where the wide shell it
hands to actually holds a workspace, and lets every portrait tablet and
half-width window land on the clean drawer shell instead of a squeezed column.

### B. Idle right rail → floating cluster (`styles.css`, one container query)

1. `.app-shell { container: app-shell / inline-size; }` (it is already
   `position: relative`, so `.railbar` anchoring is unchanged).

2. `@container app-shell (min-width: 961px) and (max-width: 1400px)` — "wide
   shell, tablet-class width" (lower bound = `COMPACT_MAX_WIDTH + 1`, pinned by
   `styleArchitecture.test.ts` so the band can never overlap or gap the compact
   rules):
   - Collapse `.rail-icon-col.plugin-strip` from a full-height edge bar to a
     compact top-anchored floating cluster (glass, rounded). This is the spec's
     "subtle edge affordance / compact trigger" (§2).
   - The cluster is **height-bounded** (`max-height: calc(100% - 2*--space-3)`)
     and its strip **scrolls** (`overflow-y: auto`). Many packages + a short
     viewport (Stage Manager, browser chrome, soft keyboard) must not push tool
     icons off-screen (§2 "account for many tools / limited height").
   - Give the three chat surfaces (`.timeline`, `.composer-chat`, activity strip)
     a right inset that clears the cluster's lane, restated from the existing
     `max(--gutter, (100% - --chat-measure)/2)` centring formula + the cluster
     width. Content never renders under the affordance; no symmetric column is
     reserved.
   - Opening a tool → existing `dynamic` pane (slide-over, does not resize chat)
     → user pins → existing `pinned` split → expand → existing `fullscreen`.
   - `> 1400px` (real desktop) keeps the current permanent strip untouched (§16).
   - `≤ 960px` is the `compact` drawer/sheet shell — the band never applies there.

3. **Open/closed is `.railbar-open`, not `:has(.rail)`** (bug fixed on this
   branch — the first cut used `:not(:has(.rail))`). `ContextRail` keeps visited
   keep-alive surfaces (Files/Git/Terminal/Preview/Knowledge/…) **mounted** in
   the `kept` set after `rail` goes null — the `.rail` node stays in the DOM,
   merely `display:none`. So `:has(.rail)` reads "open" forever once any
   keep-alive tool has been opened, latching the shell into the desktop
   three-column layout for the rest of the session. `.railbar-open` is the class
   `ContextRail` already puts on `<aside>` from the real `rail`/`open` state
   (and the codebase already keys other rules off it: styles.css:4703, 5824).
   The `kept` computation is now `surfaces.keptSurfaces(...)`, a documented pure
   helper, so the "mounted ≠ open" boundary is testable.

## Done

- [x] Compact boundary 820 → 960 (`responsiveShell.ts` + CSS twins +
      `sidebarPresentation.ts`). Portrait iPad and half-width windows get the
      single-stage drawer shell; 1024 portrait and landscape iPad keep the
      persistent navigator.
- [x] `.app-shell` container + `@container app-shell (min-width: 961px) and
      (max-width: 1400px)` idle-rail cluster, scoped to
      `.railbar:not(.railbar-open)` / `.app-shell:not(:has(.railbar-open))`.
- [x] **Rail open/closed keys off `.railbar-open` (React `rail` state), not
      `:has(.rail)` (DOM presence)** — visited keep-alive surfaces stay mounted
      (`display:none`) after close; `surfaces.keptSurfaces(...)` is the pure
      helper for that "mounted ≠ open" set. Regressions: `keepAliveRailState.test.ts`
      (pure) **and** `responsiveShell.live.ts` "keepAlive surface stays
      mounted-but-hidden after close" (real DOM: hidden `.rail` retained,
      `.railbar-open` gone, idle cluster + reserved lane restored, hidden pane
      does not intercept pointer input).
- [x] Cluster height-bounded (`max-height: calc(100% - 2*--space-3)`) + scrolling
      strip for many-tools / short-viewport. Live regression at 1024×500 /
      1194×460: `overflow-y: auto`, `scrollHeight > clientHeight`, rail stays
      within `.app-shell`.
- [x] Pinned-split / dynamic-overlay / fullscreen unchanged in the band — the
      `:not(.railbar-open)` guard drops the reshape the moment a surface opens.
- [x] Chat surfaces get a right lane sized from the existing centring formula +
      the cluster width; text / code / tool output never render beneath it
      (`conversationClearsRail` asserted at every band width).
- [x] Band lower bound pinned to `COMPACT_MAX_WIDTH + 1` in
      `styleArchitecture.test.ts` — band and compact rules cannot overlap/gap.
- [x] `responsiveShell.test.ts` (literal + boundary matrix at 834 / 959 / 960 /
      961 / 1024 / 1080), `styleArchitecture.test.ts`, `keepAliveRailState.test.ts`,
      `sidebarPresentation.test.ts`, `sidebarNavigationGeometry.test.ts`,
      `mobileFoundation.test.ts`, `uiPrimitives.test.ts`, `sessionRowMenu.test.ts`
      updated for the 960 seam.
- [x] `responsiveShell.live.ts` extended with a tablet matrix (see below).
- [x] Full `apps/web/test/*.test.ts` + `npx tsc --noEmit -p apps/web` + `npm run
      build:web` green.

## Live tablet coverage (`responsiveShell.live.ts`)

Committed browser gate, run against the `a390FixtureSetup.mjs` fixture + a
headless Chromium. Four tablet tests added alongside the existing 390/1280
shell tests:

1. **Width matrix** `834 / 959 / 960 / 961 / 1024 / 1194 / 1366` — no document
   overflow; ≤960 has a drawer navigator with **0** layout width and a
   full-span workspace; >960 has a persistent navigator, a primary workspace
   ≥560px, an idle launcher bounded inside `.app-shell` (not full-height),
   conversation content clear of the launcher, timeline and composer left edges
   aligned. Records the before/after geometry table for the seam to
   `tablet_shell_geometry.json`.
2. **keepAlive real-DOM lifecycle** at 1180 — open a keep-alive surface →
   `.railbar-open` → close → the `.rail` node is retained `display:none`,
   `.railbar-open` gone, reserved lane restored, hidden pane does not intercept
   pointer at the conversation centre → reopen → switch → close.
3. **Coarse-pointer hit areas** at 1194×834 — every floating-launcher button
   and every pane header control (`Close panel` / pin / fullscreen) has a
   ≥44×44 *effective* hit area (visible glyph stays 24–32px; the `::after`
   `--hit-min` extension reaches the `--tap` floor). Touch-scrolls the bounded
   cluster.
4. **Short viewport** `1024×500` / `1194×460` — launcher stays inside the
   shell and viewport; `overflow-y: auto`; the fixture's tools overflow the
   bounded cluster so it scrolls rather than pushing icons off-screen.

## Known limitations / follow-ups (not this branch)

- **960 is a single boundary, not a per-component decision, and the 960 → 961
  step is real.** Rendered: 961px gives a ~621px primary workspace / ~517px
  conversation lane — usable, but below the `--chat-measure` target, and the
  conversation sits ~28px left of the workspace centre (the reserved launcher
  lane adds ~56px more right padding than left; timeline and composer stay
  mutually aligned). Making each region decide from its own inline size would
  let the navigator collapse or overlay near the seam and soften the step, but
  needs the navigator out of the `shellMode` React branch — deferred. If the
  961–~1080 band proves too tight in real use, give the persistent navigator a
  collapsed rail state below ~1100px rather than moving the constant again.
- **Second seam at 1400 → 1401.** Leaving the container-query band, the idle
  rail reverts from the floating cluster to the permanent full-height strip and
  the conversation's reserved right padding drops ~55px (content widens).
  Primary workspace width itself stays continuous across this seam. Milder than
  the 960 step and only affects the idle (no rail open) state.
- **Wide header tool rail** (`CapabilityNav`) still shows in the band and
  duplicates the floating cluster's launchers. Hide it in the band if it reads
  heavy after real use.
- **Navigator / header / composer chrome** on tablet: the spec's asks (§1 no
  persistent bulk actions, compact search; header not an icon graveyard;
  compact idle composer) are already met by existing `selectMode` /
  `searchOpen` / compact-composer code — verified, not re-touched.

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
- **No navigator rebuild.** `SIDEBAR_DEFAULT_WIDTH` (332px) is just above the
  spec's 280–310 target and the min (280) is inside it; the width is
  user-resizable 280–440. The selection / search chrome complaints (§1) are
  already addressed in
  `Sidebar.tsx` (`selectMode`, `searchOpen`). Portrait tablets now reach that
  navigator as the compact drawer, so it is a full-height single-stage surface,
  not a squeezed column.
- **No second state machine for the rail.** Open/closed stays the one `rail`
  value in the store, surfaced to CSS as `.railbar-open`. The container query
  reads that class; it does not mirror or re-derive it.
