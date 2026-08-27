# Phase 2 candidates — product-level UX issues

Issues found during Phase 1 (Wave 3: mobile-first shell + composer) that are
**product decisions**, not styling bugs. Phase 1 deliberately does not change
behavior; each item below needs an owner decision before implementation.

Format per item: Problem / Current behavior / Why problematic / Proposed
direction / Requires product decision.

---

## 1. The "power composer" selectors row is unreachable

- **Problem:** `Composer.tsx` renders a full model/context-window/agent/thinking
  selector row (`.composer-selectors`) only when `!simpleMode`, but `simpleMode`
  is true in chat workspace mode *and* in widget mode, and non-chat workspace
  modes replace the session surface with the widget canvas. No mount of the
  composer can currently reach the power row.
- **Current behavior:** Model and mode selection on the chat surface happen
  through the composer model header (`SessionContextBar` / `ModelPicker`); the
  power row plus `ContextWindowPicker` are dormant code paths.
- **Why problematic:** Dead-but-maintained UI accumulates styling and migration
  cost (it was migrated to `ui/Popover` in Wave 3 without any way to verify it
  in the running app), and its existence hides the real question: should
  advanced users get a denser, always-visible control row?
- **Proposed direction:** Either delete the power row and fold its unique
  affordances (context-window meter) into the model header, or expose it behind
  an explicit density/pro setting.
- **Requires product decision:** yes — remove vs. surface.

## 2. `Menu` sheet titles reuse verbose accessibility labels

- **Problem:** the `ui/Menu` primitive uses one `label` string as both the
  `aria-label` and the phone sheet title. Labels written for screen readers
  ("Sort sessions, currently Recent activity") truncate in the sheet header.
- **Current behavior:** the sidebar sort sheet title renders as
  "Sort sessions, currently Recent acti…".
- **Why problematic:** phone sheet titles should be short nouns ("Sort by");
  the current/selected value is already visible as a checkmark in the list.
- **Proposed direction:** add an optional `title` prop to `Menu` (sheet heading)
  distinct from `label` (accessible name), with copy guidelines in
  design-system.md.
- **Requires product decision:** copy conventions only; API change is mechanical.

## 3. Menus lost `menuitemradio` / `menuitemcheckbox` semantics

- **Problem:** `ui/Menu` entries only support `role="menuitem"`. The old
  hand-rolled sidebar sort/filter menus exposed `menuitemradio`/
  `menuitemcheckbox` with `aria-checked`.
- **Current behavior:** after the Wave 3 migration, selection state is carried
  visually by a leading check icon, not programmatically.
- **Why problematic:** screen-reader users no longer hear which sort order or
  filter is active.
- **Proposed direction:** extend `MenuAction` with `checked?: boolean` and a
  `kind?: "action" | "radio" | "checkbox"` that maps to the proper role and
  `aria-checked`; render the check glyph from `checked` instead of caller-passed
  icons.
- **Requires product decision:** no (accessibility parity), but scheduling —
  it touches every current `Menu` adopter.

## 4. Session rows stack three overlapping action affordances

- **Problem:** a session row has a hover-revealed `⋮` menu button, a persistent
  touch "More" chip (`.session-more-btn`), Shift-hover quick actions, and swipe
  actions — all occupying the same right-edge zone.
- **Current behavior:** on touch layouts the persistent More chip and the
  (transparent) hover menu button overlap in the same corner; Wave 3 fixed the
  timestamp sliding underneath, but the duplication remains.
- **Why problematic:** four discovery paths for the same actions is confusing,
  costs ~52px of every row, and each path needs separate hit-area and
  keyboard-focus maintenance.
- **Proposed direction:** one canonical row-actions entry point per input mode
  (hover reveal on fine pointers, persistent chip on coarse), with swipe as an
  accelerator only; drop the Shift-hover layer.
- **Requires product decision:** yes — which affordances survive.

## 5. Tablet band (481–820 px) shows desktop chrome with phone interactions

- **Problem:** tablets keep the compact desktop-style header, statusbar, and
  chat metrics while also getting the modal drawer and bottom-nav patterns.
- **Current behavior:** at 768 px the shell mixes both idioms (compact header
  with metrics + phone drawer + bottom nav).
- **Why problematic:** neither layout is optimal: the header spends width on
  metrics few tablet users need, while navigation requires the same number of
  taps as a phone.
- **Proposed direction:** decide whether the tablet band is "big phone"
  (adopt the phone shell wholesale) or "small desktop" (inline collapsible
  sidebar, no bottom nav).
- **Requires product decision:** yes — interaction model for the band.

## 6. No Canvas access from the phone shell

- **Problem:** the Chat/Canvas workspace-mode switch renders only in the wide
  and compact-non-chat headers; the phone header shows the shortcut rail and
  the bottom nav offers history / sessions / new-session only.
- **Current behavior:** on a phone in chat view there is no visible control to
  reach Canvas (widgets) mode.
- **Why problematic:** a whole workspace mode silently disappears on phones;
  users who set up widgets on desktop cannot see them on mobile.
- **Proposed direction:** either declare Canvas desktop-only explicitly (and
  say so in Settings), or add Canvas as a mobile shortcut-rail destination.
- **Requires product decision:** yes — mobile scope of the widget canvas.

## 7. Model header wraps instead of prioritizing on very narrow phones

- **Problem:** the composer model header shows model identity plus the
  thinking slider and mode ("Build") cluster; at 320–360 px the cluster wraps
  to a second row (Wave 3 made the wrap clean), consuming vertical space that
  competes with the keyboard-constrained conversation area.
- **Current behavior:** two-row model header on narrow phones.
- **Why problematic:** the mission is to maximize conversation space; a
  second control row costs ~36 px permanently.
- **Proposed direction:** collapse the mode cluster into the model sheet on
  narrow phones (one row: model name + chevron), surfacing thinking/mode as
  rows inside the existing picker sheet.
- **Requires product decision:** yes — which controls deserve permanent
  visibility on phones.
