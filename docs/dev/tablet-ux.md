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
| §5 remember layout per context | `polyth.workspacePane.v2.<projectId>` (widths, heights, pinned-open set), `polyth.railPrefs`, `widgets/workspaceMode.ts` (`polyth.workspaceMode.v1.<projectId>`). |
| §6 portrait / narrow: nav off-canvas drawer + tools off-canvas | `shellMode === "compact"` (≤820px): `.sidebar.open` drawer + `.sidebar-backdrop`; contextual panels → `.panel-sheet`; workspace panes → full-screen layer. `Sidebar.tsx` / `ContextRail.tsx` already branch on this. |
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

### A. Compact-shell boundary 820 → 900 (`responsiveShell.ts`)

`COMPACT_MAX_WIDTH` is now `900`. The persistent navigator only earns its place
when a usable primary workspace still survives beside it. Below 900 the existing
`compact` shell owns the layout: navigator as a drawer, panels as sheets, panes
full-screen — the spec's single-stage portrait composition, already built, now
reached at the widths that need it.

- Every portrait iPad (768 / 810 / 820 / 834) → drawer navigator, single stage.
- Every landscape iPad (1080 / 1180 / 1194 / 1366) → persistent navigator.
- Half-snapped desktop windows below 900 → drawer navigator.
- The CSS twins (`(max-width: 820px)` → `900`, `(min-width: 821px)` → `901`,
  the one `(max-width: 1100px) and (min-width: 821px)` header rule → `901`) and
  `sidebarPresentation.ts` `SIDEBAR_NARROW_QUERY` move with the constant.
- `responsiveShell.test.ts` pins the literal and the boundary matrix — updated
  to 900, with `834` and `1080` as named portrait/landscape anchors.

**The 900 → 901 seam is a real geometric step, not a smooth ramp.** Shell-mode
classification is monotonic (`compact` → `wide`, one rank change, no
regression), but the *layout* changes hard across that one pixel. Measured, at
viewport height 900 with the default navigator width:

| | 900px (compact) | 901px (wide) |
|---|---|---|
| primary workspace | 900px | ~561px |
| conversation content lane | ~876px | ~457px |
| navigator | drawer (0 layout width) | persistent, `SIDEBAR_DEFAULT_WIDTH` 332px (user-resizable 280–440) |
| idle tool rail | none | floating cluster + ~80px reserved right lane |

So one pixel of container growth brings ~332px of navigator chrome plus an
~80px launcher lane into flow and roughly halves the conversation lane. The
seam sits at 900 anyway because the alternative — keeping the pre-PR 820 line —
put that same step at a width where *less* workspace survived it, and because
every portrait tablet now lands cleanly on the drawer shell instead of a
squeezed persistent-nav column. It is a relocated seam, placed where the wide
shell it hands to is at least usable (see "Known limitations"), not an
eliminated one. `CHAT_FLOOR` is 320px; the ~457px conversation lane at 901 is
~1.4× that — usable, narrower than the 768px `--chat-measure` target until the
viewport reaches ~1270px.

### B. Idle right rail → floating cluster (`styles.css`, one container query)

1. `.app-shell { container: app-shell / inline-size; }` (it is already
   `position: relative`, so `.railbar` anchoring is unchanged).

2. `@container app-shell (min-width: 901px) and (max-width: 1400px)` — "wide
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
   - `≤ 900px` is the `compact` drawer/sheet shell — the band never applies there.

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

- [x] Compact boundary 820 → 900 (`responsiveShell.ts` + CSS twins +
      `sidebarPresentation.ts`). Portrait iPad and small windows now get the
      single-stage drawer shell; landscape iPad keeps the persistent navigator.
- [x] `.app-shell` container + `@container app-shell (min-width: 901px) and
      (max-width: 1400px)` idle-rail cluster, scoped to
      `.railbar:not(.railbar-open)` / `.app-shell:not(:has(.railbar-open))`.
