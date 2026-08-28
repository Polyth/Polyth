# Phase 3 Wave 1 — handoff to Wave 2

- Wave 1 status: **complete** (product UX architecture only — **no production
  code was written or changed in Wave 1**; nothing in Phase 3 is implemented
  yet).
- Deliverable: `docs/product-ux/phase-3-product-ux.md` (decisions D1–D18,
  flows, patterns, priorities). This file is the execution companion.
- Branch: `feat/phase-3-product-ux-mobile-bb96`.

---

## 1. Summary of decisions (D-numbers refer to the main doc)

1. **Command registry** (D1): `apps/web/src/commands.ts` stays the registry of
   record; three feeders — core shell commands, the existing capability sync,
   and a NEW `commandPalette.commands` slot bridge (adapter per
   `docs/ux-audit/EXTENSION-SEAMS.md` §"commandPalette.commands"). `shell.ts`
   loses its deep relative imports into `packages/hotkeys/widgets` and
   `packages/dictation/widgets`; those commands move to their owning packages.
   `PaletteCommand` gains one optional `icon` field (key into `ui/icons.ts`).
2. **Shortcuts** (D2): `Mod+K` already IS the palette (`DEFAULT_KEYMAP.palette
   = "mod+k"`); nothing rebinds. `Mod+P` file mode and `Mod+Shift+F` session
   search unchanged. One new `HotkeyAction`: `notificationCentre`
   (`mod+shift+n`). The `HotkeyAction` union stays closed.
3. **Palette** (D3, D12): one `CommandPalette`, re-based on
   `ResponsiveOverlay`: dialog on wide/compact, full-screen `Sheet` on phone.
   Phone ordering = sessions/projects → commands → files; desktop keeps
   commands-first. Secondary session verbs (Archive/Pin/Rename) on focused
   workspace rows, reusing `SessionList` handlers. Delete never in palette.
4. **Search boundary** (D4): palette = act/jump (titles + files); session
   search = content (title/branch/labels/message text — transcript search
   already exists in `packages/session.searchEventText` via
   `/api/search/sessions`). SessionSearch gains an all-projects toggle and
   client-side `is:waiting`/`is:running` tokens. No new search backend.
5. **Starters** (D5): `starters.ts` + `StarterPicker.tsx` are canonical; no
   second system, no separate editor. Picker content wrapped in
   `ResponsiveOverlay` for desktop; palette command `cmd.starterPicker`;
   starters keep filling the composer via `requestComposerInsert` and never
   auto-send; pass real `hasHistory`/`lastTurnFinished` when opened from an
   existing session.
6. **New-session hero** (D6): keep three-zone `SessionHero` +
   `session.empty.widgets`; add status glyphs to `RecentSessions` rows (reuse
   sidebar taxonomy); do NOT add model/agent chips to the hero; chip bounds
   (2 phone / 3 desktop) unchanged.
7. **Continuity** (D7): projection-derived status taxonomy
   (working/approval/reply/unread/failed/idle) single-sourced in a shared
   resolver and rendered identically in sidebar rows, hero recents,
   bottom-nav, notification centre. No new AI summary; F9 assist stays
   off-by-default and untouched.
8. **Session management** (D8): verb set frozen — rename/fork/pin/archive/
   restore/delete/labels/folders/bulk/worktrees. "Move across projects"
   explicitly rejected (worktree/runtime binding). Delete stays menu +
   `confirmAlert` with running-session escalation.
9. **Recovery** (D9): four states — transient reconnect (quiet; NEW shell
   pill only after >3s disconnected, with Reconnect), OpenCode
   restarting/unavailable (in-place composer states + retryable send, draft
   preserved), server unreachable (registry `failed` page only when no data;
   otherwise degrade in place), user action required (LockScreen /
   Apply & restart — unchanged). Never raw WS errors; `turn/failed` tail gets
   a draft-seeding Retry affordance (never auto-send).
10. **Notifications** (D10): NTF-01 stack is final for Phase 3; add
    `notification-centre` to the default `mobileShortcuts`; add the hotkey;
    write policy-pinning tests (one row per transition, aborted turns silent,
    auto-accept silent). OC-20-004 stays `planned`.
