# Phase 1 UI Foundation — architecture and design audit

Audit date: 2026-08-27. Scope: the entire Polyth web frontend — `apps/web` core shell and every
package widget stylesheet under `packages/*/widgets/`. All counts below were produced with
`rg`/`grep` against the working tree on `feat/ui-foundation-phase1-4868` and are exact unless
marked approximate.

---

## 1. Current architecture

Polyth's UI is a React 19 SPA (`apps/web`), bundled by esbuild with **no CSS tooling** — no
preprocessor, no CSS modules, no PostCSS. Styling is plain global CSS in two core files plus one
stylesheet per feature package:

- `apps/web/src/tokens.css` (166 lines) — the canonical token contract. A single `:root` block
  covering surfaces, lines, ink, accent/signals, spacing, control geometry, a scalable radius
  vocabulary, typography, visual-viewport/safe-area variables, focus/elevation/motion, chat/syntax
  roles, and the terminal palette. `theme.ts` overrides these values at runtime; the file holds the
  Ember Dark fallback.
- `apps/web/src/styles.css` (**10,808 lines**) — the core monolith. It contains resets, shell
  layout, every core component's styles, and — critically — the accumulated sediment of past
  redesign waves, each appended as a banner-commented block: `UX-A390 Ember command shelf`,
  `UX-COMPOSER-DISC`, `UX-TIMELINE-LAYOUT-01`, `widget-first workspace + customization`,
  `2026 workspace shell`, `personalized workspace redesign`, `NTF-01 notification centre`,
  `mobile UI polish`, `Mobile session mock overlay`, `strict critic remediation`,
  `P1 mobile quality pass`, `final critic collision closure`. Later blocks re-declare earlier
  selectors and win by cascade order, which is why the file contains **177 class selectors defined
  two or more times** (see §5).
