# UX-A390 — responsive Ember shell specification

- Case: `UX-A390`
- Model / role: `SOL` / UX and architecture specification
- Status: `specified`
- Specified: `2026-08-20`
- Product source baseline: `9c658ad3c0cd042333e38b38264679c8db5c7a96`
- Inputs: `UX-A390-polyth.md` at `16d47c0`, `UX-A390-POLYTH.md`
  at `63650db`, `VISUAL-BASELINE.md` at `bdb709b`,
  `EXTENSION-SEAMS.md` at `241e1f`, and `ARCHITECTURE-MAP.md` at
  `6b496ef`
- Scope: exact implementation contract for the shell at narrow widths. This
  artifact changes no product code.

## Decision and user outcome

At `320px` and `390px`, a user can open a project, choose or create a session,
change workspace view, type a multiline prompt, attach a file, send or stop,
open any enabled right-panel surface, inspect status, and return to chat. No
required control overlaps another control, no primary action is clipped, no
focused element is off-screen, and the shell creates no horizontal page
scroll.

Polyth must not copy polyth's fixed desktop rails. The narrow Polyth
interaction is an **Ember command shelf**:

1. The chat/workspace owns the full viewport width.
2. Projects and sessions enter from a transient left drawer.
3. The current workspace view is selected from one compact header picker.
4. Registered panels enter as a transient right/full-width sheet.
5. The composer becomes a deliberate two-tier command surface rather than
   shrinking desktop controls until they collide.

This is better than the audited polyth recovery path because no persisted
desktop rail can make first render unusable, no touch capability test is
required, and sessions, views, and panels each retain an explicit narrow entry
point. It is better than current Polyth because controls that report an open
state always have visible content.

## Audit comparison that the implementation must resolve

| Concern | polyth 1.19.0 | Current Polyth | Required Polyth result |
|---|---|---|---|
| Left navigation | A persisted `280px` sidebar remains inline and leaves a sliver of chat. | Sidebar disappears below `820px`, with no way to restore it. | Sidebar never consumes narrow layout width; a named drawer trigger is always present when a project header is present. |
| Header | Desktop siblings fragment in the remaining width. | An eleven-view, `378px` switcher passes under the fixed rail. | One bounded current-view trigger replaces the full switcher; every header hit target is in bounds. |
| Composer | Send is outside the viewport until manual sidebar collapse. | Model, Agent, attachment, focus, and Send overlap and hit-test as the wrong control. | Selectors and actions occupy separate rows; attachment and Send remain direct, distinct targets. |
| Right panels | A desktop rail remains inline. | A `44px` strip remains inline while the selected panel is `display:none`; `aria-pressed` lies. | The strip consumes zero workspace width; selected registry content appears in an overlay sheet and Escape closes it. |
| Zoom / short height | Wide layout survives only after rail recovery. | Centered hero starts above scroll origin at the `720×450` 200%-equivalent viewport. | Oversized content aligns to scroll start and every action is reachable by positive scrolling. |
| Session row | Duplicate same-name stops include an inert target. | One working session target already exists. | Preserve Polyth's single activation target and close the drawer only after successful activation. |
| Motion | Sidebar still interpolates with reduced motion. | Geometry already settles synchronously. | Preserve Polyth's behavior: reduced-motion geometry is final in the first rendered frame. |

## Responsive state model

Width alone selects shell mode. Pointer type, hover capability, user agent, and
device category must not participate.

| Mode | Query | Shell contract |
|---|---|---|
| `wide` | `min-width: 821px` | Existing inline sidebar and desktop view switcher remain. Existing rail behavior remains: docked above `1000px`, overlay from `821–1000px`. |
| `compact` | `max-width: 820px` | Sidebar is a modal drawer, view picker is compact, right panels are modal sheets, and no rail width is reserved. |
| `phone` | `max-width: 480px` | Compact rules plus the exact phone header, two-tier composer, prioritized status bar, and wrapped hero rules below. |
| `short` | `max-height: 600px` | Hero/stage aligns to block start, including at the `720×450` 200%-equivalent viewport. This combines with any width mode. |

Add `apps/web/src/responsiveShell.ts` as the sole JavaScript breakpoint seam.
It exports the numeric `820` and `480` boundaries, `ShellMode`, a pure
`shellModeForWidth(width)` classifier, and a `useShellMode()` subscription
implemented with `matchMedia` and `useSyncExternalStore`. CSS uses the same
literal boundaries. Do not create local-storage state for viewport mode.

