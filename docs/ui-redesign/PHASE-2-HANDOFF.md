## Completed surfaces

- Project/session navigation, state presentation, row actions, scaling to 100 sessions, project picking, and worktree-session entry.
- Conversation messages, thinking disclosure, tool/MCP rows, large-output viewers, tasks, permissions, and agent questions.
- Composer, attachments, streaming controls, model/agent/effort pickers, focus editor, and Add-menu dialogs.
- Settings shell and common pages, including phone navigation/detail flow and destructive confirmations.
- Shared-control presentation for Files, Goals, Usage, Knowledge, GitHub, Walkthrough, Multirun, Fusion, Commands, Schedule, Plugins, Hotkeys, and Dictation.
- Source-control, Terminal, and Browser chrome; their specialized diff/graph, terminal-emulator, and browser-frame engines remain domain-owned.

## Main UX changes

- Navigation now uses one contextual session-action entry point per input mode, clear project/worktree/session hierarchy, visible attention states, and bounded incremental session loading.
- Thinking shows a concise timed summary and readable capped reasoning; tools use verb-first stateful rows; tasks summarize progress and failure; permissions and questions keep decisions visible and reachable.
- The composer prioritizes typing and Send/Stop, keeps configuration in one quiet rail, bounds attachment/editor growth, and uses phone sheets for model and agent selection.
- Settings uses a focused desktop two-pane surface and an explicit phone navigation-to-detail flow.
- Phone, tablet, and desktop overlays share deterministic Escape, focus restoration, keyboard-inset, and safe-area behavior.

## Main implementation changes

- Core and package surfaces were migrated from bespoke button/input/dialog chrome to the shared `ui/` contracts without changing backend, event-log, OpenCode, or plugin architecture.
- `QuestionCards` now uses native grouped inputs, roving tabs, labelled panels, shared actions, and a bounded internal phone scroll region.
- App-owned secondary dialogs now use common Dialog headers, body overflow, footers, fields, selects, checkboxes, switches, and icon actions.
- Responsive shell focus handoff now targets current controls and retries after the compact drawer removes `inert`.
- `wave5ProductQa.mjs` exercises the built product across the required viewport matrix, navigation scale, representative feature surfaces, settings, pickers, questions, dialogs, keyboard simulation, and diagnostics.

## Core primitives added/changed

- `Menu` gained controlled state, radio/checkbox semantics, headings, swatches, a footer slot, and dynamic focus return.
- `ResponsiveOverlay`, Sheet, and the global Escape stack provide one desktop-popover/phone-sheet path with LIFO dismissal and trigger focus restoration.
- Dialog, Button, IconButton, TextInput, Textarea, Select, Checkbox, Switch, EmptyState, Tabs, and shared icon usage were adopted across the prioritized surfaces.
- `buttonClassName.ts` exposes the Button CSS contract to createElement-only `.ts` boundaries without introducing a non-erasable `.tsx` dependency.

## Removed legacy UI

- Removed the hand-rolled session menu, duplicate session-row action layers, obsolete composer power row, thinking slider, context-window picker, and their active selectors.
- Removed touched bespoke question, project-picker, alert, profile, import, appearance, worktree, gallery, Mermaid, GitHub-link, notification, copy, and empty-state controls.
- Removed touched dead control CSS and package-specific restyles after migration.
- Core fallback actions no longer instantiate `.primary-btn`; deferred optional package workbenches remain explicitly recorded in the migration matrix.

## Responsive validation

- Passed browser interaction and overflow checks at 320×568, 360×800, 375×812, 390×844, 430×932, 568×320, 844×390, 768×1024, 1024×768, 1280×800, 1440×900, and 1920×1080.
- Passed phone portrait/landscape and tablet portrait/landscape presentation, including tablet focus handoff across responsive modes.
- Passed empty, multiline, attachment-heavy, streaming, permission-plus-composer, model-sheet, and simulated software-keyboard states.
- No tested state produced document-level horizontal overflow or duplicate DOM ids.

## Accessibility validation

- Verified keyboard traversal, menu/tab/listbox arrow behavior, Space/Enter activation, top-layer Escape, dialog focus traps, and focus restoration.
- Verified native radio behavior and scoped names for agent questions, labelled tab panels, destructive-action distinction, and stable field names.
- Verified 44px coarse-pointer targets for shared buttons, icon actions, question tabs, picker actions, and attachment removal.
- Responsive focus no longer falls to the document body when tablet navigation changes between modal drawer and inline sidebar.

## Performance validation

- The 100-session fixture initially mounted 6 rows and expanded all 100 in 1,554ms without overflow.
- A 420-model search completed in 38ms while enforcing the 200-row mount ceiling; many-provider expansion remained bounded.
- Large tool output stayed behind a 220px preview/full-viewer boundary; expanded reasoning stayed capped at 378px.
- Streaming reader hold preserved an intentional scroll-up position and settled without unnecessary overlay mounts or animation loops.

## Tests/build/typecheck

- `npm test`: 1,556 passed, 2 environment skips, 0 failed; no missing-key or React `act()` warnings.
- `npm run build`: passed with all web and package assets emitted.
- `npm run build:desktop`: passed.
- `npx tsc --noEmit`: passed in `apps/web`, `packages/dictation`, and `packages/github`.
- `wave2ChatQa.mjs`, `wave3aComposerQa.mjs`, and `wave5ProductQa.mjs`: passed against isolated fixture servers and the built app with no captured page or console errors.
- Web server startup and health passed. Electron started under Xvfb with its bundled OpenCode runtime, created its tray, served the app, and reported `Desktop renderer ready`; the VM emitted expected unavailable-DBus/GTK diagnostics.
- Representative screenshots are in `docs/ui-redesign/phase-2-evidence/`.

## Remaining inconsistencies

- `apps/web/src/styles.css` remains a layered stylesheet with deprecated aliases and historical duplicate selectors. Broad mechanical flattening was not used as a reason to change working composition.
- Optional Workflow/task-tracker workbenches and SSH, Secure Safe, and Home Assistant integration surfaces retain bespoke package controls; the migration matrix marks them deferred rather than migrated.
- Git diff/history/graph, Terminal emulator, Browser frame/annotation, charts, and other specialized domain renderers intentionally retain their existing implementations.
- Physical iOS/Android safe-area, keyboard, zoom, and hardware-Back behavior, plus Safari/Firefox-specific overlay behavior, was not provable in this Linux Chromium environment.

## Deferred product decisions

- Tablet shell model, phone Canvas scope, context-pressure presentation, synced model favorites, recent attachments, package discovery, and phone Browser secondary-tool placement.
- Additional math delimiters, reasoning reader intent, native viewport/back policy, dense phone label management, pinned-worktree metadata priority, permission-preview coverage, and effort pricing guidance.
- Decision context and required product choices are recorded in `docs/ui-redesign/phase-3-candidates.md`.

## Recommended Phase 3 starting point

- Decide the tablet shell, phone Canvas, and native viewport/back policies first, then validate the chosen behavior on physical iOS and Android hardware.
- After those product decisions, migrate one deferred optional package workbench end to end, including its dialogs, responsive container behavior, accessibility, and domain-specific live fixtures, rather than applying a global CSS compatibility pass.
