# Phase 3 — product UX architecture (Wave 1)

- Wave: **1 of Phase 3** (product UX architecture; no production code in this wave)
- Status: **architecture specified — nothing in this document is implemented by Wave 1**
- Baseline: branch `feat/phase-3-product-ux-mobile-bb96`, on top of Phase 2
  (`de88ceb4`) and the OpenCode hardening pass (`d6c0f174`)
- Scope: daily-use product UX for Polyth as a cross-platform agent workspace
  (Web, macOS/Linux/Windows via `apps/desktop`, iOS/Android later via a
  Capacitor shell around the same canonical React UI — Wave 4)
- Companions: `docs/ui-redesign/PHASE-2-HANDOFF.md` (visual system, final),
  `docs/ui-redesign/phase-3-candidates.md` (deferred product decisions —
  resolved or explicitly deferred below), `docs/product-ux/phase-3-wave-1-handoff.md`
  (Wave 2 execution order)

This is not a redesign. Phase 1/2 shipped a stable design system
(`docs/ui-redesign/design-system.md`, `apps/web/src/components/ui/`). Phase 3
decides how a person uses Polyth every day: how they start work, find things,
return to work, recover from failures, and use the same product on a phone.
Every decision below is grounded in code that exists on this branch, and every
"replace" is justified against what it replaces.

---

## 0. Method and ground truth

Read before designing (all inspected on this branch):

- Command surface: `apps/web/src/commands.ts` (registry),
  `apps/web/src/shell.ts` (registrations + global keydown),
  `apps/web/src/components/CommandPalette.tsx` (unified palette),
  `apps/web/src/capabilities.ts` + `builtinCapabilities.ts` (navigation
  registry that already auto-feeds the palette), `packages/hotkeys/src/index.ts`
  (`DEFAULT_KEYMAP`, closed `HotkeyAction` union, conflict tooling).
- Starters: `apps/web/src/starters.ts` (catalog, context ranking, prefs,
  custom starters), `apps/web/src/components/mobile/StarterPicker.tsx`,
  `apps/web/src/components/workspace/builtinSurfaces.tsx` (`SessionHero`,
  `session.empty.widgets` slot).
- Search: `apps/web/src/components/SessionSearch.tsx`,
  `packages/server/src/search.ts` (workspace matcher, `is:archived`),
  `packages/server/src/routes/org.ts` (`/api/search/sessions` — metadata +
  transcript snippets via `store.searchEventText`), `/api/files/search`
  (scored, shared with palette + mentions).
- Sessions: `packages/server/src/sessions.ts`, `apps/web/src/init.ts`
  (`openSession`, `createSession`, boot restoration), `apps/web/src/store.ts`
  (`NewSessionIntent`, pane command path), `Sidebar.tsx` + `sidebar/SessionList.tsx`
  (rename/fork/pin/archive/restore/delete/labels/bulk, attention badges).
- Recovery: `apps/web/src/sync.ts` (backoff reconnect, seq dedupe),
  `init.ts` (model-catalog retry, `recheckRuntimeCatalog`), sidebar connection
  dot + `sidebar.reconnect`, `OpenCodeRestartControl.tsx`/`RestartOverlay.tsx`,
  server 503 `unavailable` + pool respawn (`docs/dev/architecture.md`),
  F16 relock on 401.
- Notifications: NTF-01 as shipped (`apps/web/src/notificationCentre.ts`,
  `components/NotificationCentre.tsx`, `packages/server/src/push.ts`,
  `apps/web/src/push.ts`, `sw.js`), `docs/ux-audit/NTF-01-SPEC.md`.
- Mobile: `responsiveShell.ts` (wide/compact/phone), `components/mobile/*`
  (Sheet, MobileNavigationRail, SessionContextBar, StarterPicker, HeroWidgets),
  `workspace/WorkspaceBottomNav.tsx`, `mobileViewport.ts` tokens
  (`--visual-vh`, `--keyboard-inset`), `docs/dev/desktop.md`.
- Tests that encode intended UX: `apps/web/test/onboardingFirstRun.test.ts`,
  `projectRegistry.test.ts`, `mobileChatRedesign.test.ts`,
  `mobileNavigationAudit.test.ts`, `sessionRowMenu.test.ts`,
  `notificationCentre*.test.ts`, `sidebar*.test.ts`, `capabilities.test.ts`.

Honesty constraints carried through this document: parity rows in
`docs/parity/polyth-parity.yaml` that are `planned`/`implementing` stay that
way; nothing below claims them done. Everything model-visible stays behind the
event log. Nothing below requires touching `packages/server/src/http.ts`,
`App.tsx` slot wiring, or the OpenCode boundary.

---

## 1. Decisions

Numbered; each has a rationale grounded in the codebase. "Wave 2" = the
implementation wave that follows this document. "Wave 3" = feature-depth wave
(multirun/fusion/browser). "Wave 4" = native mobile shells (Capacitor).

### D1 — One command registry; `commands.ts` stays, `shell.ts` stops being the funnel

**Decision.** The command registry of record remains the small
`apps/web/src/commands.ts` `Map` (`registerCommand`/`listCommands`/`runCommand`
— it is already an id-keyed registry with disposal, `when()` availability,
live `hint()` resolvers, and folded search). We do **not** build a second
registry. What gets replaced is the *feeding* model: today
`apps/web/src/shell.ts` is the only production feeder and it deep-imports
package widget code by relative path
(`../../../packages/hotkeys/widgets/hotkeys.ts`,
`../../../packages/dictation/widgets/voice.tsx`) — that is the "giant file
that knows every package" smell, and it violates the workspace-import rule in
`AGENTS.md`.