State transitions are exact:

- Entering `compact` never opens the sidebar. Wide sidebar visibility is not a
  persisted drawer-open preference.
- An already selected `railPlugin` becomes a visible compact sheet without
  changing its id. Returning wide restores the same registered panel and
  width preference.
- Opening the session drawer closes an open panel first. Opening a panel closes
  the session drawer first. There is at most one shell-modal surface.
- Selecting a view closes the view picker. Selecting a project or successfully
  opening/creating a session closes the session drawer. A failed operation
  leaves the drawer open with the existing error path.
- Escape and backdrop press close the active drawer, view picker, panel picker,
  or panel sheet, one layer at a time, and restore focus to its opener.
- A resize that hides the currently focused control moves focus to the
  equivalent visible trigger; focus must never remain in `display:none`,
  `visibility:hidden`, or inert content.

## Exact interaction and layout

### 1. Header shelf

`Header.tsx` remains the header owner. Derive compact view items from the
existing `VIEW_GROUPS`; do not add a second view list or a second router.

In `compact` mode:

- Render a `44×44px` button named `Open projects and sessions`, with
  `aria-controls="polyth-session-drawer"` and truthful `aria-expanded`.
- Keep the title as the only flexible column: `min-width: 0`, one line,
  ellipsis. Hide the subtitle at `phone`; its project/branch values remain in
  the drawer and status surfaces.
- Replace `.view-switcher` with one `Picker`-based trigger named
  `Change workspace view, current: <label>`. The popover lists every enabled
  item in `VIEW_GROUPS`, marks the current item, supports arrows, Enter, Space,
  and Escape, and restores trigger focus. At `320px`, its visible text may
  condense to the current icon, but its accessible name must retain the label.
- Keep auto-accept directly operable for an active session. At `phone`, the
  shield becomes icon-only, remains `44×44px`, retains `aria-pressed`, and
  exposes `Auto-accept on/off` text to assistive technology. State is not
  conveyed by Ember color alone.
- Keep More directly operable as a `44×44px` trigger.
- Render `NarrowPanelTrigger` from `ContextRail.tsx` as the last header control
  so visual and keyboard order agree. It is hidden in `wide` mode.
- Hide the context ring only at `phone`; the same estimate remains available
  from the registered Context panel. At `481–820px`, retain it only if all
  bounding-box acceptance checks pass.

The `phone` header is `56px` high, has `8px` inline padding and `4px` gaps, and
uses bounded fixed control columns around one `minmax(0, 1fr)` title column.
At `320px`, the title may ellipsize but no trigger may shrink below `44px`.

### 2. Project/session drawer

Keep one `Sidebar` and its existing project/session state; do not build a
mobile navigation clone.

- In `wide`, behavior and `272/224px` widths stay unchanged.
- In `compact`, `.sidebar` is `position: fixed`, inset below no other shell
  element, `z-index` above the workspace, width
  `min(320px, calc(100vw - 24px))`, and full block height. Closed state is
  translated completely out of view, `visibility:hidden`, `aria-hidden`, and
  inert. `.sidebar.open` is visible and does not affect `.workspace` width.
- The drawer has an accessible heading `Projects and sessions` and a
  `44×44px` close button. Search, Git/worktrees, Open project, project rows,
  session rows, New session, and Settings have at least `44px` row height in
  compact mode where their container permits.
- The drawer traps focus while open, closes with Escape/backdrop, and restores
  focus to `Open projects and sessions`.
- Preserve the existing one-button session row. `SessionList.tsx` changes only
  enough to close the drawer after `openSession(id)` resolves; do not add a
  wrapper tab stop.

### 3. Registered panel sheet

`ContextRail.tsx`, `surfaces.ts`, `railPrefs.ts`, and the existing
`workspace.right.tabs` bridge remain authoritative. Do not enumerate built-in
panel components in the header.

- `NarrowPanelTrigger` uses the same `visibleSurfaces(...)` result as the host.
  It is a `44×44px` button named `Open workspace panels`. If a panel is open,
  it is named `Close <title> panel`, has `aria-expanded=true`, and closes that
  panel. If none is open, it selects the first enabled visible surface in the
  registry's existing deterministic order. It is disabled only when that list
  is empty.