- The tail of `styles.css` (lines ~9007–10808, ~1,800 lines) holds **"Package-owned" blocks** for
  browser, files, git, models, terminal, and usage — package widget CSS living inside the core
  stylesheet, in direct tension with the styles contract ("package widget CSS extends the token
  contract only with package-scoped additions").
- **22 package stylesheets** at `packages/<name>/widgets/styles.css`, totalling ~11,200 lines.
  Largest: usage (1,677), task-trackers (1,527), workflow (1,349), git (1,303), github (1,287).

### Behavioural seams (the good bones)

- `apps/web/src/mobileViewport.ts` — publishes `--visual-vh`, `--visual-bottom`,
  `--keyboard-inset`, `--visual-offset` on `documentElement` from the VisualViewport API, plus
  `data-keyboard` and `data-band` body attributes. This is the single source of truth for software
  keyboard geometry.
- `apps/web/src/responsiveShell.ts` — `useShellMode()` classifies the viewport into
  `wide | compact | phone` via `matchMedia`; the one sanctioned JS breakpoint seam.
- `apps/web/src/usePopoverPlacement.ts` — flips anchored menus up/down based on available space.
  It handles the vertical axis only; there is no horizontal collision handling and no awareness of
  `--keyboard-inset`.
- `apps/web/src/components/a11y/` — `Dialog.tsx` (focus trap, Escape, focus restore,
  `aria-modal`, scroll lock via `useModalScrollLock`/`useModalSurface`), `Menu.ts`
  (`useDismissibleMenu`: outside click, Escape, focus return, arrow-key nav), `live.tsx` (live
  regions), `roving.ts` (roving tabindex).
- `apps/web/src/components/mobile/` — `Sheet.tsx` (bottom sheet: swipe-to-dismiss, keyboard-inset
  aware, non-autofocused search), `MobileNavigationRail.tsx`, `SessionMenu.tsx`,
  `SessionContextBar.tsx`, `StarterPicker.tsx`, `HeroWidgets.tsx`, `sheetTrigger.ts`.
- `apps/web/src/components/Picker.tsx` — searchable listbox replacing native `<select>`; renders
  a desktop popover or swaps to `Sheet` on mobile (`mobileSheet` prop).
- `apps/web/src/slots.ts` + `components/slots/SlotHost.ts` — typed slot registry; packages
  contribute UI without touching `App.tsx`.
- `apps/web/src/desktopBridge.ts` — typed `window.polythDesktop` Electron API (window controls,
  settings incl. `reduceAnimations`/`lowResourceMode`, updates).
- `apps/web/src/index.html` viewport meta:
  `width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content`.

### How package UI reaches the page

Package widgets are React components loaded through `apps/web/src/packages/webHost.ts` and mounted
via slots. Their CSS is plain global CSS scoped (by convention only) under a package root class
such as `.git-page`, `.usage-panel`, `.tt-*`, `.workflow-*`. There is no build-time enforcement of
scoping; several packages restyle core classes (see §2 and §5).

---

## 2. Current primitives inventory

Duplicate counts are exact where a number is given, approximate where marked `~`.

| Existing pattern | Locations | Duplicate count | Replace with |
| --- | --- | --- | --- |
| Buttons (text) | `.primary-btn`, `.small-btn`, `.danger-btn`, `.strip-btn` in core `styles.css`; restyled in `packages/git` (`.git-page .small-btn`, `.git-page .primary-btn`, `.git-stash-card .small-btn`), `packages/browser` (`.browser-tool-btn.danger-btn`), `packages/plugins` (`.plugin-card-actions .danger-btn`); parallel one-offs `.workflow-button` (workflow), `.git-new-session-btn` (git), `.browser-type-button` (browser) | **46 distinct button-like class selectors** across core + packages; 8 packages restyle core button classes (dictation, git, browser, plugins, github, workflow, usage, goals); `.strip-btn` alone defined 4× in core | One core `Button` primitive with `variant` (primary/quiet/danger) + `size` (sm/md/lg) driven by `--control-h*` tokens |
| Icon buttons | `.icon-btn`, `.copy-btn` (core); `.browser-icon-btn`, `.tt-icon-btn`, `.usage-icon-button`, `.usage-refresh-button`, `.mic-btn`, `.hunk-comment-btn` (packages) | ≥6 independent icon-button implementations | Core `IconButton` (min `--tap` hit area on touch, visible focus ring) |
| Dialogs | `components/a11y/Dialog.tsx` (canonical, used by `AlertDialog.tsx`, `WorktreeSessionDialog.tsx`, `ImportSessionsDialog.tsx`, `ProjectFolderDialog.tsx`, `ProjectAppearanceDialog.tsx`, `ComposerFocusDialog.tsx`, git/browser/workflow/ssh/goals package widgets); hand-rolled `role="dialog"`/`aria-modal` in `Sidebar.tsx`, `SettingsView.tsx`, `ContextRail.tsx`, `Composer.tsx`, `CommandPalette.tsx`, `PackageTourOverlay.tsx`, `packages/task-trackers/widgets/plugin.tsx` | 8 hand-rolled dialog surfaces outside the primitive | Adopt `a11y/Dialog` (or `mobile/Sheet` on phone) everywhere |
| Popovers / anchored menus | `usePopoverPlacement.ts` + `useDismissibleMenu` used by `Picker.tsx`, `CapabilityMenu.tsx`, `ComposerAddMenu.tsx`, `SelectionMenu.tsx`, etc.; plus ~62 `position: absolute` popover/menu-like blocks in core CSS, each with bespoke geometry | ~62 absolute-positioned menu surfaces, no shared surface class | One `Popover` primitive: anchored, collision-aware both axes, keyboard-inset aware, shared `.popover-surface` CSS |
| Bottom sheets | `components/mobile/Sheet.tsx` (canonical) | 1 implementation, good — but adoption is partial (several mobile overlays still use ad-hoc fixed panels) | Keep `Sheet`; route all phone-mode overlays through it |
| Select / pickers | `Picker.tsx` (canonical searchable listbox); some package widgets still use native `<select>` (`packages/models`, settings pages) | ~2 residual native-select clusters | `Picker` everywhere; native `<select>` only inside `Picker` fallback if ever needed |
| Empty states | `components/EmptyState.tsx` + `.empty-state` (core); parallel `.empty` blocks in package CSS (git, usage, files, knowledge) and duplicate `.empty-state` variants in core waves | ~6 competing empty-state styles | `EmptyState` component + single `.empty-state` block |
| Cards | `.tool-card` (defined 4× in core), `.git-stash-card`, `.plugin-card`, `.goal-card-*`, `.tt-*card*`, `.usage-*card*`, `.widget-layout-tile` | `.tool-card` ×4 in core alone; ≥6 package card families | Core `Card` surface class (`--radius-card`, `--panel`/`--elevated`, `--shadow-sm`) with package content inside |
| Chips / tags | `.model-chip` (defined in both core tail and `packages/models/widgets/styles.css`), `.file-tag` (core tail + `packages/files`), `.chip`-like pills across composer, sessions, permissions | `.model-chip` and `.file-tag` each defined in 2 places; ~8 pill variants | Core `Chip` primitive (selectable / removable variants) |
| Switches / toggles | `.switch`, `.switch.switch-sm` (defined 3× in core) | 3 definitions of the same switch | Single `.switch` block; component wrapper for label + description |
| View scaffolding | `.view-page` (×7), `.view-title` (×6), `.view-sub` (×5) — redefined by successive redesign waves in core | 18 total redefinitions of 3 selectors | One `ViewPage` scaffold (header, subtitle, actions, body) defined once |
| Timeline / chat | `.timeline` (defined 5× in core), tool output cards, thinking blocks, `.bubble-user-*` | 5 definitions of `.timeline` | Consolidate into one timeline section; keep message internals (see DO NOT TOUCH) |
| Settings rows | `.settings-nav-item` (×4), `components/settings/parts.tsx` row/field helpers, plus per-package settings forms (`GitSettings.tsx`, models settings) | 4 definitions of settings nav; ≥3 form-row patterns | `Field`/`FormRow` primitives from `settings/parts.tsx` promoted to core |
| Loading states | `.tt-button-spinner`, `.workflow-button-spinner`, `.workflow-skeleton-button`, assorted `@keyframes` per package | ≥3 spinner implementations | Core `Spinner` + `Skeleton` primitives |
| Source/remote controls | `.source-remote-actions` (×6), `.source-branch` (×5) in core | 11 redefinitions of 2 selectors | Single definition after wave-flattening |
| Widget canvas / layout editor | `.widget-canvas` (×4), `.widget-layout-*` (×3 each), `.widget-settings-*` (×3–4) in core | ~20 redefinitions across the widget-workspace waves | Flatten to one block per selector during cleanup |
| Icons | `icons.tsx` (base 15×15 SVG components) + `railIcons.ts`; core CSS overrides svg width/height at 12/14/16/18px in many spots | dozens of per-context size overrides (approximate) | Icon component with a `size` prop bound to a 3-step token scale |

---

## 3. Token audit

### What is good (keep as-is)

- **Single `:root` contract** in `tokens.css` with runtime theme override via `theme.ts` — clean,
  and packages genuinely inherit it.
- **Visual-viewport variables** (`--visual-vh`, `--visual-bottom`, `--keyboard-inset`,
  `--visual-offset`) plus `--safe-top/right/bottom/left` — a mobile keyboard contract most apps
  lack. 58 `env(safe-area-*)`/safe-token references across the stylesheets show real adoption.
- **Scalable radius vocabulary** (`--radius-control/card/surface/sheet` × `--corner-radius-scale`)
  is the right model.
- **Control geometry tokens** exist: `--tap: 44px`, `--control-h-sm/-h/-h-lg` (32/40/48px).
- **Motion tokens** (`--motion-fast/normal/surface`, `--motion-ease`) and elevation
  (`--shadow-sm/md/lg`, `--scrim`, `--inset-hi`).
- Typography clamps (`--font-title/heading/label/meta`) and `--font-input: 16px` (prevents iOS
  focus zoom).
- Terminal palette (`--term-*`) is properly isolated and theme-driven.

### What to add in Phase 1

- **Icon size scale**: `--icon-sm: 14px; --icon-md: 16px; --icon-lg: 18px` (or similar) — today
  `icons.tsx` hardcodes 15×15 and CSS overrides it ad hoc at 12/14/16/18px.
- **Control padding tokens** (`--control-pad-x`, `--control-pad-x-sm`) so the 46 button variants
  can converge without per-class pixel values.
- **Z-index scale** (`--z-popover`, `--z-sheet`, `--z-dialog`, `--z-toast`) — layering is currently
  hardcoded per overlay and has already needed a "final critic collision closure" wave.
- **Popover surface tokens** (`--popover-bg`, `--popover-shadow` aliases) so all ~62 menu surfaces
  share one look.
- **Density/hit-area guidance**: a `--tap-min` applied via a shared
  `:where(button, [role="button"])` touch rule instead of per-component 44px overrides (13
  scattered `height: 44px` declarations exist today).

### Deprecated (must stop growing)

Declared deprecated in `tokens.css` and `docs/dev/styles.md`, yet still heavily used:

| Alias | Live usages (core + packages) |
| --- | --- |
| `--radius-lg` | 61 |
| `--radius-sm` | 55 |
| `--radius` | 30 |
| `--radius-md` | 26 |
| `--radius-xl` | 4 |
| `--danger` | 4 |
| `--surface-raised` | 1 |
| `--warning` | 1 |

≈180 deprecated-alias usages total. Phase 1 should mechanically rewrite these to the canonical
radius/signal tokens, then delete the aliases from `tokens.css`.

### Duplicated / bypassed

- **25 hardcoded hex colors** remain in core `styles.css`; packages: task-trackers 9, browser 4,
  files 1. All should map to existing tokens or be added as named tokens.
- **Hardcoded control heights** in core despite `--control-h*` existing: `30px` ×8, `36px` ×6,
  `32px` ×5, `34px` ×4, `25px` ×4, `28px` ×3, `22px` ×3, `18px` ×3.
- `.model-chip` and `.file-tag` styles exist in both the core "Package-owned" tail and the
  respective package stylesheets — one of them silently loses.

---

## 4. Mobile problems

### Critical

1. **Viewport media queries inside package widget CSS.** 17 of 22 package stylesheets contain
   `@media (width/height …)` rules — git 20, files 9, models 9, workflow 9, github 6, plugins 6,
   terminal 5, dictation 5, goals 4, permissions 4, browser 3, usage 2, secure-safe 2, and one each
   in task-trackers/ssh/fusion/multirun (~80 total). `docs/dev/styles.md` reserves viewport queries
   for shell-level behaviour; embedded panels must use container queries. Consequence: a git panel
   docked in a narrow desktop pane renders desktop-density UI, and the same panel full-screen on a
   tablet can get phone styling.
2. **Sub-44px hit targets are the norm.** Control heights of 22–36px are hardcoded across core and
   package CSS (see §3). The `--tap: 44px` token and a `touch-action: manipulation` rule exist, but
   only 13 scattered `height: 44px` mobile overrides bump specific controls. Icon buttons in
   git file rows, timeline hover actions, and chip remove buttons are well under 44px on touch.
3. **Desktop popovers under the software keyboard.** `usePopoverPlacement.ts` only flips up/down
   using `window.innerHeight`; it never consults `--keyboard-inset`/`visualViewport`. On tablets
   (which get the desktop `wide` shell with a touch keyboard), `Picker.tsx`'s desktop path
   `autoFocus`es its search input — summoning the keyboard over the freshly opened popover. The
   mobile `Sheet` path avoids this correctly, but the wide/compact + touch combination does not.

### Major

4. **Hover-only affordances.** Core CSS has 151 `:hover` rules and **39 `opacity: 0` →
   reveal-on-hover patterns** (timeline message actions, copy buttons, row action clusters). On
   touch these controls are invisible and unreachable until a stray tap happens to reveal them.
5. **Pinch zoom disabled.** `index.html` sets `maximum-scale=1, user-scalable=no`. This is a WCAG
   1.4.4 failure and is only partially ignored by iOS Safari; in a Capacitor WKWebView it will be
   enforced.
6. **Reduced-motion coverage is partial.** Core has 13 `prefers-reduced-motion` blocks, but only 7
   of 22 package stylesheets have any — 15 packages animate unconditionally (workflow spinners,
   task-tracker transitions, github list animations).

### Minor

7. Legacy `100vh` in 2 core spots (`.app` has the correct `100dvh` second declaration; the
   lock-screen `min-height: 100vh` at line ~1810 does not).
8. Ad-hoc `max-height: 46vh` / `60vh` panel maxima (`.palette-list`, context menus) instead of
   `--visual-vh`-derived values; these overflow when the keyboard is up.
9. `workflow` and `ssh` package CSS correctly consume `--visual-vh`/`--keyboard-inset` — good —
   but they hardcode offsets like `calc(100dvh - 108px)` (workflow line 75) that will drift when
   shell chrome changes.

---

## 5. Desktop inconsistencies

### Critical

1. **177 class selectors defined 2+ times in core `styles.css`.** Worst offenders: `.view-page` ×7,
   `.view-title` ×6, `.source-remote-actions` ×6, `.view-sub` ×5, `.timeline` ×5,
   `.source-branch` ×5, `.widget-settings-steps` ×4, `.widget-canvas` ×4, `.tool-card` ×4,
   `.strip-btn` ×4, `.settings-nav-item` ×4, `.folder-row-enter` ×4. Every redesign wave appended
   overrides instead of editing, so the rendered UI is defined by cascade order across a 10.8k-line
   file. Any reordering or extraction silently changes the product.
2. **~1,800 lines of package CSS living in core.** The "Package-owned browser/files/git/models/
   terminal/usage web styles" blocks at the tail of `styles.css` duplicate and conflict with the
   same packages' own `widgets/styles.css` files (e.g. `.model-chip`, `.file-tag`,
   `.preview-stage` defined in both). This breaks the ownership contract in `AGENTS.md` and makes
   package CSS changes unpredictable.