11. **Mobile entry** (D11): resume-first — last active session, else project
    hero, else onboarding. Drawer never auto-opens. Already how
    `restoreSelectionAfterReady` behaves; Wave 2 adds phone-width tests, not
    new flow.
12. **Tablet band** (D13): compact = compact **desktop**. `WorkspaceBottomNav`
    becomes phone-only (today `Header.tsx` renders it in both phone and
    compact branches — remove the compact one).
13. **Canvas on phones** (D14): desktop/tablet-only this phase; one
    explanatory sentence in Settings → Widgets & Layout; no phone Canvas
    interaction model.
14. **Native back/viewport** (D15): Android Back = Escape-stack order → pane
    close → rail close → history; URL pushState semantics unchanged;
    keyboard/safe-area stays on `--visual-vh`/`--keyboard-inset`/`--safe-*`;
    zoom lockout unchanged until on-device testing (Wave 4).
15. **Candidate dispositions** (D16): Wave 2 small items = context-gauge
    pressure indicator (mount the currently-unmounted `ContextRing` from
    `Header.tsx` only at ≥60% usage, existing `level` colors), reasoning-well scroll
    hold, pinned-row state-over-branch priority, optional label sub-sheet.
    Deferred = synced favorites, recent attachments, package discovery, math
    delimiters, effort pricing. Wave 3 = browser phone tools, permission
    preview coverage, multirun/fusion depth.

---

## 2. Exact files Wave 2 must read first

Architecture + rules (read in this order):

1. `/workspace/AGENTS.md` — non-negotiables (erasable TS, `.ts` imports,
   package isolation, event-log-before-UI, no `http.ts`/`App.tsx` edits).
2. `docs/product-ux/phase-3-product-ux.md` — this wave's decisions.
3. `docs/dev/architecture.md` — REST/WS/event vocabulary; web app structure.
4. `docs/ui-redesign/design-system.md` — primitive APIs (§8 overlay chooser,
   §9 component APIs) and `docs/dev/styles.md` for any CSS touched.
5. `docs/ux-audit/EXTENSION-SEAMS.md` — the `commandPalette.commands`
   adapter contract.

Code to read before editing (per work item):

- Commands: `apps/web/src/commands.ts`, `apps/web/src/shell.ts`,
  `apps/web/src/capabilities.ts`, `apps/web/src/builtinCapabilities.ts`,
  `apps/web/src/slots.ts`, `packages/contracts/src/index.ts` (`UI_SLOTS`),
  `packages/commands/test/web-commands.test.ts`, `apps/web/test/slots.test.ts`,
  `apps/web/test/capabilities.test.ts`.
- Palette: `apps/web/src/components/CommandPalette.tsx`,
  `apps/web/src/components/ui/ResponsiveOverlay.tsx` (and `Sheet.tsx`),
  `apps/web/src/store.ts` (`openPalette`, `PaletteMode`, `Overlay`),
  `packages/server/src/search.ts`, `apps/web/src/responsiveShell.ts`.
- Hotkeys: `packages/hotkeys/src/index.ts`,
  `packages/hotkeys/widgets/hotkeys.ts`, `apps/web/src/shell.ts` (`ACTIONS`,
  `onKey`).
- Sessions/status: `apps/web/src/components/sidebar/SessionList.tsx`
  (status indicators + menu entries), `apps/web/src/init.ts`
  (`openSession`, `archiveSession`, `deleteSession`, boot restoration),
  `apps/web/src/components/workspace/builtinSurfaces.tsx` (`SessionHero`,
  `RecentSessions`), `apps/web/src/components/workspace/WorkspaceBottomNav.tsx`,
  `apps/web/src/components/Header.tsx` (phone/compact branches).
- Search: `apps/web/src/components/SessionSearch.tsx`,
  `packages/server/src/routes/org.ts` (search route shape).
- Starters: `apps/web/src/starters.ts`,
  `apps/web/src/components/mobile/StarterPicker.tsx`,
  `apps/web/src/composerInsert.ts`.