- In `compact`, `.plugin-strip` moves inside the sheet as a horizontal or
  wrapping panel selector; it is not an inline sibling and reserves `0px`.
  Each enabled surface remains a named `44×44px` minimum target. Choosing a
  surface displays that exact registered component and sets `aria-pressed`
  only when its content has a nonzero visible box.
- The sheet is fixed above the status bar, width
  `min(380px, 100vw)` in `compact`, and `100vw` in `phone`. It overlays rather
  than squeezes or replaces registry state. The resize separator is hidden.
- Keep visited surfaces mounted and inert while hidden so existing keep-alive
  behavior survives panel switching. Do not add a poller or a second surface
  cache.
- The sheet has `role="dialog"`, `aria-modal=true`, an accessible
  `<title> panel` name, backdrop, focus trap, `44×44px` close button, Escape
  handling, and trigger-focus restoration.
- Plugin picker and management controls remain available inside the sheet.
  Server-managed module identifiers stay inert; this change does not create a
  client module loader.

### 4. Composer command surface

There remains exactly one `Composer`, one `AdaptiveTextInput`, one draft, and
one `send()` path for hero and docked variants. Add semantic wrappers; do not
fork controller logic.

At `phone`, `.composer-bar` is no longer one flex row:

1. `.composer-selectors` is a two-column
   `repeat(2, minmax(0, 1fr))` grid. Model and Agent occupy one column each.
   Profile spans both columns when present. Each picker trigger is `44px` high,
   `width:100%`, `min-width:0`, with ellipsis inside its label.
2. `.composer-extensions` contains the existing `composer.leading` and
   `composer.trailing` results. It wraps, and every contribution is constrained
   to the available inline size. Contributions do not move into transcript or
   application state.
3. `.composer-actions` is one bounded row: attachment and focused-editor
   controls at the start; Send/Run or Queue/Steer/Interrupt and Stop at the end.
   Every button is at least `44×44px`. The keyboard-hint badge may hide at
   `phone`; the action label may not.

The action row may wrap only before the primary action group; Send and Stop
must never separate from their labels or extend beyond the card. At `320px`,
the editor's bounding-box width is at least `calc(100vw - 48px)`. A multiline
prompt grows vertically and leaves the action row reachable through the
existing timeline/stage scroll.

Center-point hit testing for Model, Agent, Profile, attachment, focused editor,
Send/Run/Queue, and Stop must resolve to that control or one of its descendants.
Pairwise intersection area between unrelated visible controls is exactly zero.
Empty Send remains disabled; populated Send remains directly operable.

### 5. Hero, timeline, and status

- At `phone` or `short`, `.stage` uses `align-items:flex-start`,
  `justify-content:flex-start`, bounded `16px` inline padding, and positive
  vertical padding. No child may begin above the stage's scroll origin.
- Hero type uses existing production tokens and a bounded `clamp()` size.
  Starter chips and `.hero-foot` wrap; a chip becomes a full-width row when
  its label would clip. Hiding a keyboard-only hint is allowed, hiding a
  primary action is not.
- Timeline and docked composer keep `min-width:0`; overlays do not change
  their measured width or scroll anchor.
- `StatusBar.tsx` adds stable segment keys/classes. At `phone`, show a
  truncating project identity/status at the start and the current view at the
  end. Branch, model, and agent segments may be visually suppressed because
  they remain available in the drawer/header/panels; they must not be clipped
  half-visible. The status bar itself never scrolls horizontally.
- Terminal/editor/code panes may retain their intentional internal code
  scrolling. Their scroll width must not propagate to `.app`, `.workspace`,
  header, composer, or status bar.

## Shared modal and accessibility contract

Refactor the focus logic already in `components/a11y/Dialog.tsx` into an
exported reusable `useModalSurface` hook in that same file; `Dialog`, Sidebar,
and ContextRail consume it. Do not copy focus-trap implementations.

The hook must:

- focus a requested initial target or first enabled control on open;
- contain forward and reverse Tab traversal;
- close the active surface on Escape;
- restore a still-connected opener on close;
- make hidden mounted content inert and `aria-hidden`;
- avoid stealing focus when the viewport changes but no modal is open.

All new compact shell controls and actionable menu rows use `44px` minimum
touch targets where practical. Focus is visible with at least a `2px` outline
and `2px` offset; the focused element is never covered by a fixed surface.
Names, pressed/current state, errors, auto-accept, live status, and badges do
not rely on color alone.