### Major

3. **46 button-like class selectors** with drifting geometry: heights 22–48px, mixed radius
   aliases, mixed padding. Eight packages restyle core button classes inside their scope
   (`.git-page .small-btn`, `.git-page .primary-btn` at `packages/git/widgets/styles.css` lines
   491–492, etc.), so "the same button" renders differently per panel.
4. **Radius drift**: ~176 usages of deprecated radius aliases (§3) mixed with canonical
   `--radius-control/card/surface` and raw pixel radii, producing at least three visible corner
   styles on one screen.
5. **Icon size drift**: base 15×15 from `icons.tsx` overridden per context to 12/14/16/18px with
   no scale.
6. **Eight hand-rolled dialog surfaces** bypass `a11y/Dialog` (`Sidebar.tsx`, `SettingsView.tsx`,
   `ContextRail.tsx`, `Composer.tsx`, `CommandPalette.tsx`,
   `PackageTourOverlay.tsx`, task-trackers plugin) — each re-implements focus/Escape/scroll-lock
   with different completeness.

### Minor

7. 25 hardcoded hex values in core CSS bypass theming (theme.ts overrides tokens, not these).
8. `.switch.switch-sm` triple definition; `.step-dots`/`.step-dot` triple definition.
9. Focus-visible treatment varies: some controls use `--focus-ring`, others rely on
   `--accent-line` box-shadows, a few have `outline: none` with no replacement.

