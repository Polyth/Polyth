# Component migration matrix — Phase 1 UI Foundation

Companion to `phase-1-audit.md`. Phases: **1a** foundations (tokens + selector flattening),
**1b** primitives (build + core adoption), **1c** package adoption / CSS repatriation,
**2** deferred beyond Phase 1.

| Component/pattern | Current implementation | Target primitive | Phase |
| --- | --- | --- | --- |
| Design tokens | `apps/web/src/tokens.css` canonical set + ~180 live usages of deprecated aliases (`--radius-sm/md/lg/xl`, `--radius`, `--danger`, `--warning`, `--surface-raised`) across core and package CSS | Canonical tokens only; aliases rewritten then deleted; new icon-size, z-index, control-padding tokens | 1a |
| Hardcoded colors | 25 hex values in `apps/web/src/styles.css`; 9 in `packages/task-trackers/widgets/styles.css`, 4 in `packages/browser/widgets/styles.css`, 1 in `packages/files/widgets/styles.css` | Existing tokens (or new named tokens in `tokens.css`) | 1a |
| Duplicate core selectors | 177 class selectors defined 2+ times in `styles.css` (`.view-page` ×7, `.view-title` ×6, `.timeline` ×5, `.tool-card` ×4, `.strip-btn` ×4, …) layered by redesign waves | Single flattened definition per selector, preserving computed output | 1a |
| Text buttons | `.primary-btn`, `.small-btn`, `.danger-btn`, `.strip-btn` in core; restyled in `packages/git` (lines 491–492, 963), `packages/browser`, `packages/plugins`; one-offs `.workflow-button`, `.git-new-session-btn`, `.browser-type-button` (46 button-like classes total) | `Button` (variant: primary/quiet/danger; size: sm/md/lg from `--control-h*`) | 1b |
| Icon buttons | `.icon-btn`, `.copy-btn` (core); `.browser-icon-btn`, `.tt-icon-btn`, `.usage-icon-button`, `.usage-refresh-button`, `.mic-btn`, `.hunk-comment-btn` (packages) | `IconButton` with enforced `--tap` hit area on coarse pointers | 1b |
| Copy-to-clipboard | `apps/web/src/components/CopyButton.tsx` + `.copy-btn`, `.copy-wrap` restyled in `packages/git/widgets/styles.css` line 1011 | `CopyButton` re-based on `IconButton`; package restyles removed | 1b |
| Chips / tags / pills | `.model-chip` (core tail + `packages/models/widgets/styles.css`), `.file-tag` (core tail + `packages/files`), composer attachment pills (`AttachmentPills.tsx`), permission/session badges | `Chip` (selectable, removable variants) | 1b |
| Switch / toggle | `.switch`, `.switch.switch-sm` defined 3× in core; used in settings pages and package settings | `Switch` component + single CSS block | 1b |
| Modal dialogs | `components/a11y/Dialog.tsx` (canonical) used by `AlertDialog`, `WorktreeSessionDialog`, `ImportSessionsDialog`, `ProjectFolderDialog`, `ProjectAppearanceDialog`, `ComposerFocusDialog`, git/browser/workflow/ssh/goals widgets | Keep `Dialog`; add phone-mode degradation to `Sheet` | 1b |
| Hand-rolled dialogs | Own `role="dialog"`/`aria-modal` in `Sidebar.tsx`, `SettingsView.tsx`, `ContextRail.tsx`, `ProjectSetup.tsx`, `Composer.tsx`, `CommandPalette.tsx`, `PackageTourOverlay.tsx`, `packages/task-trackers/widgets/plugin.tsx` | Migrate to `Dialog` / `Sheet` | 1b–1c |
| Anchored popovers/menus | ~62 `position: absolute` menu surfaces in core CSS; behavior split across `usePopoverPlacement.ts` (vertical flip only) + `a11y/Menu.ts` (`useDismissibleMenu`) | `Popover` primitive: both-axis collision, `--keyboard-inset` aware, shared surface class, degrades to `Sheet` on phone | 1b |
| Context/selection menus | `SelectionMenu.tsx`, `CapabilityMenu.tsx`, `ComposerAddMenu.tsx`, `messagePinAction.tsx` menus | Re-based on `Popover` | 1c |
| Select / picker | `Picker.tsx` (desktop popover + mobile `Sheet`); residual native `<select>` in models/settings forms | `Picker` re-based on `Popover`/`Sheet`; desktop `autoFocus` gated on fine pointer; native selects replaced | 1b |
| Bottom sheet | `components/mobile/Sheet.tsx` (canonical, keyboard-inset aware, swipe dismiss) | Keep; becomes the phone-mode target for `Dialog`/`Popover`/`Picker` | 1b |
| Command palette | `CommandPalette.tsx` with own `role="dialog"` overlay + `.palette-list` (`max-height: 46vh`) | `Dialog`-based surface; height from `--visual-vh` | 1c |
| Empty states | `components/EmptyState.tsx` + `.empty-state` (core); parallel `.empty` blocks in git/usage/files/knowledge package CSS and duplicate core wave variants (~6 styles) | `EmptyState` component everywhere; one CSS block | 1c |
| Cards | `.tool-card` ×4 (core), `.git-stash-card`, `.plugin-card`, `.goal-card-*`, `.tt-*card*`, `.usage-*card*`, `.widget-layout-tile` | `Card` surface class (`--radius-card`, `--panel`/`--elevated`, `--shadow-sm`); package content composes it | 1c |
| View scaffolding | `.view-page` ×7, `.view-title` ×6, `.view-sub` ×5 across redesign waves in core | `ViewPage` scaffold (header/title/sub/actions/body) defined once | 1b (flatten in 1a) |
| Form rows / fields | `components/settings/parts.tsx` helpers; per-package forms in `packages/git/widgets/GitSettings.tsx`, models settings, `AgentProfileForm.tsx` | `Field`/`FormRow` promoted to core primitives | 1c |
| Settings navigation | `.settings-nav-item` ×4 in core; `SettingsView.tsx` + `settings/pages.tsx` | Single definition + `ViewPage` integration | 1a/1c |
| Spinners / skeletons | `.tt-button-spinner` (task-trackers), `.workflow-button-spinner`, `.workflow-skeleton-button` (workflow), assorted keyframes | `Spinner` + `Skeleton` core primitives with `prefers-reduced-motion` handling | 1c |
| Icons | `icons.tsx` base 15×15 components; per-context CSS overrides at 12/14/16/18px; `railIcons.ts` | `Icon` wrapper with `size` prop bound to new `--icon-sm/md/lg` tokens | 1b |
| Toasts / notifications | `NotificationCentre.tsx` + `notificationCentre.ts` (NTF-01 wave styles in core) | Keep component; adopt z-index tokens + `Button`/`IconButton` internals | 2 |
| Tool output cards | Timeline tool cards (`.tool-card`, `.tool-head`, `.tool-body` each ×3–4 in core) rendered by `Timeline.tsx`/`ExecutionRow.tsx` | Flatten selectors (1a); re-base chrome on `Card`; keep rendering logic untouched | 1a chrome only; internals 2 |
| Thinking blocks | Thinking rendering in timeline + `thinkingPrefs.ts` | No structural change; token-level polish only | 2 |
| Permissions UI | `packages/permissions/widgets/` (194-line CSS, 4 viewport MQs) + `QuestionCards.tsx` in core | Compose `Card`/`Button`; container queries replace viewport MQs | 1c |
| Composer | `Composer.tsx` + `components/input/AdaptiveTextInput.tsx`, `ComposerAddMenu`, `AssistStrip`, capability menus; own `role="dialog"` focus mode | Internals stay; menus re-based on `Popover`; focus dialog on `Dialog` | 1c |
| Model picker | `Picker.tsx` usage + `packages/models/widgets/` (`.model-chip` duplicated core/package, 9 viewport MQs) | `Picker` + `Chip`; de-duplicate CSS to package; container queries | 1c |
| Sidebar / session list | `Sidebar.tsx` (own dialog role for mobile drawer), `sidebar/SessionList.tsx` | Drawer via `Sheet`/`Dialog`; rows adopt `ListRow` pattern from flattened CSS | 1c |
| Mobile navigation | `mobile/MobileNavigationRail.tsx` (own `role="dialog"`), `WorkspaceBottomNav.tsx` | Keep structure; overlay semantics from `Dialog`/`Sheet`; hit-target pass | 1c |
| Hover-reveal actions | 39 `opacity: 0` hover-reveal patterns in core (timeline message actions, row actions, copy buttons) | Visible-on-coarse-pointer or overflow `Popover` menu | 1c |
| Package-owned CSS in core | ~1,800 lines at `styles.css` tail: browser (9007), files (9031), git (9205), models (9646), terminal (9815), usage (9818) blocks | Repatriated into owning package stylesheets, de-duplicated (order: models, files → browser, terminal → usage → git) | 1c |
| Viewport MQs in package CSS | ~80 `@media` rules across 17 package stylesheets (git 20, files 9, models 9, workflow 9, github 6, plugins 6, …) | Container queries (`@container`), matching existing usage (15 in core, 9 in usage, 6 in git) | 1c |
| Touch hit targets | Hardcoded heights 22–36px across core/package controls; 13 scattered 44px mobile overrides | Shared coarse-pointer hit-area rule from `--tap`; `IconButton`/`Button` enforce it | 1c |
| Reduced motion | 13 `prefers-reduced-motion` blocks in core; only 7 of 22 package sheets have any | All animation goes through `--motion-*` tokens + shared reduced-motion rules; Electron `reduceAnimations` mapped in | 1c/2 |
| Popover keyboard safety | `usePopoverPlacement.ts` ignores `--keyboard-inset`; `Picker` desktop path autofocuses search on touch devices | `Popover` consumes visual-viewport vars; autofocus gated on `(pointer: fine)` | 1b |
| Pinch-zoom lockout | `index.html` viewport meta `maximum-scale=1, user-scalable=no` | Re-evaluate with on-device Capacitor testing; not changed blind | 2 |
| Android back button | No Capacitor `backButton` handling; sheets/dialogs don't close on hardware back | Overlay stack listens for back events (Capacitor-only) | 2 |
| Terminal UI | `packages/terminal/widgets/` (xterm host, `--term-*` palette) | DO NOT TOUCH beyond token adoption | 2 |
| Markdown / chat internals | `apps/web/src/markdown/`, `.bubble-user-*`, syntax tokens, streaming rendering | DO NOT TOUCH in Phase 1 | 2 |