Wave 2 gives the registry exactly **three feeders**, all of which already have
precedent in the codebase:

1. **Core shell commands** (palette, search, settings, new/fork/abort/export
   session, focus composer) stay registered in `shell.ts` — they are genuinely
   shell-owned.
2. **Capability commands** stay auto-generated by the existing
   `syncCapabilityCommands()` in `shell.ts` from the capability registry
   (`capabilities.ts`). This is already the correct extensibility mechanism:
   any feature package that registers a `CapabilityDescriptor` (via its web
   entry or `window.__polythCapabilities`) is instantly searchable in the
   palette, appears in the header/rail/mobile navigation, and disposes
   cleanly. Multirun, Fusion, Git, Terminal, Files, Browser, Goals, Knowledge,
   Plugins, Schedule, GitHub already flow through this path — the palette
   requirement "must find Open project / Files / Git / Terminal / Browser /
   Goals / Knowledge / Plugins / Multirun / Fusion / other registered
   capabilities" is satisfied by the existing registry plus D3's additions.
3. **A slot bridge for package/plugin commands.** The `commandPalette.commands`
   slot already exists in `UI_SLOTS` (`packages/contracts/src/index.ts`) and
   `docs/ux-audit/EXTENSION-SEAMS.md` §174 already prescribes its semantics:
   *"Do not mount as JSX. Adapt descriptors into `commands.ts`."* Wave 2
   implements that bridge (mirroring the existing `workspace.right.tabs` →
   rail-surface bridge): a slot item whose `meta` carries a command descriptor
   array is adapted into `registerCommand()` calls, kept in sync via
   `subscribeSlots`, and disposed with the slot item. Feature packages then
   declare palette actions from their own web entries with workspace imports
   only — no `shell.ts` edit, no `App.tsx` edit, package isolation preserved.

**Migration required by this decision:** the two package-owned command groups
currently hardcoded in `shell.ts` (voice `voice.read`/`voice.stop`;
hotkey-editor rows built from `HOTKEY_ACTIONS`) move to their owning packages'
web entries via feeder 3, and the deep relative imports are deleted. The
sidebar-grouping commands (`registerSidebarGrouping`) stay — they are core
sidebar behavior with a documented plugin entry point.

**Command descriptor schema (kept deliberately small).** Wave 2 extends
`PaletteCommand` by exactly one optional field and renames nothing:

```ts
interface PaletteCommand {
  id: string;              // stable, namespaced: "capability.git", "voice.read"
  label: string;           // display title
  hint?: string | (() => string); // shortcut hint; live resolver tracks rebinds
  icon?: string;           // NEW, optional: key into ui/icons.ts semantic map
  group?: string;          // display group; groups render as palette sections
  keywords?: string[];     // synonyms, legacy names, technical labels
  when?: () => boolean;    // availability predicate (runtime truth, never preset)
  checked?: () => boolean; // radio-style state (e.g. current grouping)
  run: () => void;         // handler
}
```

This is the requested `id/title/keywords/icon/group/shortcut/availability/
handler` schema mapped onto the names the codebase already uses. `hint` stays
a live resolver because custom keybindings must show through
(`hintOf(action)` in `shell.ts` already does this). Icons resolve through the
curated `ui/icons.ts` map only — never raw Lucide imports
(`design-system.md` §6).

### D2 — Shortcuts: keep `Mod+K` = palette; no rebinding, no second palette

**Decision.** The palette binding question is already answered in
`DEFAULT_KEYMAP`: `palette: "mod+k"`, `searchFiles: "mod+p"`,
`searchSessions: "mod+shift+f"`. There is **no collision to resolve** — Mod+K
is the palette today, Mod+P is the same palette in file-focused mode, and both
route through the user-editable keymap with conflict detection
(`findConflicts`, `resolveKeymapConflicts`). Wave 2 must not introduce a new
Cmd/Ctrl+K consumer, must not hardcode key handling outside
`shell.ts`'s `onKey` → `matchAction` path, and must keep every new global
shortcut inside the `HotkeyAction` union so the Settings → Shortcuts editor
and the palette's live hints stay truthful.

**Two additions, both through the existing union:** `notificationCentre`
(default `mod+shift+n`; toggles the NTF-01 rail surface exactly like the bell)
and `starterPicker` is deliberately **not** given a global binding (it is a
composer-context action, reachable via palette; see D5). Known limitation to
document, not fix: browsers reserve some `mod+n`/`mod+shift+n` combinations
(Chrome cannot intercept Ctrl+N); the web app already accepts this for
`newSession`, the desktop app can bind them natively. The closed
`HotkeyAction` union stays closed in Phase 3 — dynamically registered commands
are reachable through the palette, not through user-assignable chords; opening
the keymap to arbitrary command ids is deferred (recorded as an open question,
not a blocker).

### D3 — One palette, richer verbs — not more chrome

**Decision.** `CommandPalette.tsx` remains the single command/search surface
on desktop. Wave 2 evolves it, never forks it:

- **Keep**: unified entries (commands + projects + sessions + files), `Mod+P`
  file mode, `is:archived` token, combobox/listbox a11y, debounced
  server search with sequence-based stale-drop, group headers.