- Recovery: `apps/web/src/sync.ts`, `apps/web/src/init.ts`
  (`subscribeSyncStatus`, `reconnectSync`, `scheduleModelRetry`,
  `recheckRuntimeCatalog`), `apps/web/src/components/Sidebar.tsx`
  (connection dot/popover), `apps/web/src/components/OpenCodeRestartControl.tsx`,
  `apps/web/src/components/QuestionCards.tsx` / permission banner for the
  in-place patterns.
- Notifications: `apps/web/src/notificationCentre.ts`,
  `apps/web/src/components/NotificationCentre.tsx`, `apps/web/src/push.ts`,
  `apps/web/src/uiPrefs.ts` (`mobileShortcuts`),
  `apps/web/test/notificationCentre.test.ts`,
  `apps/web/test/notificationCentreUi.test.ts`, `docs/ux-audit/NTF-01-SPEC.md`.

---

## 3. Implementation order for Wave 2

Ship as separate commits in this order; every step keeps `npm test` green and
`npx tsc --noEmit` clean in `apps/web` + touched packages.

1. **Command slot bridge.**
   - New module `apps/web/src/commandBridge.ts` (name free): subscribe to
     `listSlots("commandPalette.commands")`, adapt each item's `meta`
     descriptor array into `registerCommand()` with per-item disposers,
     mirroring `syncCapabilityCommands()`'s reconcile loop in `shell.ts`.
   - Define the descriptor `meta` shape next to `PaletteCommand` (id, label,
     keywords, icon, group, hint string, `when`, `run`). Validate defensively
     — plugin input crosses `window.__polythSlots`.
   - Move `voice.read`/`voice.stop` registration into
     `packages/dictation/widgets` (its web entry), and the per-action
     "Change shortcut…" rows into `packages/hotkeys/widgets`, both via the
     bridge. Note: `shell.ts` legitimately keeps needing `getKeymap()` for
     `matchAction`/hints — fix that import by exposing the hotkeys widget
     entry under a workspace subpath export (e.g. `@polyth/hotkeys/widgets`)
     instead of the current `../../../packages/hotkeys/widgets/hotkeys.ts`
     relative path (Header.tsx has the same deep import to clean up). The
     dictation deep import is deleted outright.
   - Add `icon?: string` to `PaletteCommand`; render via the curated
     `ui/icons.ts` map only.
2. **Palette re-base + phone surface.**
   - Wrap `CommandPalette` content in `ResponsiveOverlay`; remove the
     hand-rolled scrim/dialog; height from `--visual-vh`.
   - Extract an ordering function `orderEntries(entries, shellMode)` (pure,
     unit-tested): desktop commands-first, phone workspaces-first.
   - Rewire `WorkspaceBottomNav`'s search button from `setOverlay("search")`
     to `openPalette("all")`; add a pinned "Search inside conversations…" row
     on phone that opens the `search` overlay.
   - Do not touch `paletteMode` semantics or the `is:archived` token.
3. **Shared status resolver + hero/pinned-row updates.**
   - Extract the row-status logic from `SessionList.tsx` into
     `apps/web/src/sessionStatus.ts` (pure; input `SessionProjection` +
     render-model attention bits it already uses); re-consume in
     `SessionList`, `RecentSessions`, `WorkspaceBottomNav` label, and later
     the palette rows.
   - Narrow pinned rows: state glyph outranks the worktree pill; full branch
     stays on title/hover/menu.
4. **Recovery surfaces.**
   - Shell reconnect pill: subscribe `subscribeSyncStatus`; render only after
     >3s in `disconnected`/`connecting`; action `reconnectSync()`; hide on
     `connected`. Place in the header status area (slot
     `app.header.actions` contribution, NOT an `App.tsx` edit).
   - Failed-send inline notice: `sendMessage` already returns `false` and
     toasts; add a persistent inline retry row above the composer when the
     last send failed with 503 `unavailable`, draft untouched.
   - `turn/failed` tail: one-line "Last turn failed — Retry" that seeds the
     composer with the last user text (use the existing draft seeding in
     `drafts.ts`; never auto-send).