Use Ember's production `theme.ts` variables: `--bg`, `--panel`, `--elevated`,
`--raised`, `--text`, `--text-dim`, `--muted`, `--accent`, `--accent-wash`,
`--accent-ink`, borders, radii, and shadows. Do not import
`docs/ux-audit/mockups/tokens.css` and do not hardcode an orange-only theme
fork. In every bundled theme, normal actionable text must reach `4.5:1`;
large text, meaningful icon boundaries, and focus indicators must reach
`3:1` against adjacent colors where practical. Disabled text is exempt.
Custom user themes remain subject to existing validation rather than a new
silent color rewrite.

With `prefers-reduced-motion: reduce`, drawer/sheet/view-picker geometry is
final in the first rendered frame. With no preference, optional transitions
are at most `160ms`, affect only transform/opacity, and never delay focus or
state truth.

## Event, API, extension, and security acceptance

This responsive change is browser-local presentation. It requires:

- no new `SessionEvent`, DTO, REST route, WebSocket message, storage key, or
  server projection;
- no optimistic transcript row and no change to `Composer.send()`,
  `sendMessage()`, append-before-broadcast, `(sessionId, seq)` dedupe, replay,
  fork, rewind, or catch-up ordering;
- no new auto-accept endpoint or policy; the compact control calls the existing
  `api.autoAcceptSet()` path;
- no arbitrary `cwd`, filesystem authority, credential, secret, or backend
  session id in browser state;
- no OpenCode process, SDK, SSE, transport, or type outside
  `packages/backend-opencode`;
- no panel enumeration outside the existing surface registry and no execution
  of server-managed `UiSlotItem.module` metadata;
- no direct polling by the compact trigger or sheet. Registered panel content
  keeps using `RailSurfaceContext` and shared stores.

Opening a drawer, picker, view, or panel is not model-visible and therefore
does not append an event. Any panel action that is already model-visible or
consequential keeps its existing append-before-display contract.

## Minimal implementation files and seams

| File | Exact responsibility |
|---|---|
| `apps/web/src/responsiveShell.ts` (new) | Width constants, pure classifier, reactive `matchMedia` subscription. No durable state. |
| `apps/web/src/components/Header.tsx` | Drawer trigger, compact view picker derived from `VIEW_GROUPS`, compact auto-accept, and registry-backed narrow panel trigger placement. |
| `apps/web/src/components/Sidebar.tsx` | Existing sidebar's drawer attributes, close control, backdrop, modal focus behavior, and mutual exclusion with panels. |
| `apps/web/src/components/sidebar/SessionList.tsx` | Close drawer only after successful session activation. |
| `apps/web/src/components/ContextRail.tsx` | Shared visible-surface model, exported narrow trigger, compact overlay host, truthful pressed state, Escape/focus behavior; preserve registry and keep-alive. |
| `apps/web/src/components/Composer.tsx` | Selector/extension/action wrappers only; preserve input, drafts, attachments, slots, and send behavior. |
| `apps/web/src/components/StatusBar.tsx` | Stable segment selectors and narrow priority, without new state. |
| `apps/web/src/components/a11y/Dialog.tsx` | Reusable modal-focus hook consumed by existing Dialog and both shell overlays. |
| `apps/web/src/styles.css` | The three width/height contracts, Ember treatment, 44px targets, no-overflow geometry, and reduced motion. |
| `apps/web/test/responsiveShell.test.ts` (new) | Boundary classification and source-independent shell state rules. |
| `apps/web/test/responsiveShell.live.ts` (new) | Live browser geometry, hit-testing, keyboard, resize, reload, motion, and contrast gate. Kept outside the default unit-test glob and run explicitly. |

Do not modify `App.tsx`, `Main.tsx`, `store.ts`, `surfaces.ts`, `railPrefs.ts`,
`theme.ts`, contracts, server, session, or backend packages unless an
acceptance test proves an unavoidable defect in the existing seam. Such a
change requires a separate reviewed scope; it is not implied by this spec.

## Test and release acceptance

The implementation is complete only when every item below passes against the
live synthetic runtime, not a static mockup.

### Automated geometry and interaction gate

Run at `320×900`, `390×900`, `768×900`, and `1280×900`, plus both
`390×844` portrait and `844×390` landscape. Run the zoom case at
`720×450` CSS pixels with device scale factor `2`.