- **Evolve (1) — session verbs in place.** A session result currently only
  opens. Wave 2 adds a secondary action affordance on the focused workspace
  row (`Tab`/`→` or an inline icon on hover/focus): Archive / Pin / Rename,
  reusing the exact handlers from `sidebar/SessionList.tsx`
  (`archiveSession`, `api.organizeSession`, `api.renameSession`). No new
  destructive verbs in the palette: Delete stays in the session row menu and
  its confirm dialog (D8).
- **Evolve (2) — palette chrome on primitives.** The palette still hand-rolls
  its dialog (`role="dialog"` + scrim in `CommandPalette.tsx`, flagged since
  the Phase 1 matrix). Wave 2 rebases it on `ResponsiveOverlay` so the same
  component renders as a top-anchored dialog on wide/compact and as the
  full-screen sheet surface on phone (D11). Height caps move from
  `.palette-list { max-height: 46vh }` to `--visual-vh` per the design system.
- **Evolve (3) — result ordering per form factor.** Desktop keeps
  commands-first (muscle memory: type a verb). Phone orders
  sessions/projects first, commands second — on a phone the dominant palette
  job is "get to a conversation", which the bottom-nav search entry confirms
  (D11). One list, one filter, one ordering function with a `ShellMode`
  parameter; test as a pure function like `filterPalette`.
- **Do not add**: browsing UI, command categories chrome, recents-in-palette,
  nested pages, or an icon grid. The palette is a typing surface. Icons from
  D1 render as leading glyphs only.

### D4 — Search boundaries: two surfaces, one rule

**Decision.** Polyth keeps exactly two search surfaces, split by *depth*, and
gains no new search backend:

| Surface | Job | Backend | Shortcut |
| --- | --- | --- | --- |
| Command palette | Act + jump: commands, project/session *titles*, file names | `search.ts` workspace matcher, `/api/files/search` | `Mod+K` / `Mod+P` |
| Session search | Find *content*: title, branch, labels, message text with snippets | `/api/search/sessions` (`searchEventText` — already exists) | `Mod+Shift+F` |

Rationale: full-text transcript search **already exists server-side**
(`packages/session` `searchEventText`, exposed with bounded snippets through
`routes/org.ts`), so `SessionSearch.tsx` is the legitimate deep-search home
and no new indexing work is designed. The palette intentionally does *not*
match message text — mixing transcript hits into an action list makes both
worse.

Wave 2 evolutions to `SessionSearch.tsx`, all cheap because the API already
supports them: (1) an **All projects** toggle — the route takes an optional
`projectId`, the component currently always scopes to the active project;
(2) recency + state facets rendered from data already on
`SessionProjection` (status dot and `ago()` are already shown; add
`is:archived`-style tokens `is:waiting`, `is:running` filtered client-side
from projections — no server change); (3) the same `ResponsiveOverlay`
re-basing as the palette. Project search stays where it is (palette + sidebar
filter); a separate "project search" surface is explicitly rejected — with a
typical single-digit project count it is a palette job.

### D5 — Starters: the existing system is the system

**Decision.** Keep `starters.ts` + `StarterPicker.tsx` as the one starters
implementation — it already has everything Phase 3 needs: built-in catalog
with context ranking (`contextualStarterIds` reacts to conflicts, dirty
worktree, ahead-of-upstream, finished runs), pin/hide/reorder/recents,
size-bounded custom starters with icon choice, search, and discovered
project commands/skills folded into the same catalog
(`commandStarter`/`skillStarter`). No second starters system, no server-side
starter store, no "full editor" beyond the form the picker already contains.

Wave 2 changes are placement and reach, not model:

1. **Desktop presentation.** `StarterPicker` renders a phone `Sheet`
   unconditionally today. Wrap its content in `ResponsiveOverlay` so desktop
   gets a proper anchored dialog while phones keep the identical sheet.
   Content, prefs, and categories are shared; only the shell changes.
2. **Keyboard reach.** Register a `cmd.starterPicker` palette command
   ("Add a starter…", group Session, `when: hero visible or composer focused`)
   and make hero chips reachable by Tab order (they are buttons already; the
   gap is that the picker itself has no keyboard entry point on desktop).
3. **Composer insertion stays the contract.** Starters fill the composer via
   `requestComposerInsert(prompt)` and never auto-send. This is already the
   behavior and it is correct: a starter is a draft, and the first Send
   remains the only session-creating, event-appending act
   (UX-ONBOARDING invariant).
4. **Context inputs stay pure.** `starterContextFrom(gitStatus, session)` is
   the only context seam. Wave 2 passes real `hasHistory`/`lastTurnFinished`
   when the picker opens from an existing session (currently `SessionHero`
   passes `false/false`, which is right for the hero but wrong if the picker
   is offered mid-session). No new context signals are invented.

### D6 — New-session experience: hero = orient + start, never a dashboard

**Decision.** The empty session keeps the existing three-zone structure from
`SessionHero` (UX-MOBILE-01 §2): header, one calm centered block, one sticky
interaction zone (context bar + composer). It is already slot-driven
(`session.empty.widgets` with `builtin.hero-starters` at order 10 and
`builtin.hero-recent` at order 20, user-configurable via
`HeroWidgetSettings`). Wave 2 makes exactly three changes:

1. **Recent rows carry state.** `RecentSessions` shows title + `ago()` only.
   Add the existing sidebar status taxonomy (working/approval-needed/
   reply-needed/unread — the `session-status-indicator` logic in
   `SessionList.tsx`) as a leading glyph per row. Continuity starts on the
   hero: "you have a session waiting for approval" must be visible where the
   user lands (see D9). No new data — it is all on `SessionProjection`.
2. **Context is explicit on every form factor.** Phone already shows
   project + branch/worktree via `SessionContextBar` above the composer.
   Desktop shows project in the hero headline ("What are we working on in
   *name*?") but branch context only in the header. Keep as is — do **not**
   add model/agent chips to the hero body; the composer's config rail already
   owns model/agent/effort selection (Phase 2 W3B), and duplicating it above
   the fold is the overload this decision exists to prevent.
3. **Starter chip counts stay bounded** (2 phone / 3 desktop + the "+" chip).
   The starter picker is the browse surface; the hero is not.

Explicitly rejected: a "project dashboard" hero (metrics, git graphs, PR
lists), auto-generated project summaries (no backend without a model call —
violates "don't invent AI features"), and re-opening the persona question.
The new-session intent shelf (`NewSessionIntent` + per-project draft
persistence in `store.ts`) is kept exactly as designed — an empty chat is
deliberately not a session until first Send.

### D7 — Session continuity: projection truth, surfaced consistently

**Decision.** When a user returns after hours/days, the product answers four
questions — where am I, what did the agent do, is it done, is it waiting —
from state that already exists, surfaced in a consistent order. No new
AI-summary feature is designed (the F9 `recap` package already exists,
is disabled by default, freshness-checked, and stays the only passive summarization
mechanism; Phase 3 does not add another one).

The continuity contract, per surface:

- **Boot** restores the last session (`polyth.activeSessionId` /
  URL deep link in `restoreSelectionAfterReady`) directly into its chat —
  already implemented; this is the "return" entry.
- **Timeline** already lands on the newest window (suffix windowing, "Show
  earlier"), so the last meaningful result is on screen; pending
  `QuestionCards`/permission banners already render above the composer, so
  "is it waiting" is answered in place. Keep.
- **Sidebar + hero recents + bottom-nav** show one shared status taxonomy
  (D6.1). The taxonomy is: `working (elapsed)`, `approval required`,
  `reply needed`, `unread activity`, `failed`, `idle` — exactly the states
  `SessionList.tsx` renders today plus `failed` promoted from projection
  status. Wave 2's only job is reusing that renderer in the hero and keeping
  labels identical everywhere (extract the row-status resolver into a shared
  module rather than copying it).
- **One gap to close (small):** after restoring into a long-idle session,
  nothing marks "what changed since you last looked". The `unread` indicator
  exists at row level; Wave 2 adds a quiet inline "New since you left"
  divider in the timeline at the first event newer than the session's
  last-viewed watermark **only if** a per-session watermark already exists in
  browser-local state; if it does not (it is currently derived, not stored),
  ship without the divider and keep the row-level unread badge as the whole
  mechanism. Do not add server state for this.

### D8 — Session management: complete the existing verb set, add nothing

**Decision.** The verb set is already right and matches the architecture:
rename (inline, `api.renameSession`), fork (= duplicate/branch,
`session/forked` event, per-message fork exists), pin (projection-only org
store), archive/restore (events + read-only archived guard with atomic
"Restore and continue"), delete (guarded: running/pending sessions get a
stronger confirm; `deleteSession` in `init.ts`), labels + folders + bulk ops
(org routes), worktree-scoped sessions (`WorktreeSessionDialog`). Phase 3
adds **no** new verbs:

- **Move session across projects: rejected.** A session is bound to its
  project/worktree cwd, its runtime, and its Git scope
  (`packages/server/src/sessions.ts` validates worktree paths against the
  owning project). "Move" would be a lie about history. The honest affordance
  already exists: fork content into a new session in another project via
  "New session from selection" (`SelectionMenu`).
- **Pin/favorite: keep** — already useful and implemented (drag-reorder in the
  pinned section).
- **Destructive delete** stays exactly where it is: behind the row's `Menu`,
  with `confirmAlert`, with escalated copy when the agent is running, never a
  swipe gesture, never in the palette (D3). On phone the same menu renders as
  a sheet via the `Menu` primitive — one implementation.
- **Wave 2 consistency fix:** the palette's session rows (D3) and the
  notification centre rows must reuse these handlers, not re-implement them.

### D9 — Recovery UX: four states, one vocabulary, no error pages for recoverable states

**Decision.** Every connectivity/runtime failure maps to one of four product
states, each with a fixed presentation and action. Raw WebSocket/transport
errors never reach the user (already true: `friendlyError()` wraps all API
errors; `sync.ts` swallows socket errors into backoff reconnect).

| State | Signals (already in code) | Presentation | User action |
| --- | --- | --- | --- |
| **1. Transient reconnect** | `SyncStatus` `connecting`/`disconnected`; backoff 500ms→5s in `sync.ts` | Quiet: sidebar connection dot as today. NEW: a small shell pill ("Reconnecting…") appears only after >3s disconnected, in the header status area, with a Reconnect action (`reconnectSync()`). Auto-dismisses on `connected`. No modal, no toast. | None required; optional Reconnect |
| **2. Backend (OpenCode) restarting/unavailable** | REST 503 `unavailable` (pool respawns on next call); empty model catalog with retry (`scheduleModelRetry`, `recheckRuntimeCatalog` on WS reopen); `settings.openCodeReconnecting` copy exists | In place: the composer shows its existing "No models available" disabled state with honest copy + retry; a failed send surfaces the 503 as a retryable inline notice above the composer, draft preserved (drafts already persist per session). Never a full-page error. | Retry send; wait |
| **3. Server unreachable** | fetch failures on `/api/*` + WS `disconnected` persisting | The only full-page-ish state: project-registry `failed` already renders "Couldn't load projects" + Retry when nothing is loaded (UX-ONBOARDING). With data already on screen, degrade to state 1's pill + per-action errors — known data is never rolled back (registry invariant). | Retry |
| **4. User action required** | 401 → `polyth:auth-required` → `LockScreen`; pending OpenCode config → `OpenCodeRestartControl` "Apply & restart" with count + `RestartOverlay` | Already correct; keep. The restart control stays in `settings.footer`; the lock screen stays a full takeover. | Log in / Apply & restart |

Interruption semantics (agent/generation/tool interrupted) are **event-log
truths**, not connection states: `turn/stopped {reason:"aborted"}`,
`tool/error`, `turn/failed` already render as timeline rows, aborted turns
are deliberately notification-silent, and the composer returns to ready.
Keep; the only Wave 2 addition is that a `turn/failed` tail on an idle
session shows a one-line retry affordance near the composer ("Last turn
failed — Retry" re-sends the last user message text as a fresh draft, never
auto-sends).

Also keep: terminals survive socket drops by design (replay ring +
reattach), the WS client resubscribes with `afterSeq` so gap-fill is
automatic, and `openSession`'s cached-view path renders canonical history
immediately while revalidating. These are the reasons state 1 can afford to
be quiet.

### D10 — Notifications: NTF-01 is the architecture; Phase 3 only tunes policy

**Decision.** The notification stack is complete for Phase 3's needs:
server-owned inbox (five kinds, 200-row FIFO, monotonic `ts`), unfiltered
`notification/added` WS fan-out + REST catch-up, bell + rail panel via slots,
web push with request-bound actions, per-kind native-delivery preferences,
service worker showing notifications only when no visible window exists,
aborted turns and auto-accepted permissions silent by design. Do not extend
the pipeline; OC-20-004 (configurable templates) stays `planned` and is not
claimed.

Policy decisions Phase 3 does make:

1. **Attention routing.** `question`/`permission` are the two kinds that block
   the agent; they get the loudest treatment everywhere: they are the two
   states that render as row badges (D7), they are the kinds push exposes
   quick actions for (already), and the notification-centre panel keeps them
   enabled-first (already — rows are newest-first; keep, do not invent a
   priority sort).
2. **No-spam rules (mostly already enforced, now stated as product policy):**
   at most one row per transition (spec invariant 3); nothing fires for the
   session you are actively viewing with a visible window (worker behavior;
   the in-page notifier's kind filter covers the tab-visible case); subagent
   completions attribute to the parent (already). Wave 2 adds nothing here
   except tests that pin the policy.
3. **Mobile:** the bell is already placeable in the phone shortcut rail
   (`mobileShortcuts` handles `notification-centre` explicitly in
   `MobileNavigationRail.tsx`); make it a default member of
   `mobileShortcuts` so a phone user has the inbox one tap away. The panel
   already renders as a rail sheet in compact mode.
4. **Shortcut:** `notificationCentre` hotkey action (D2).

### D11 — Mobile entry: resume-first, never a drawer

**Decision.** On phone launch the app opens **the last active conversation**;
with none, the active project's new-session hero; with no project, the
UX-ONBOARDING first-run flow. The sidebar/drawer never opens automatically.

Justification from the codebase, not preference: boot restoration already
implements exactly this (`restoreSelectionAfterReady` → saved
`polyth.activeSessionId` or URL deep link → `openSession(..., {showChat:false})`;
otherwise the hero via `NewSessionIntent`), push deep links land in a session
(`installPushDeepLinks`), and the phone shell is built around a persistent
bottom bar whose center control is "Projects & sessions" (`WorkspaceBottomNav`)
— i.e., navigation is one deliberate tap away, and Polyth's primary mobile
job (checking on / steering long-running agent work, approving permissions)
starts in a conversation, not in a list. A "recent sessions home screen"
would duplicate the hero's recents widget and add a navigation level.

Wave 2 additions that make resume-first safe:

- If the restored session is `archived`, keep it (read-only guard already
  handles it) — do not silently redirect.
- If restore fails (deleted session), fall through to the hero with the
  existing recoverable error (`init.sessionLinkCouldNotOpen`) — already
  implemented; add a test at phone width.
- The bottom bar's search button becomes the phone command/search surface
  entry (D12).

### D12 — Mobile action surface: the palette as a full-screen sheet, sessions-first

**Decision.** Phones never get the desktop palette popup. The same
`CommandPalette` component, re-based on `ResponsiveOverlay` (D3), renders on
phone as a full-screen `Sheet` (`size="tall"`) with: sticky search input
(never autofocused — Sheet §25 rule), sessions/projects section first,
commands second, files third; 48px rows; the existing group headers become
sheet sections. Entry points: the bottom bar's left (search) button replaces
its current target (`setOverlay("search")`) with the unified surface, and
deep session-content search remains reachable as a labeled row pinned at the
bottom of the session section ("Search inside conversations…" → opens
`SessionSearch`, which is already phone-aware). One component, one registry,
two presentations — no forked mobile command list.

Keyboard on phone: hardware-keyboard users (iPad, Android + keyboard) get the
same `Mod+K` path because `shell.ts`'s window keydown listener is
form-factor-agnostic; nothing to build, just don't break it.

### D13 — Tablet band (481–820px): compact **desktop**, one navigation hierarchy

**Decision** (resolves phase-3 candidate "Tablet shell interaction model").
The compact band behaves as a **compact desktop**, not a large phone:

- Keep: drawer navigation (`DrawerTrigger` + sidebar as modal drawer),
  compact header, `MobileNavigationRail` as the capability strip.
- Change: `WorkspaceBottomNav` becomes **phone-only** (`useShellMode() ===
  "phone"`), removing the duplicated session-switch destination the candidate
  doc calls out (today compact mode renders both the drawer *and* the phone
  bottom bar — `Header.tsx` renders `<WorkspaceBottomNav />` in both the
  phone branch and the compact branch).
- Overlays follow pointer, not width: `ResponsiveOverlay`'s existing seam
  keeps sheets for coarse pointers and popovers/dialogs for fine pointers.
  No new breakpoint is introduced; `responsiveShell.ts` stays the single
  classifier.

Rationale: the compact band is dominated by narrow desktop windows and
tablets-with-keyboards (the desktop app can be resized into it); phone
affordances there cost vertical space and duplicate destinations. Orientation
change on a tablet then only toggles wide↔compact, which changes sidebar
docking — nothing else.

### D14 — Canvas on phones: explicitly desktop/tablet-only in Phase 3

**Decision** (resolves phase-3 candidate "Canvas access on phones"). Canvas
(`workspaceMode === "widgets"`, `WidgetCanvas`) is not part of the phone
product in Phase 3. The phone header already omits the Chat/Canvas switch;
make the gap explicit instead of silent: Settings → Widgets & Layout gets one
sentence ("Canvas is available on tablet and desktop layouts"), and a
phone-width visit to a Canvas-configured workspace stays in chat mode
(current behavior — `setWorkspaceMode("chat")` guards already force chat for
pane commands). Widgets that matter on phones already have non-Canvas homes
(hero widgets, rail surfaces, header mini-widgets). Revisit only if Wave 4
device testing shows real demand; a phone Canvas interaction model is not
worth its complexity now.

### D15 — Native viewport/back policy (enough for Wave 4)

**Decision** (resolves phase-3 candidate "Native viewport and back behavior"
to the level Waves 2–4 need):

- **Android hardware Back order:** topmost modal surface first (exactly the
  Escape order — `useModalSurface` already implements LIFO Escape layering
  with menus closing before parent surfaces), then open workspace pane
  (`closeWorkspacePane()`), then open rail surface, then session → hero
  (`startNewSession` shelf is *not* pushed — Back from hero backgrounds the
  app; never trap). Wave 4 implements this as one Capacitor `backButton`
  handler that synthesizes the same code paths Escape uses; Wave 2 must keep
  the Escape path centralized (`setOverlay(null)` + per-surface handlers) so
  that handler has one seam.
- **In-app history:** the URL already tracks project/session
  (`startUrlSync`, pushState on user switches) — hardware Back after the
  overlay/pane chain follows browser history, which gives session-to-session
  Back for free. Keep pushState semantics unchanged.
- **Viewport/zoom:** keep the current `maximum-scale=1` shell lockout until
  on-device testing (matrix row "Pinch-zoom lockout" already defers this
  deliberately); text scaling remains covered by `--ui-font-size` +
  `--font-input` 16px floor. Keyboard insets stay on the existing
  `--visual-vh`/`--keyboard-inset`/`--safe-*` contract published by
  `mobileViewport.ts` — Wave 4 maps native inset APIs onto the same custom
  properties rather than introducing parallel plumbing.

### D16 — Remaining phase-3 candidates: disposition

| Candidate | Disposition |
| --- | --- |
| Context-window pressure indicator | **Wave 2, small**: the gauge data already exists (`contextGauge` in `reduce.ts`, rendered in the Context rail surface via `railSurfaces.tsx`; an unmounted `ContextRing` component still sits in `Header.tsx`). Decision: mount the ring in the wide header **only at ≥60% usage** (quiet) with amber/red per its existing `level`, delete it below the threshold; on phone, surface the same numbers inside the model sheet, not the chat chrome. No new thresholds engine. |
| Streaming reasoning reader intent | **Wave 2, small**: apply the conversation-level scroll-hold pattern to expanded reasoning wells; live reasoning stays expanded-by-default as today. |
| Dense label management on phones | **Wave 2, optional**: keep the ≤6-label inline checkboxes; above that, one "Labels…" row opens a searchable multi-select sheet (apply-immediately, matching current checkbox semantics). |
| Browser secondary tools on phones | **Wave 3** (feature-depth wave owns Browser). |
| Synced model favorites | **Deferred** — needs a preference-ownership contract; browser-local favorites stand. |
| Recent attachments | **Deferred** — privacy/retention policy first. |
| Package marketplace discovery | **Deferred** — catalog hasn't outgrown the grid. |
| Additional math delimiters | **Deferred** — parser work, not product UX; unchanged priority. |
| Pinned worktree metadata priority | **Wave 2, trivial**: session state wins over branch identity in narrow rows; full branch on hover/row menu. |
| Permission preview coverage | **Wave 3** — server-side preview builders; product rule stands (readable intent, fail-closed fallback). |
| Effort pricing preview | **Deferred** — provider metadata too inconsistent for honest guidance. |

### D17 — Multirun and Fusion in the global fabric (Wave 1 scope only)

**Decision.** Wave 1 fixes only how these fit the global surfaces; Wave 3
goes deep. They already fit correctly: both are capabilities (searchable in
the palette via `syncCapabilityCommands`, with legacy search terms "Compare
models"/"Fuse models" preserved), both are `AppView` primary destinations,
and both write their lifecycle into the session event log
(`multirun/started|run-progress|completed|picked`,
`fusion/started|completed`), which means continuity (D7) and notifications
(D10 — completion notifies through the same turn machinery) come for free.
Wave 2 must not special-case them anywhere; the one requirement recorded for
Wave 3 is that a running multirun/fusion surfaces in the session status
taxonomy as `working` like any other turn (verify, don't assume).

### D18 — Platform-adaptive, single codebase

**Decision.** Every decision above is expressed as *one component, adaptive
presentation* (`ResponsiveOverlay`, `useShellMode`, container queries) —
never `if (platform)` forks. Wave 4's Capacitor shells and the Electron shell
consume the same canonical UI; desktop-only affordances (tray, updates,
low-resource mode) stay behind `desktopBridge()` as today, and phone-only
affordances stay behind `useShellMode() === "phone"`. This is the constraint
that makes Wave 4 a packaging exercise instead of a fork.

---

## 2. User flows (normative)

**F1 — Start work in the morning (desktop).** Launch → boot restores last
session into chat (D11 applies on all form factors) → timeline shows newest
window; if the agent finished overnight, the last result is on screen; if
waiting, the question/permission card is above the composer → user acts or
hits `Mod+N` for a new session → hero with context-ranked starters → type or
tap a starter → Send creates the session (first event-appending act).

**F2 — "Where was that conversation about X?"** `Mod+Shift+F` → type → local
title matches render instantly, server snippets (branch/labels/message text)
stream in → Enter opens the session at its newest window. If the user
actually wanted a *file*: `Mod+P` instead. If they wanted an *action*:
`Mod+K`. Three keys, one mental rule: K = do, P = file, Shift+F = find in
conversations.

**F3 — Approve from the couch (phone).** Push notification "waiting for
approval" → tap → existing tab or new window deep-links via
`/?session=<id>` → session opens with the permission banner above the
composer → Allow once/Always with scope → done. If the user opens the app
instead: bell badge in the shortcut rail → notification centre sheet → row
tap opens the session (dead sessions stay visible but disabled).

**F4 — Wi-Fi drops mid-generation.** Streaming stalls → WS backoff reconnect
(quiet ≤3s) → pill "Reconnecting…" appears in the shell if longer → on
reconnect, `afterSeq` gap-fill replays missed events, dedupe prevents
double-apply, notification catch-up runs (`onOpen`) → pill disappears.
No user action, no data loss, no error page.

**F5 — OpenCode dies.** Next send returns 503 `unavailable` → inline
retryable notice above the composer, draft intact → pool respawns the
runtime on the retry → send succeeds. Meanwhile the model catalog, if it
emptied, heals via `recheckRuntimeCatalog` on the next WS open or backoff
tick.

**F6 — New phone user, empty server.** UX-ONBOARDING flow exactly as
specified (loading → one intentional picker → activation → hero). Phase 3
changes nothing in this flow.

**F7 — Tablet, keyboard attached.** Compact desktop shell (D13): drawer for
navigation, `Mod+K` palette as a dialog (fine pointer), sheets only for
coarse-pointer interactions.

---

## 3. Interaction patterns (cross-cutting rules)

1. **One surface per job.** Palette = act/jump; SessionSearch = find content;
   StarterPicker = browse/manage starters; NotificationCentre = catch up;
   Sidebar = organize. A feature needing "search" or "actions" plugs into
   these (capability descriptor, `commandPalette.commands` slot,
   notification kind) instead of minting a surface.
2. **Overlays degrade by pointer/shell mode through `ResponsiveOverlay` only.**
   Any remaining hand-rolled dialog that Phase 3 touches (palette is the big
   one) migrates during the touch.
3. **Destructive actions:** menu → confirm dialog → escalated copy when work
   is running. Never in the palette, never a swipe, never a bare icon tap.
4. **Nothing auto-sends.** Starters, notification quick actions
   (allow/deny/answer are *replies*, not prompts), assist suggestions, and
   fork/rewind seeds all end in an editable draft or an explicit reply API.
5. **Status vocabulary is single-sourced** (D7 taxonomy) and rendered with
   glyph + text, never color alone.
6. **Availability is runtime truth** (`when()`/`available()`), never persona
   or preset filtering (`capabilities.test.ts` pins this).
7. **Focus is deterministic**: every overlay close restores its invoker
   (`useModalSurface`), pane close restores via `restorePaneFocus`, and new
   surfaces added in Wave 2 must state their focus target in the PR
   description (pattern from UX-ONBOARDING's "no `BODY`" rule).

---

## 4. Command architecture (summary for implementers)

```
                 ┌────────────────────────────────────────────┐
                 │       apps/web/src/commands.ts (KEEP)      │
                 │  Map<id, PaletteCommand> + filter/run      │
                 └────────────▲──────────▲──────────▲─────────┘
        core shell commands   │          │          │  slot bridge (NEW, Wave 2)
        (shell.ts, KEEP) ─────┘          │          │  commandPalette.commands →
                                         │          │  registerCommand adapter
        capability sync (KEEP) ──────────┘          │  (EXTENSION-SEAMS §174)
        capabilities.ts descriptors                 │
        (packages register via web entry            │  packages/plugins register
         or window.__polythCapabilities)            │  via window.__polythSlots
```

- **Surfaces:** desktop/tablet = `CommandPalette` in a `ResponsiveOverlay`
  dialog; phone = same component as full-screen sheet, sessions-first (D12).
- **Shortcuts:** `packages/hotkeys` keymap only; `Mod+K`/`Mod+P`/`Mod+Shift+F`
  unchanged; one new action `notificationCentre`; union stays closed.
- **Search fields:** label, id, group, keywords, resolved hint (existing
  `filterPalette`); no fuzzy-ranking rewrite in Wave 2.
- **Isolation rules:** feature packages never import `commands.ts` directly
  from package code — they contribute via capability descriptors or the slot
  bridge; `shell.ts` loses its deep relative imports into
  `packages/*/widgets`.

---

## 5. What to keep / evolve / replace

| Existing code | Verdict | Note |
| --- | --- | --- |
| `commands.ts` registry | **Keep** | Add optional `icon`; nothing else |
| `shell.ts` | **Evolve** | Loses package deep-imports (voice, hotkey rows move to owning packages via slot bridge); keeps core commands, capability sync, keydown routing |
| `CommandPalette.tsx` | **Evolve** | `ResponsiveOverlay` re-base, session verbs, phone ordering; single component stays |
| `capabilities.ts` / `builtinCapabilities.ts` | **Keep** | Already the extensible navigation/command source |
| `packages/hotkeys` | **Keep** | Add `notificationCentre` action; union stays closed |
| `starters.ts` | **Keep** | Pass real session context when opened mid-session |
| `StarterPicker.tsx` | **Evolve** | Content unchanged; shell becomes `ResponsiveOverlay`; palette entry point |
| `SessionHero` + `session.empty.widgets` | **Evolve** | Status glyphs on recents; bounds unchanged |
| `SessionSearch.tsx` | **Evolve** | All-projects toggle, state tokens, overlay re-base |
| `SessionSearch` as separate surface | **Keep** | Deliberate palette/content-search boundary (D4) |
| `NotificationCentre` (all of NTF-01) | **Keep** | Default mobile shortcut + hotkey; policy tests |
| `sync.ts` reconnect machinery | **Keep** | Add >3s shell pill on top; no protocol change |
| `EmptyState`, `Sheet`, `ResponsiveOverlay`, `Menu`, `Dialog` | **Keep** | The only overlay/empty primitives allowed |
| `WorkspaceBottomNav` in compact band | **Replace (placement)** | Phone-only from Wave 2 (D13); component itself unchanged |
| Palette's hand-rolled dialog chrome | **Replace** | Last major bespoke dialog among Phase 3 surfaces |
| `SessionList` row-status logic | **Evolve** | Extract shared status resolver for hero/palette/centre reuse |
| Persona/onboarding flow | **Keep** | Out of scope; UX-ONBOARDING spec governs |

---

## 6. Implementation priorities for Wave 2

Implement in this order (each step ships independently; details in the
handoff doc):

1. **Command slot bridge + `shell.ts` cleanup** (D1) — unblocks package
   isolation; pure client work with existing tests to extend
   (`packages/commands/test/web-commands.test.ts`, `slots.test.ts`).
2. **Palette re-base on `ResponsiveOverlay` + phone sheet presentation +
   result ordering** (D3, D12) — the biggest UX visible change; includes
   bottom-nav entry rewiring.
3. **Shared session-status resolver + hero recents state + pinned-row
   priority** (D6, D7, D16).
4. **Recovery pill + inline send-retry states** (D9).
5. **SessionSearch evolutions** (D4).
6. **StarterPicker overlay re-base + palette entry** (D5).
7. **Compact-band bottom-nav removal** (D13) + context-gauge quieting (D16)
   + notification default shortcut/hotkey (D10, D2).
8. **Palette session verbs** (D3) — last, because it depends on 1–3.

Explicitly *not* Wave 2: anything under Multirun/Fusion/Browser depth
(Wave 3), any Capacitor/native work (Wave 4), any server/backend change
except none-required (this whole wave is client-side; the only server-adjacent
work is reusing existing routes).

---

## 7. Non-goals (Phase 3, all waves)

- No second command palette, starters system, notification pipeline, search
  backend, or slot/capability registry.
- No AI-generated session summaries beyond the existing disabled-by-default F9
  `recap` package; no additional model calls for UX chrome.
- No App Store / Play Store distribution work, push-relay backend, React
  Native/Flutter, or on-device OpenCode for iOS/Android.
- No account system, cross-device preference sync, or multi-user inboxes.
- No changes to the event-log contract, `deriveMessages`, delivery admission,
  or the OpenCode boundary.
- No re-litigation of Phase 1/2 visual decisions, UX-ONBOARDING, UX-PANE-MODEL,
  or UX-PERSONAS.
- No parity-status inflation: rows `planned`/`implementing` in
  `docs/parity/polyth-parity.yaml` remain so until their own implementation
  passes.