5. **SessionSearch evolutions.** All-projects toggle (drop `projectId` from
   `api.searchSessions` when toggled), `is:waiting`/`is:running` client
   tokens (parse like `parseQuery` in `CommandPalette.tsx`), `Dialog` →
   `ResponsiveOverlay` if not already conforming on phone.
6. **StarterPicker re-base + entry points.** `ResponsiveOverlay` wrapper;
   `cmd.starterPicker` palette command; pass real session context flags from
   call sites that have a live session.
7. **Shell polish batch.** Compact-band `WorkspaceBottomNav` removal
   (`Header.tsx` compact branch), `notificationCentre` hotkey + default
   mobile shortcut, context-gauge quieting thresholds, Canvas sentence in
   Widgets & Layout settings, reasoning-well scroll hold, optional label
   sub-sheet.
8. **Palette session verbs.** Secondary actions on focused workspace rows
   reusing `archiveSession` / `api.organizeSession` / rename; keyboard
   contract: `Enter` opens, `Tab`/`→` cycles row actions, `Esc` unchanged.

Update `docs/dev/architecture.md` (web app structure section) and this
directory's docs alongside code, per repo convention.

---

## 4. Risks and collisions

- **Hotkeys.** `Mod+K` is *already bound* to the palette — do not "add
  Cmd+K support" (a duplicate listener outside `matchAction` would
  double-fire and bypass user rebinds). All new bindings go through
  `HOTKEY_ACTIONS` + `DEFAULT_KEYMAP` + the `ACTIONS` table in `shell.ts`, or
  hints in the palette will lie. `mod+shift+n` may be reserved by some
  browsers (Chrome incognito) — acceptable on web, native on desktop;
  document in the Settings shortcut editor rather than picking an exotic
  default.
- **`commands.ts` growth.** The smell is *feeder centralization*, not the
  registry. Reject any Wave 2 PR that adds a package-specific command
  directly to `shell.ts` or imports package widget code into it. The three
  legal feeders are enumerated in D1.
- **Starters double-system risk.** `HeroWidgets` + `session.empty.widgets` +
  `starters.ts` already interlock; do not introduce a "quick actions" concept
  parallel to starters (the phrase has appeared in older specs). If a surface
  needs one-tap prompts, it consumes `visibleStarters()`.
- **Palette re-base regressions.** `CommandPalette` currently owns IME safety
  (`keyCode === 229` guard), combobox a11y, sequence-guarded remote search,
  and scroll-into-view. Port all four; `responsiveOverlays.test.ts` and the
  palette-related assertions in `wave5ProductQa.mjs` are the safety net —
  extend, don't bypass.
- **Bottom-nav removal at compact widths** changes tablet session switching
  to drawer-only. Check `mobileNavigationAudit.test.ts` and
  `responsiveShell.test.ts` expectations before and update them
  intentionally, not mechanically.
- **Status resolver extraction** must not change the elapsed-ticker behavior
  (one shared interval in `SessionList.tsx`) or re-render cadence; keep the
  ticker where it is and pass resolved status down.
- **Slot bridge security posture:** descriptors arrive from
  `window.__polythSlots` (out-of-tree plugins). Validate shape, cap counts,
  and never let a descriptor's `run` execute during registration. A
  capability descriptor confers no authority (`capabilities.ts` comment) —
  the command descriptor must keep that property.
- **Do not regress instant session spawn** (`seedSessionCache` +
  optimistic open in `createSession`) while touching open/create paths for
  palette verbs.

---

## 5. What Wave 2 must NOT rethink

- The palette/session-search split (D4) — no unified "search everything" box.
- `Mod+K`/`Mod+P`/`Mod+Shift+F` bindings and the closed `HotkeyAction` union.
- Resume-first mobile entry (D11) — no home dashboard, no auto-opened drawer.
- The starters data model, its localStorage schema (`polyth.starters.v1`),
  and never-auto-send.
- The session verb set (no move-across-projects, no palette delete).
- NTF-01's pipeline, retention, or read-state model.
- The event-log/append-before-display contract and `NewSessionIntent`
  (no session creation before first Send).
- UX-ONBOARDING's first-run flow and project-registry state machine.
- Phase 1/2 visual decisions, tokens, or primitives.
- `responsiveShell.ts` breakpoints (820/480) — D13 works within them.