---

## 6. Cross-platform risks

### Electron

- `desktopBridge.ts` is a clean typed seam (`window.polythDesktop`), incl. `controlsPosition`
  (left/right window controls) — the shell already accounts for platform chrome. Low risk.
- **Risk:** the desktop `reduceAnimations` / `lowResourceMode` settings are separate from the CSS
  `prefers-reduced-motion` media query; unless the Electron shell maps the setting onto the OS
  preference, package CSS animations (15 packages without reduced-motion blocks) ignore it.
- **Risk:** ~62 absolute-positioned popovers assume `window.innerHeight` is the app height — true
  in Electron, so no regression, but any Phase 1 popover primitive must keep this path fast.

### Capacitor (general)

- `interactive-widget=resizes-content` in the viewport meta is **Chromium-only**; iOS WKWebView
  ignores it. The app correctly does not depend on it exclusively — `mobileViewport.ts` computes
  `--keyboard-inset` from the VisualViewport API — but **anything `position: fixed` to the bottom
  that does not consume `--visual-bottom`/`--keyboard-inset` will hide under or float above the
  keyboard**. There are 27 `position: fixed` uses in core plus one each in git, files, terminal
  package CSS to audit against this contract.
- `user-scalable=no` **is enforced** in WKWebView (unlike Safari) — combined with sub-44px targets
  this is the single biggest Capacitor usability risk.