- [x] **Rail open/closed keys off `.railbar-open` (React `rail` state), not
      `:has(.rail)` (DOM presence)** — visited keep-alive surfaces stay mounted
      (`display:none`) after close; `surfaces.keptSurfaces(...)` is the pure
      helper for that "mounted ≠ open" set. Regression:
      `keepAliveRailState.test.ts` (open → close → reopen → switch → close).
- [x] Cluster height-bounded (`max-height: calc(100% - 2*--space-3)`) + scrolling
      strip for many-tools / short-viewport.
- [x] Pinned-split / dynamic-overlay / fullscreen unchanged in the band — the
      `:not(.railbar-open)` guard drops the reshape the moment a surface opens.
- [x] Chat surfaces get a right lane sized from the existing centring formula +
      the cluster width; text / code / tool output never render beneath it.
- [x] Band lower bound pinned to `COMPACT_MAX_WIDTH + 1` in
      `styleArchitecture.test.ts` — band and compact rules cannot overlap/gap.
- [x] `responsiveShell.test.ts` (literal + boundary matrix at 834 / 900 / 901 /
      1080), `styleArchitecture.test.ts`, `keepAliveRailState.test.ts` (new),
      `sidebarPresentation.test.ts`, `sidebarNavigationGeometry.test.ts`,
      `mobileFoundation.test.ts`, `uiPrimitives.test.ts`, `sessionRowMenu.test.ts`
      updated for the moved seam. Full `apps/web/test/*.test.ts` + `npm run
      build:web` green (see PR body for counts).
- [ ] Open PR to `master` (this is PR #141).

## Known limitations / follow-ups (not this branch)

- **Live Chromium pass not run here.** `responsiveShell.live.ts` needs a running
  server + seeded fixture + playwright-core/chromium (none of which the review
  sandbox has). Widths to confirm in real pixels: 1366×1024, 1194×834,
  1024×1366, 744, 600, plus a continuous resize across 900↔901 and 1400↔1401,
  and a keep-alive open→close→reopen at ~1180. The pure classifier, the
  container-query bound, and the keep-alive lifecycle are covered by the
  node-test suite above; the live gate confirms pixel geometry only.
- **900 is still a single boundary, not a per-component decision, and the
  900 → 901 layout step is real.** The seam is placed at a width where the wide
  shell it hands to is at least usable — but at 901 the primary workspace is
  ~561px and the conversation lane ~457px (see the table in "The two gaps"),
  and the 901–~1000px band is the weakest wide layout: usable, no overflow,
  timeline and composer stay mutually aligned, but the conversation sits ~28px
  left of the workspace centre (the reserved launcher lane adds ~56px more
  right padding than left) and is well below its `--chat-measure` target.
  Making each region (navigator, tool pane) decide from its own inline size
  would let the navigator collapse or overlay near the seam and soften the
  step, but needs the navigator out of the `shellMode` React branch — a larger
  change deferred to a follow-up. Options if the 901–1000 band proves too tight
  in real use: nudge `COMPACT_MAX_WIDTH` up toward ~960 (332 nav + ~2×
  `CHAT_FLOOR`) so half-snapped windows get the drawer shell, or give the
  persistent navigator a collapsed rail state below ~1100px.
- **Second seam at 1400 → 1401.** Leaving the container-query band, the idle
  rail reverts from the floating cluster to the permanent full-height strip and
  the conversation's reserved right padding drops ~55px (content widens).
  Primary workspace width itself stays continuous across this seam. Milder than
  the 900 step and only affects the idle (no rail open) state.
- **Wide header tool rail** (`CapabilityNav`) still shows in the band and
  duplicates the floating cluster's launchers. Hide it in the band if it reads
  heavy after real use.
- **Live tablet gate.** `responsiveShell.live.ts` covers 390/1280 only. When a
  live harness is available, extend it with tablet widths (834/900/901/1024/
  1194/1366): assert no document overflow, `.railbar` bounded within
  `.app-shell`, `.railbar` scrollHeight > clientHeight with many tools at a
  short viewport, conversation region not intersecting the cluster, and the
  keep-alive open→close→reopen `.railbar-open` lifecycle in the real DOM.
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
