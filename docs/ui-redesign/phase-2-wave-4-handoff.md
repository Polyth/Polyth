# Phase 2 — Wave 4 handoff: settings and feature surfaces

Wave 4 migrates the Settings experience and representative package surfaces
onto the Phase 1 primitives and token contract. It does not change backend,
event, OpenCode, terminal-emulator, browser-engine, or complex domain
visualization behavior. Wave 5 has not started.

## Settings

Status: **migrated for the Wave 4 scope**, with specialized editors retained.

- The desktop Settings surface remains a focused 800 px two-pane dialog with a
  stable navigation list and one scrolling content pane.
- The phone surface is an explicit navigation-to-detail flow. Detail views have
  a Back action, selected-page title, close action, full-width rows, and
  full-width control containers.
- `SettingsView` now consumes the shared modal-surface focus/scroll contract.
  Closing Settings after a nested package tour restores the permanent mobile
  Settings launcher or the desktop profile launcher.
- General, Appearance, Chat, Notifications, Sessions, Projects, Behavior,
  Packages, Access, Integrations, Agents, MCP, and About controls were migrated
  where applicable to `Button`, `IconButton`, `TextInput`, `Textarea`,
  `Checkbox`, `Switch`, `Select`, `Dialog`, `Spinner`, and `EmptyState`.
- Package settings use responsive two-column marketplace tiles on desktop and
  one column on phones. Common loading, danger, toggle, and tour actions use
  shared primitives.
- Package-provided settings for Git, Commands, Hotkeys, Plugins, Schedule, and
  Dictation received the same common-control migration.

The Widgets & Layout workbench, theme preview/swatches, and model picker retain
their existing specialized compositions. They were not replaced with a second
design system.

## Feature surface status

### Migrated

- **Files:** shell search, mobile tabs, row action menu, create/goto controls,
  editor actions, switches, loading, error, and empty states. Editor and diff
  renderers are unchanged.
- **Goals:** page actions, goal fields, attach dialog, footer actions, and
  destructive controls. Progress visualization remains domain-owned.
- **Usage:** dashboard/range/density tabs, refresh/retry actions, settings
  checkboxes, provider empty states, responsive card/table chrome, and quota
  actions. Charts are unchanged.
- **Knowledge:** kind tabs, source filter, search, track forms/actions, and
  loading/empty states.
- **GitHub:** repository/PR tabs, overflow menu, search/filter actions,
  create/reply/edit/review forms, merge/review selects and confirmations, and
  narrow action/table treatment. Diff content is unchanged.
- **Walkthrough:** mode/source tabs, generation/review actions, inputs, busy
  states, review cards, and step indicators.
- **Multirun:** prompt, model/agent selectors, launch actions, run cards, and
  narrow container behavior.
- **Fusion:** prompt, model selection, launch action, weight/answer cards, and
  narrow container behavior.
- **Other visible surfaces:** Commands, Schedule, Plugins, Hotkeys, and
  Dictation common controls and destructive actions.

### Partially migrated by design

- **Git:** tabs, toolbar actions, settings forms, dialogs, and source-control
  shell use shared primitives. History, diff, and graph visualization are
  retained.
- **Terminal:** tabs, rename/close/new/search/clear actions, search options,
  follow control, status chrome, and responsive shell are migrated. Emulator
  internals and PTY behavior are untouched.
- **Browser:** navigation, URL entry, device/scheme selectors, agent tools,
  status, inspector controls, and confirmation dialogs are migrated. Browser
  frame and annotation engine behavior are untouched.

No prioritized surface was wholly deferred.

## CSS hygiene

- Repatriated Multirun, Fusion, Walkthrough review, and Walkthrough step styles
  from `apps/web/src/styles.css` into their package stylesheets.
- Removed touched package-specific menu, tab, empty-state, button, select, and
  switch rules after their components moved to shared primitives.
- Updated touched responsive package blocks to target primitive classes and,
  for the repatriated embedded panels, use package container queries.
- Preserved one canonical primitive definition in core; the primitive test now
  counts exact selectors so scoped consumers do not look like duplicate base
  definitions.
- Documented `components/ui/index.ts` as an allowed generic shell primitive
  import for package widgets. No feature-owned helper or state moved into the
  app.

The core stylesheet is still a layered monolith. Untouched areas still contain
duplicate legacy selectors, deprecated radius aliases, package-global
selectors, and viewport media queries. Wave 4 did not mass-delete aliases that
still have consumers.

## Validation

- `npm run build` — pass after the final Settings mobile-title correction.
- `npm test` — pass: 1,552 passed, 0 failed, 2 skipped by environment (1,554
  total). The suite emits a React missing-key warning while mounting
  `TerminalView`; it does not fail and was not traced to a user-visible
  regression in this wave.
- `npx tsc --noEmit` — pass in `apps/web` and every touched package:
  Browser, Commands, Dictation, Files, Fusion, Git, GitHub, Goals, Hotkeys,
  Knowledge, Multirun, Plugins, Schedule, Terminal, Usage, and Walkthrough.
- Focused responsive/primitive/package tests — pass, including Settings modal
  focus, 390 px overlays, 320 px source-control hit targets, package
  containment, Usage container behavior, and shared primitives.
- Browser QA against the built app:
  - 1440×900 Settings Packages: 800 px dialog, 36 tiles loaded, no horizontal
    overflow.
  - 390×844 Settings General: Back + `General` title present, no horizontal
    overflow, and the first three control rows each occupy 358 px.
  - 390×844 Browser: toolbar and address control present with no horizontal
    overflow.

Selected evidence:

- `/opt/cursor/artifacts/wave4_settings_desktop_final.png`
- `/opt/cursor/artifacts/wave4_settings_mobile_final.png`
- `/opt/cursor/artifacts/wave4_browser_mobile_final.png`

## Wave 5 QA leftovers

- Exercise Settings with long translated labels, 200% browser zoom, RTL, and
  large interface fonts. The 800 px desktop shell and marketplace cards have
  only English fixture coverage in this wave.
- Verify keyboard navigation and focus return through nested Select/Menu/Dialog
  combinations on real Safari and Firefox; automated Chromium and DOM tests
  pass.
- Stress Files create/goto forms and row menus with long paths at 320–390 px,
  including an open software keyboard.
- Stress Terminal with many long tab names, reconnecting/exited states, and
  search open at short viewport heights. Investigate the test-only React key
  warning if it remains reproducible.
- Exercise Browser secondary agent tools, inspector tabs, errors, and approval
  dialogs with a live browser session at phone and docked-panel widths.
- Verify Git and GitHub large diffs/tables, long branch names, and all conflict
  states. The visualization algorithms were intentionally retained.
- Populate Usage, Knowledge, Walkthrough, Multirun, and Fusion with pathological
  live data (long provider/model names, many findings/runs, errors, and empty
  transitions) and compare compact versus wide containers.
- Continue CSS ownership cleanup only where Wave 5 QA finds a visual issue.
  Broad monolith flattening, package viewport-query conversion, and deprecated
  alias removal remain separate mechanical work, not an excuse to change
  composition during QA.

## Product notes (not implemented)

- Marketplace search/filtering or a user-selectable density mode may become
  useful if the package catalog grows beyond the current fixture. This needs a
  product decision rather than a Wave 4 CSS variant.
- A dedicated phone sheet for Browser secondary agent tools may be preferable
  if Wave 5 finds horizontal tool scrolling hard to discover. The current
  toolbar behavior remains unchanged.