- Hand-rolled dialogs that scroll-lock via `overflow: hidden` on body can still rubber-band in
  WKWebView; `useModalScrollLock` should remain the only mechanism.

### iOS specifics

- `--font-input: 16px` prevents focus zoom — good; verify every input actually uses it (the
  `AlertDialog` prompt input and package form fields need checking).
- Safe areas: `viewport-fit=cover` + 58 `env(safe-area-*)` usages — good coverage; the
  `data-band` short-viewport handling in `mobileViewport.ts` handles landscape phones.
- `-webkit-tap-highlight-color` is set globally (line 40 of `styles.css`) — good.
- **Risk:** swipe-to-dismiss in `Sheet.tsx` and the edge-swipe gestures in `mobileGestures.ts`
  can collide with iOS system back-swipe inside a WKWebView; needs on-device verification.

### Android specifics

- Keyboard detection thresholds (`KEYBOARD_MIN_INSET`, `SHORT_VISUAL_BAND` in
  `mobileViewport.ts`) are heuristic; split-screen and floating-keyboard modes on Android can
  misclassify and leave `data-keyboard` stale.
- **No hardware back-button handling** exists (nothing listens for Capacitor's `backButton`);
  open sheets/dialogs would background the app instead of closing.
- `overscroll-behavior: none` on the shell prevents pull-to-refresh — intended, but package panels
  that scroll internally must keep `overscroll-behavior: contain` (present in core, absent in most
  package CSS).

---

## 7. Proposed component architecture

Phase 1 promotes the proven seams to a small, explicit core primitive set. Everything lives in
`apps/web/src/components/` (or `components/primitives/`), styled by one block each in core CSS,
consumed by packages as components — never by copying CSS.

**Tier 0 — foundations (no components):**
tokens cleanup (delete deprecated aliases after rewrite), z-index scale, icon size scale, control
padding tokens, shared touch hit-area rule.

**Tier 1 — interactive primitives:**
- `Button` — variants `primary | quiet | danger`, sizes from `--control-h*`; replaces
  `.primary-btn`/`.small-btn`/`.danger-btn`/`.strip-btn` and all package button one-offs.
- `IconButton` — enforced `--tap` hit area on coarse pointers; replaces the ≥6 package icon-button
  classes.
- `Chip` — selectable/removable; replaces `.model-chip`, `.file-tag`, pill variants.
- `Switch` — single definition wrapping the existing `.switch` markup.

**Tier 2 — overlay primitives (build on existing a11y/mobile code):**
- `Popover` — merges `usePopoverPlacement` + `useDismissibleMenu` + a shared surface class; adds
  horizontal collision handling and `--keyboard-inset` awareness; used by every anchored menu.
- `Dialog` — existing `a11y/Dialog.tsx`, adopted by the 8 hand-rolled dialog surfaces.
- `Sheet` — existing `mobile/Sheet.tsx`; the `Popover`/`Dialog` primitives auto-degrade to `Sheet`
  in phone shell mode (the pattern `Picker.tsx` already proves).
- `Picker` — existing; re-based on `Popover`/`Sheet`; desktop `autoFocus` gated on fine pointer.

**Tier 3 — layout/content primitives:**
- `Card`, `ViewPage` (header/title/sub/actions/body scaffold), `Field`/`FormRow` (promoted from
  `components/settings/parts.tsx`), `EmptyState` (existing), `Spinner`/`Skeleton`, `Icon` (wraps
  `icons.tsx` with a `size` prop).

Package widgets keep their domain content but compose these primitives; package CSS shrinks to
layout + domain visuals, loses all viewport media queries (container queries instead), and the
"Package-owned" blocks migrate out of core `styles.css` into the owning package (or the shared
primitive), one package at a time.

---

## 8. Migration order

Ordered by dependency; each step is safe to ship independently.

1. **Token cleanup** — rewrite ~180 deprecated alias usages to canonical tokens; add icon/z-index/
   control-padding tokens; map the 25 core + 14 package hex colors to tokens. No visual change
   intended. (Everything below depends on the final token set.)
2. **Flatten duplicate selectors in core `styles.css`** — collapse the 177 multiply-defined
   selectors to single definitions preserving the current computed result (cascade-order
   archaeology; do `view-page`/`view-title`/`timeline`/`tool-card` families first). This must
   precede any extraction, otherwise moved rules change winners.
3. **`Button` / `IconButton` / `Chip` / `Switch`** — pure additions, then mechanical adoption in
   core components; packages adopt per-package later.
4. **`Popover`** — depends on step 3 for its trigger styles; unifies the ~62 absolute-positioned
   menus; adds keyboard-inset handling that fixes Mobile problem #3.
5. **`Dialog`/`Sheet` adoption** — migrate the 8 hand-rolled dialogs; wire phone-mode degradation.
   Depends on `Popover` only for shared scrim/z-index tokens.
6. **`ViewPage` / `Card` / `Field` scaffolds** — depends on step 2 (flattened selectors) so the
   scaffold owns the single definition.
7. **Package CSS repatriation** — move the ~1,800-line "Package-owned" tail blocks out of core
   into their packages, de-duplicating against the package's own stylesheet; order: models, files
   (small) → browser, terminal → usage → git (largest, 20 viewport MQs).
8. **Container-query conversion** — replace the ~80 viewport media queries in package CSS with
   container queries (container contexts already exist: 15 `@container` uses in core, 9 in usage,
   6 in git prove the pattern). Depends on step 7 so each package is edited once.
9. **Touch/hit-target pass** — apply the shared hit-area rule, convert the 39 hover-only reveals
   to visible-on-touch (or overflow-menu) patterns. Depends on `IconButton` and `Popover`.

---

## 9. Explicit DO NOT TOUCH (Phase 1)

- **The event-log pipeline** — anything under `packages/session`, `packages/contracts`
  (`SessionEvent`, `MODEL_VISIBLE_TYPES`), `deriveMessages`, `reduce.ts`. UI redesign must not
  alter what gets appended or when.
- **`packages/backend-opencode`** — the only OpenCode integration; irrelevant to UI and grep-gated.
- **`packages/server/src/http.ts`** — never receives styling or feature routes (AGENTS.md rule).
- **`App.tsx` structure and the slot registry contract** (`slots.ts`, `SlotHost.ts`,
  `UI_SLOTS` in contracts) — primitives are new modules; slot API stays frozen.
- **`mobileViewport.ts` publishing contract** — `--visual-vh`/`--visual-bottom`/
  `--keyboard-inset`/`--visual-offset`, `data-keyboard`, `data-band` names are load-bearing across
  core and package CSS (workflow, ssh consume them). Extend consumers, never rename.
- **`responsiveShell.ts` breakpoint seam** — wide/compact/phone semantics stay; do not add new JS
  breakpoints.
- **`theme.ts` runtime override mechanism and the terminal palette** (`--term-*`) — xterm theming
  depends on exact names.
- **Chat message internals** — markdown renderer (`markdown/`), syntax tokens, `.bubble-user-*`,
  streaming/thinking rendering logic. Visual polish only via tokens; no structural changes while
  the timeline selector flattening (step 2) is in flight.
- **The viewport meta line's `viewport-fit=cover` and `interactive-widget=resizes-content`** —
  keep; only the `user-scalable=no` question is in scope, and only with on-device retesting.
- **Deprecated token aliases** — do not delete until step 1's rewrite lands and is verified;
  package CSS still resolves through them.
- **`docs/parity/polyth-parity.yaml`** — parity rows are not UI-redesign deliverables; never mark
  rows done from this workstream.