For project-aware empty state, existing zero-message session, multiline
enabled Send, loaded timeline, working Queue/Stop, persisted-open panel, and
terminal view, assert:

1. `document.documentElement.scrollWidth <= clientWidth + 1` and the same for
   `.app`, `.workspace`, `.header`, `.main`, `.composer`, and `.statusbar`.
2. Every visible primary control has `left >= 0`, `right <= viewportWidth`,
   `top >= 0`, `bottom <= viewportHeight`, and nonzero dimensions.
3. Every unrelated visible primary-control pair has zero intersection area.
   `elementFromPoint()` at each control center returns that control or a
   descendant.
4. At `320` and `390`, session drawer, compact view, auto-accept when present,
   More, Panels, attachment, focused editor, Send/Run/Queue, Stop, drawer
   close, and panel close are at least `44×44px`.
5. The message editor width is at least `viewportWidth - 48px`; Send is enabled
   for text or attachments and its trailing edge remains at least `8px` inside
   the viewport.
6. The sidebar and panel consume zero layout width when closed. When open,
   each has a visible box no wider than the viewport, traps Tab/Shift+Tab,
   closes with Escape/backdrop, and restores its opener. No background control
   receives pointer or keyboard activation.
7. A surface button has `aria-pressed=true` only while its panel content has a
   nonzero visible box. Switching Files → Changes → Context reuses the
   registered hosts and does not remount an unrelated visited panel.
8. Wide → `390` → `320` → `768` → wide resizing without reload never restores
   inline narrow rails, clipping, stale focus, or false pressed state.
9. At `720×450`, the first hero element begins at or below the stage's scroll
   origin; scrolling to the positive maximum reveals the last starter/action.
10. With reduced motion, drawer and panel geometry sampled at
    `0/16/50/150/300ms` is identical. With normal motion, final geometry is
    reached by `160ms`.
11. Reload at `390px` preserves selected project/session, active view, draft,
    attachments, last selected panel/open state, and timeline scroll anchor.
    The sidebar still starts safely closed.
12. Computed foreground/background contrast meets the ratios in the
    accessibility section for every bundled theme. Focus and state remain
    identifiable in monochrome capture.

### Keyboard and screen-reader gate

- Tab order follows visual and DOM order from header controls through workspace
  content to the composer. Hidden desktop switcher/strip controls are absent
  from the accessibility tree.
- Enter and Space open the drawer, choose a view, activate one session target,
  open/switch a panel, and invoke Send when enabled.
- Escape closes only the topmost transient surface. Focus returns to the exact
  opener, including after resize.
- Accessible names include current view, panel title, auto-accept state, and
  action purpose. Drawer and sheet announce their dialog name and modal state.
- At browser 200% zoom, no focused control is off-screen and content reflows
  without two-dimensional page scrolling.

### Commands

```sh
node --test apps/web/test/responsiveShell.test.ts apps/web/test/railIconsOnly.test.ts
node --test apps/web/test/responsiveShell.live.ts
(cd apps/web && npx tsc --noEmit)
npm test
```

The live test command must receive the isolated runtime URL and synthetic
fixture identifiers through its documented environment variables. Save
passing screenshots and geometry JSON for `320`, `390`, `768`, `1280`, and
200% zoom. The OpenCode boundary grep gate remains mandatory.

## Explicit non-goals

- No polyth DOM, styling, fixed-rail behavior, pointer-based mobile
  detection, update toast, or duplicate session target.
- No product feature, new panel, view, session behavior, composer capability,
  event type, endpoint, persistence schema, or security policy.
- No workspace-surface registry migration, pane-provider work, slot-host
  rollout, composer-controller extraction, timeline extraction, or theme-token
  redesign from `EXTENSION-SEAMS.md`.
- No second sidebar, composer, view list, panel registry, panel cache, command
  system, transcript store, or responsive preference.
- No remote plugin JavaScript loader, arbitrary React node persistence, direct
  filesystem access, independent panel polling, or OpenCode leakage.
- No broad desktop visual redesign. Wide behavior changes only where shared
  accessibility/modal code must remain consistent.
- No claim that root `scrollWidth === clientWidth` proves success; bounding
  boxes, intersections, center hit-testing, focus, and reachable scroll
  origins are release gates.

## Exact next task

`Fable-A390-implementer`: implement only the files and acceptance contract in
this specification, then hand the live runtime and passing artifacts to the
SOL verifier.