---

## 6. Open questions (non-blocking)

- **User-assignable shortcuts for dynamic commands** (opening the keymap
  beyond the closed union). Deferred; palette reach is sufficient. If Wave 3
  wants it, design a namespaced action id scheme in `packages/hotkeys` first.
- **"New since you left" timeline divider** — only if a per-session
  last-viewed watermark already exists browser-locally; otherwise skip
  (D7). Wave 2 should spend ≤1 hour confirming, then decide.
- **Synced model favorites / recent attachments / package discovery** —
  deferred with reasons in D16; revisit after Wave 4 device feedback.
- **Phone Canvas** — revisit only with Wave 4 on-device evidence of demand.
- **`mod+shift+n` default** — if browser reservation proves annoying in QA,
  fall back to `mod+alt+n`; either is fine, decide in the shortcut editor PR.

---

## 7. Suggested tests / QA for Wave 2

Automated (node --test, follow existing patterns — pure functions +
in-memory stores, no new frameworks):

- `apps/web/test/commandBridge.test.ts` (new): descriptor validation,
  register/replace/dispose parity with `slots.ts` semantics, malformed
  plugin input rejected, commands searchable immediately after registration.
- Extend `packages/commands/test/web-commands.test.ts`: `icon` field
  round-trip; `filterPalette` unchanged behavior.
- `apps/web/test/paletteOrdering.test.ts` (new): pure `orderEntries` — phone
  vs desktop ordering, group headers stable, empty-query behavior.
- Extend `apps/web/test/sessionRowMenu.test.ts` + new palette-verbs test:
  archive/pin/rename via palette rows call the same handlers; delete absent.
- `apps/web/test/sessionStatus.test.ts` (new): taxonomy resolver — one
  expected label/glyph per projection state; identical output consumed by
  sidebar/hero/bottom-nav fixtures.
- Recovery: unit-test the pill state machine (fake timers: no pill <3s,
  pill after, dismiss on connect); failed-send inline state (503 →
  visible retry row, draft intact).
- Notification policy pins: aborted turn → no row; auto-accept → no row;
  one row per transition (extend `notificationCentre.test.ts`).
- Hotkeys: `parseKeymap`/`matchAction` with the new action;
  `findConflicts` when a user binds `mod+k` to something else.
- Update `mobileNavigationAudit.test.ts` / `responsiveShell.test.ts` for the
  compact-band bottom-nav removal — intentional assertion changes only.

Live QA (extend `wave5ProductQa.mjs` or a sibling script; viewport matrix
from Phase 2: at least 320×568, 390×844, 768×1024, 1280×800):

1. `Mod+K` on desktop → dialog; same action at 390px → full-screen sheet,
   sessions-first, search not autofocused, `Esc`/swipe dismisses, focus
   returns to invoker.
2. Bottom-nav search on phone → unified surface; "Search inside
   conversations…" → SessionSearch.
3. Kill the server mid-session → no pill for 3s → pill appears → restart
   server → pill clears, gap-fill replays, no duplicate timeline rows.
4. Stop OpenCode (or force 503) → send fails inline with retry, draft
   preserved → retry succeeds after respawn.
5. Phone cold launch with a saved session → lands in that conversation, no
   drawer; with a deleted saved session → hero + recoverable error.
6. Tablet 768px: no bottom bar; drawer navigation complete; palette is a
   dialog with a hardware keyboard.
7. Hero recents show working/approval/reply glyphs matching sidebar rows for
   the same fixtures.
8. Starter picker from palette on desktop (dialog) and from hero "+" on
   phone (sheet); custom starter create/edit/delete/pin/reorder still works;
   picking fills the composer and never sends.
9. Notification bell default-present in the phone shortcut rail;
   `mod+shift+n` toggles the panel; row → session; dead row disabled.

Artifacts: screenshots/video per the walkthrough-artifacts skill; store QA
evidence with the PR as Phase 2 did (`docs/ui-redesign/phase-2-evidence/`
pattern → `docs/product-ux/phase-3-evidence/`).
