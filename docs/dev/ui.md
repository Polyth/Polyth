# Polyth UI extension architecture

Authoritative guide for **where web UI code belongs and how it gets into the
running app**. Read this before adding or changing any feature web UI; read
`components.md` before creating or modifying a component, `widgets.md` before
adding a widget, and `styles.md` before touching CSS.

The rule in one sentence: **the host (`apps/web`) owns the shell and the
shared primitives; feature UI lives in its package and registers through
`@polyth/web-sdk`.** If you are about to edit `apps/web` to expose a feature,
you are almost certainly on the wrong path — re-read this document.

## 1. Core host vs package UI

`apps/web` owns:

- the application shell (`App.tsx`, `Main.tsx`, `Sidebar`, `Header`,
  `ContextRail`, `Timeline`, `Composer`, dialogs/overlays);
- the extension registries (`slots.ts`, `widgets/catalog.ts`, `surfaces.ts`,
  `capabilities.ts`, `settings/registry.ts`,
  `packages/reducers.ts`, `packages/projectContext.ts`) and their hosts (`components/slots/SlotHost.ts`,
  `components/workspace/WorkspaceHost.ts`, `components/ContextRail.tsx`,
  `widgets/WidgetCanvas.tsx`);
- shared UI primitives (`components/ui/*`, `components/a11y/*`,
  `components/EmptyState.tsx`, `components/CopyButton.tsx`, …);
- canonical tokens and core CSS (`tokens.css`, `theme.ts`, `styles.css`);
- host-level behavior (navigation, routing, sync, mobile shell, auth).

Feature packages own:

- their feature UI components and views (`packages/<feature>/widgets/`);
- their package CSS (`packages/<feature>/widgets/styles.css`). That
  stylesheet is attached only while the package is active. A package component
  the shell imports directly (e.g. `@polyth/models/model-picker`) must import its
  own stylesheet from the component module so it ships in the shell's
  `main.css`; name it `*styles.css` so the UI font-scale transform applies;
- their registrations (settings pages, surfaces, widgets, capabilities, slot
  contributions) — declared in `packages/<feature>/widgets/index.tsx`.

`@polyth/web-sdk` is **the supported feature/package UI integration seam**.
It is a bounded host handle: feature packages receive a `WebPackageHost` and
never import the host's internal registries to register themselves. The
`WebPackageHost` type and every registration shape are defined in
`packages/web-sdk/src/index.ts` — that file is the public API contract for
package UI, and the host implementation that backs it is
`apps/web/src/packages/webHost.ts`.

Feature packages **must not** patch host internals to expose their UI: no
edits to `App.tsx`, `Main.tsx`, host registries, or the host's built-in
contribution files. A feature's UI is "integrated" only when it is registered
through the web-sdk seam (see §3).

## 2. How a package's UI reaches the running app

1. The package declares `"polyth": { "webEntry": "./widgets/index.tsx" }` in
   its `package.json` (enforced by `apps/web/test/packageContainment.test.ts`).
2. The build (`npm run build`, `apps/web/buildPackages.ts` +
   `apps/web/webPackages.ts`) bundles that entry into
   `packages/<id>/dist/web/entry.js` (+ CSS) and the shell publishes
   `/packages-manifest.json` listing every package entry.
3. At boot, `apps/web/src/packages/webEntries.ts` loads `/packages-manifest.json`
   as catalog metadata only. `apps/web/src/packages/registry.ts`
   (`bootPackages()`) then fetches `/api/packages` and **activates only enabled
   packages**: attach CSS, import the module, create an activation scope, invoke
   the factory and installer. Disabled packages are not imported, styled, or
   executed. Disable disposes the activation scope, package cleanup, and that
   activation's styles.
4. The installer runs its registrations and **must return a dispose function**;
   registry.ts calls it when the package is disabled or unloaded.
5. A failed catalog boot or package activation is not final. A page can load
   while the server rewrites its web build, or over a flaky phone link, and a
   missing package (the approval card, for one) would otherwise stay absent
   until a manual reload while server-side status keeps reporting the wait.
   registry.ts retries failed work with backoff (1 s, 3 s, 10 s, 30 s, then
   every 60 s), and at once on `visibilitychange` to visible, `pageshow` and
   `online`; a hidden page waits for the foreground. A retried entry is
   imported as `entry.js?retry=<generation>` because the browser memoises a
   failed module URL.

Each package web entry is a separate esbuild bundle. Imports of the
documented generic shell modules (see §10) are externalized to the shell
bundle, so package code shares the shell's stateful stores, registries, and
helpers instead of cloning them.

### Frontend build freshness

Every completed web build writes `/build-id.json` and compiles the same build
id into the shell. `apps/web/src/buildFreshness.ts` checks that id only after
a real hidden/pagehide → visible/pageshow resume; cold boot and ordinary focus
changes never trigger a freshness reload. A stale standalone PWA navigates once
toward the current build generation so iOS cannot keep using a frozen
pre-rebuild shell with freshly rebuilt package assets. The check uses
`cache: "no-store"`; the service worker does not own application asset
caching.

Reloading is not enough on its own. esbuild emits `/main.js`, `/main.css`,
the importmap-ed `/shared/react*.js`, the `/shell-api/*` modules and package
`/packages/<id>/entry.{js,css}` without a content hash. Only `index.html` is
guaranteed to be revalidated by an intermediary: a reverse proxy that rewrites
asset `expires` (an openresty front end in one deployment sent a
fixed-time-of-day `expires`, observed as `max-age` ≈8–15h, on every
`.js`/`.css`, overriding the server's `no-store`/`no-cache`) pins the previous stylesheet and bundle, so a reloaded
shell boots old CSS while live API data looks current. A stale `/shell-api/*`
module is worse: it links packages to the previous build's chunk, so packages
read a second, empty store beside the shell's (no projects, no active project).
`versionUnhashedShellUrls` in `apps/web/buildConfig.ts` therefore appends
`?b=<build id>` to the shell URLs and adds every `/shell-api/*` and package
entry module to the import map with the same query when `build.ts` emits
`dist/index.html`; `packages-manifest.json` carries versioned package
stylesheets. Content-hashed chunks remain immutable within a build. Shell and shared chunk
paths also include a digest of the build id, because the public OpenResty proxy
has returned persistent 504 responses for otherwise unchanged chunk URLs;
a new release must not reuse those failed cache keys. The proxy owner should
purge the affected keys and prevent 5xx responses from being cached. Covered by
`apps/web/test/buildFreshness.test.ts`.

A rebuild replaces `dist`, so the previous `chunks/g-<digest>/` generation is
gone. Eagerly loaded assets survive in the immutable HTTP cache, but a tab that
was never suspended keeps running the old shell and 404s the first time it
lazily imports a chunk it had not fetched before (the model-details panel is
the common one). `recoverFromChunkLoadFailure` in
`apps/web/src/buildFreshness.ts`, called from
`ViewErrorBoundary.componentDidCatch`, recognizes the engine's dynamic-import
failure message, fetches `/build-id.json`, and navigates once to the server's
current generation; the same "already targeting this build" guard that bounds
the resume watcher prevents a reload loop. A chunk failure under the current
build is a genuine error and still renders the boundary.

The generated shell preloads the importmap-ed React modules and the static
imports needed by `main.js`. The bootstrap graph loads when `main.js` enters
the app; preloading its entire closure created a burst of roughly 100 asset
requests before the first render.

The watcher is explicitly controllable. Runtime code may call
`setBuildFreshnessEnabled(false)` / `setBuildFreshnessEnabled(true)`; turning
it off immediately cancels pending retries and suppresses any in-flight reload.
For deployments that never want automatic freshness navigation, build with
`POLYTH_WEB_BUILD_FRESHNESS=0` (also accepts `false`, `off`, or
`disabled`). Production builds remain enabled by default. The development
supervisor defaults its rebuilds to freshness disabled because every watch
rebuild creates a new generation; set `POLYTH_WEB_BUILD_FRESHNESS=1` on the
supervisor process to opt back in.

### Package web entry skeleton (current API)

```tsx
// packages/<feature>/widgets/index.tsx
import "./styles.css";                       // bundled with the entry; applied only while the package is active
import { defineWebPackage } from "@polyth/web-sdk";
import MyView from "./MyView.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.settings.registerPage({ id: "myfeature",
      label: "My Feature", group: "Workspace", icon: "◈", order: 50,
      component: MyView }),
    host.capabilities.register({ id: "myfeature", label: "My feature",
      plainDescription: "One-line description for search.",
      keywords: ["my", "feature"], standardTier: "more", standardRank: 20,
      // Where the launcher starts per project kind; unlisted kinds: More.
      // `personal` (a person's Personal project) is opt-in and kept short:
      // only everyday tools a non-technical person needs ask for it.
      defaultRails: { engineering: "right" },
      open: () => host.navigation.openSettingsPage("myfeature"),
      available: () => true }),
    host.projectContext.register({
      id: "myfeature.context",
      getSnapshot: (projectId) => ({
        title: "My feature",
        items: [{ label: "Project", value: projectId }],
        recommendedWidgetIds: ["myfeature.board"],
      }),
    }),
  ];
  // Host-owned contributions are also tracked by the activation scope, so a
  // forgotten unregister still disappears on disable. Still return cleanup
  // for timers, subscriptions, and non-host resources.
  return () => off.toReversed().forEach((dispose) => dispose());
});
```

Note the shape: `defineWebPackage(entry)` where `entry(host)` returns an
**installer function** (the outer `() => { ... }`); the installer itself
returns the dispose function. Every `host.*.register*` call returns an
`Unregister`. Unregister order matters for dependencies (dispose
registrations in reverse order), and `combineUnregister` in
`apps/web/src/packages/settingsPage.ts` is the host's reference
implementation of the same pattern.

A package that owns durable display preferences registers one adapter per
stable preference id:

```ts
const off = host.preferences.register("acme.display", {
  read: getDisplayPrefs,
  write: replaceDisplayPrefs,
  subscribe,
});
```

The host owns the JSON mirror, account scoping, debounce, reconnect hydration,
and WS fan-out; the package owns parsing and its local subscription. Do not put
secrets, drafts, last-open windows/sessions, recent-item history, or project/Space
identifiers in this account-scoped registry. Those navigation choices stay on
the device; project data stays with its owning project.

## 3. Decision table: which mechanism

| Need | Correct mechanism |
|---|---|
| Package settings page | `host.settings.registerPage(...)` (web-sdk) |
| Searchable rows inside any settings page | `host.settings.registerItems(...)` or `settingsItems` on the page |
| Small UI at an existing injection point (message actions, header, composer, timeline…) | `host.slots.register({ slot: <existing UiSlot>, … })` |
| Package home/window (dynamic, pinned, or fullscreen) | `host.surfaces.register(...)` with required system presentation metadata |
| User-placeable dashboard block | widget — `host.widgets.register` / `host.widgets.registerPlugin(...)` (see `widgets.md`) |
| Discoverable "open this feature" navigation entry | `host.capabilities.register(...)` |
| Widget Library ranking / recommended widgets | `WidgetDefinition.recommended` plus `host.projectContext` `recommendedWidgetIds` for the active project (never identity, never a firewall) |
| Live per-project package context | `host.projectContext.register` — a sync snapshot of package-owned state; core aggregates, packages persist |
| Client-side handling of a package event type | `host.reducers.register(eventType, reducer)` |
| Interactive rendering of a fenced block in Markdown (chat answers, file preview) | `host.markdown.registerFence(...)` (§4.11) |
| Shared app-wide visual primitive (button, dialog, menu…) | host core UI (`apps/web/src/components/ui/` + `styles.css`) |
| Feature-specific reusable component | package-owned component in `packages/<feature>/widgets/` |
| New global extension seam (a slot that doesn't exist) | host/web-sdk change (§5) — not a per-feature decision |
| REST endpoint | feature `RouteHandler` via `polyth.serverEntry` (see `README.md`) |
| Model-visible durable state | session event (append before display) |
| Durable account UI preference | `host.preferences.register(...)` (or the core settings registry) + the server-backed client settings blob; localStorage is only the synchronous/offline cache |
| Project presentation preference | Widget layout, mobile Workspace panel layout, capability order, and whether the project offers Canvas are cached under the project key, mirrored through `/api/projects/:id/settings`, and broadcast over WS |
| Device navigation or recovery state | `localStorage`/sessionStorage only for active route/session/profile, Chat/Canvas mode, open windows/tabs, Files/Git/Terminal selections, drafts, recent-item history, auth/account recovery, scroll/pending interaction, the workspace Edit toggle, and per-device terminal touch input (pinch size, extra keys, bell vibration; [terminal.md](terminal.md#preferences)) |
| Shared server setting (other devices must see it) | server/package settings persistence + route |

When two mechanisms look plausible, prefer the one with the smallest blast
radius: slot contribution over surface, surface over workspace surface,
settings page over new overlay. A widget is for user-configurable content;
if the content is not user-placeable/duplicatable, it is not a widget.

### Composer draft contributions

The composer Add menu uses the shared anchored `Popover` for Quiet Glass,
viewport bounds and its single vertical scroll area. Its content fills the
measured width without another material or fixed-width scroll container. Every
outcome appears exactly once. Attach sources are one row of equal tiles —
**Camera** (touch devices only: `capture="environment"`, the platform capture
sheet in browsers and the native shell), **Photos** (`accept="image/*"`; native
`FilePicker.pickImages`, transcoded so iOS HEIC arrives as JPEG) and **Files** —
with one quiet note under them: the `_inbox` destination, or the shared reason
all three are unavailable. Below them the labelled rows (Add context: mention
and package contributions; Compose: commands, snippets, shell) retain
capability reasons and catalog states, and a hairline closes the list with
**More composer tools**. Labels and supporting copy wrap with the menu font
setting, and catalog details sit below labels so they cannot squeeze them off
the edge.

**Drafts.** Pressing and holding Send (500 ms, idle Send and the running-turn
delivery button alike) keeps the message as a draft instead of sending it. A
draft is an ordinary canonical session, never a separate list or menu. On a new
chat the hold creates the chat through the same path as Send (route, workspace
target, lane, auto-approve), moves the text and attachment pills into that
chat's scoped draft record, saves the draft to the server at once
(`saveDraftToServerNow`) and stays on the cleared new chat; no turn, echo or
spawn surface starts. In an open chat the text stays in the composer and is
saved at once. A ring draws around Send over the hold and Send shows a check
for a beat; there is no notification, because the result is visible in place.
A release before the hold completes sends: touch/pen Send is admitted on
`pointerup` (pointerdown is cancelled so the editor keeps focus; a finger slid
off Send does not send), and the click that ends a hold is swallowed. An empty
composer or a queued-message edit never starts a hold.

Both navigators and the new chat's recent list show drafts among all chats
with an accent **Draft** `Badge` (`apps/web/src/sessionDraft.ts`). A chat that
never ran a turn is named by the first line of its draft (navigator, title
bars, island, chat tabs, search) and stays marked while open; a chat with history shows
the mark only while it is not the open chat. Navigator summaries carry the
reader's own draft only as `draftPreview` (first line, at most
`SESSION_DRAFT_PREVIEW_MAX` characters); the draft text stays on the full
projection. Opening a draft chat puts the message back in the composer, and
sending it clears the draft and the mark. Admission itself also consumes the
author's matching draft on the server (`consumeAdmittedDraft` in
`packages/server/src/sessions.ts`): the client's clear is a debounced PATCH
that a reload, a killed tab or another device can lose, and a leftover draft
would keep a started chat marked **Draft** and restore its prompt. A draft the
person typed after the send, or another person's draft, is never touched.

Composer mini-widgets receive `context.composerDraft`, the browser-safe
`ComposerDraftContext` exported by `@polyth/web-sdk`. It carries project/session
identity, draft text and revision, conversation sequence, and busy state.
`read()` returns the current draft; `replace(text)` edits without sending.
`offerSuggestion({ sessionId, text, preferred? } | null)` puts a suggested next
prompt on the host's suggestion chip (the one harness hints use: click or Tab
fills the draft, × or Esc dismisses it); `harnessSuggestion` and
`harnessSuggests` tell the contributor whether the harness offers its own,
which wins unless the offer is `preferred` (a preferred offer with empty text
holds the chip while that source answers; `composerPromptSuggestion`). An
automatic source belongs on the headless `composer.suggestion` slot, which an
agent composer mounts for every session with the same `composerDraft` context
whatever the person placed on the rail; its contributions render nothing. A
composer that writes only to people (a conversation, a view-only reader)
neither mounts that slot nor shows the chip.
Async contributors must compare identity, revision, text, and sequence again
before replacing, withdraw offers that went stale, and discard responses after
unmount or package disable.
The host supplies this generic context; prompt inference, Undo and regeneration
belong to [Session Assist](../../packages/recap/README.md).

Packages add composer behaviour through `host.composer` (web-sdk; host side
`apps/web/src/composer/contributions.ts`), never by the composer importing
them: `registerAddMenuItem` adds one Add-menu row (after the mention row; `shortLabel`
is no longer drawn) whose `activate`
gets project/session ids, the draft, `openDialog(render)`, `insertText` and
`error`; `registerPasteHandler` sees pasted text before the default paste and
consumes it by returning true (GitHub URLs); `registerSessionCreatedHook` runs,
in registration order and awaited, after a send creates a new session (handoff
imports). Registrations are disposed with the package activation.

**Composer modes.** `registerMode(mode)` adds a `ComposerMode`: a package-owned
destination for the draft (By the way's side questions,
[packages/btw](../../packages/btw/README.md)). While a mode is on, the host
composer shows its chip (icon, label, × to leave) at the start of the input
area, tints the card with the accent wash and ring
(`apps/web/src/composer/composerModes.css`), and uses the mode's `placeholder`
and `submitLabel`; Enter and Send call `mode.submit(context, trimmedText)`
instead of the session. A mode submission is never queued, steered, parked as a
draft or blocked by a running turn and never creates a session; the draft
clears once `submit` resolves and stays (with a notice) when it throws, and the
mode stays on for a follow-up. A mode is entered by typing its `trigger`
followed by whitespace at the very start of the draft (the trigger is removed;
a restored draft never enters), by an Add-menu item calling
`context.setMode(id)`, or by `host.composer.setMode(id, { sessionId })`, which
asks that chat's mounted composer (`null` leaves). It is left by ×, Esc in an
empty draft, Backspace at the start of an empty draft, or a session change.
`isAvailable(context)` false keeps it off (and leaves it), and a composer that
writes only to people (a conversation, a view-only reader) offers no modes.
`host.composer.activeMode(sessionId)` reports the mode a chat's composer is in;
changes notify `composer.subscribe`. The pure decisions (trigger detection,
leave keys) live in `apps/web/src/composer/modes.ts`; the registry and the
request/active-mode bus in `apps/web/src/composer/contributions.ts`. On phones
an active mode keeps the composer engaged like shell mode, and Send keeps the
disc (the label stays its accessible name). While the agent works, a quiet Stop
button sits beside the mode's submit control, so a mode never hides Stop.

### Conversation prompt bookmark

The host-owned `Timeline` exposes an opt-in conversation prompt history
bookmark with one switch per side of the 1100px rail breakpoint (Settings →
Chat → Prompt navigation): `pinLatestPrompt` for phones and narrow windows (the
persisted field keeps its migration name) and `promptBookmarkDesktop` for wide
windows; both default off. The component mounts when either is on and carries
`data-narrow="off"`/`data-wide="off"` so CSS hides it on the disabled side. The
bookmark sits at the conversation's inline edge below the
phone menu and remains available while the latest prompt is visible. It opens
a compact shared `Popover` with the desktop navigator's material, type and rows,
safe-area/keyboard collision handling, outside dismissal and Escape support.
Both prompt-history panels use the menu text size. Opening focuses a prompt;
dismissal restores the bookmark, while a successful jump focuses its message.
The list is chronological, starts at the newest eight prompts, and has earlier
and later page controls. At most eight prompt rows are mounted.

Above 1100px the desktop prompt rail (`PromptNavigator`, tick "stripes") is the
prompt history unless `promptNavigator` is `off` (the Settings "Prompt rail"
switch writes `auto`/`off`; a stored `on` still forces it for short chats). An
enabled desktop bookmark shows alongside the rail; a narrow-only bookmark
instead mounts the rail from the first prompt. The rail hugs the
edge chosen by `promptNavigatorSide` (`right` default, or `left`; Settings →
Chat). Its offset is measured, not a constant: `promptRailInset`
(`apps/web/src/promptRail.ts`) adds a 4px gap to whatever `.railbar` or
`.sidebar` chrome is drawn over that edge of `.timeline-viewport` (full-height
launcher strip, the 961–1400px floating cluster, a slide-over pane), while
in-flow chrome beside the chat (expanded/collapsed navigator, pinned pane) costs
nothing. A ResizeObserver re-measures on every collapse/expand. A left rail also
reserves its gutter in the transcript's left padding.

The rail's hover panel and the bookmark peek share `.prompt-nav-row`: text two
pixels above `--font-meta`, clamped to two lines, with no leading mark (the tape
ticks carry the active and pointed-at state). Both
render previews through `promptRowLabel` (`apps/web/src/promptRail.ts`):
whitespace collapsed, leading heading/quote/list markers dropped and an
ordinary lowercase first word capitalized; commands, mentions, paths,
identifiers and camelCase keep their spelling. This is display-only — stored
prompts and the server's `preview` are unchanged. The client-side rail preview
skips code-fence lines and uses the same 128-character cap as the server.

Opening fetches `GET /api/prompt-history/navigation?sessionId=…&limit=40`.
The gateway validates session ownership in `rc.space`; the store reads only
`user/message` candidates and rewind markers. Responses contain newest-first
`{id, seq, preview}` entries (previews capped at 128 characters), plus an exclusive
`beforeSeq` cursor or `null` at history start. Attachment-only prompts are
included; hidden recovery/conflict prompts and rewound/replaced ranges are
excluded. Complete leading internal recovery blocks are stripped using the same
display helper as the transcript. Composer shell submissions remain in composer
recall history and are not conversation prompt rows.

Only reaching the oldest cached page fetches the next 40 previews. Component-local
caches include Space/session identity and are invalidated by new prompts or
rewind state; stale responses are ignored and requests are aborted on identity
change/unmount. Merely browsing the list does not hydrate assistant/tool output.
Selecting a cached prompt uses the existing window/jump path. A distant selection
backfills the contiguous canonical tail in bounded event pages, stopping at the
selected sequence, then reveals/focuses it. Keeping that tail contiguous preserves
replay and existing history-completeness checks. There is no fixed page-count cap;
changing sessions cancels further work. Failures keep the history panel available
with an error/retry state. Navigation is presentation-only and appends no events.

The core session navigator keeps its initial page size in the account-owned
product settings (`defaultVisibleSessionCount`, default `6`) and uses that value
for both desktop and phone presentations when no worktree-local expansion is
stored. A value above `20` is allowed, but changing it in the UI first shows a
warning about the possible navigation/rendering cost. `Show more` / `Show less`
are quiet local-presentation labels at the end of the applicable main or linked
worktree session group; they do not change the account default. The chosen
expansion is remembered per device: desktop stores a count per project, view
and worktree (`polyth.sidebar.visibleSessionCounts`) and keeps loading summary
pages after a reload until the primary checkout can fill it; the phone
navigator stores which projects show all their chats
(`polyth.sidebar.showAllProjects`). The phone navigator's separate remote
`Load more sessions` link continues the summary catalog and is offered only
while a session list is on screen (a project is open, or search is active), so
an all-collapsed project list never ends in a link that reads as loading more
projects. Which projects are open
(`polyth.sidebar.expandedProjects`, shared by both navigators), the project sort
chosen in the list options (`polyth.sidebar.projectSort`: recent activity, name
or custom) and the custom order (`polyth.sidebar.projectOrder`, every known
project id) are stored the same way. These keys are navigation presentation, so
they stay out of the synced account preferences. Each time the phone navigator
comes up (tap or swipe peek), and when the current chat changes while it is
up, the project that chat was created in is added to the open set and scrolled
into view: nothing moves when the project row and the chat's row are already
visible, otherwise the project row leads the list (pulled further when the
chat would sit below the fold). The placement is instant and repeats only for
1.5 s while session lists arrive; the user's touch, wheel or key in the list
ends it, and a fold made while the navigator is open stands until it next
opens (`mobileNavigatorRelaunch.test.ts`).

A browser keeps them in localStorage. The mobile app cannot: it serves the shell
from a Link loopback port that changes on every launch, so localStorage starts
empty. `apps/web/src/navigatorState.ts` owns these keys. Every write goes
to localStorage (the synchronous cache the navigators read at mount) and, once
the app-owned client-context store has been read, to that store as a
best-effort `writeClientPreference` record scoped to the connection and
account. `bootstrap.tsx` restores the records into localStorage before the app
first renders, waiting at most 1.5 s, and `sidebarPrefs.ts` re-reads the ones it
caches in memory. A page that did not read the store never writes it, so
defaults cannot replace saved state, and a navigator write never joins the
`flushClientPersistence` barrier that a send waits on. Anything that reads these
keys must go through `readNavigatorState` / `writeNavigatorState`; a bare
`localStorage` access is forgotten at the next launch of the app. The desktop
app keeps its loopback port across launches (`apps/desktop/src/serverPort.ts`,
[Desktop](desktop.md)), so plain origin storage is durable there as in a browser.

Projects are moved by direct manipulation, in both navigators, with the
`workspaceArrange.ts` engine the phone Workspace editor uses: a touch lifts a
project's row after a 340 ms press without moving (`ARRANGE_LIST_LIFT_MS`; a
finger that moves first scrolls, a tap still opens the project), a mouse after
4 px. The phone navigator and the wide tree lift a copy of the project's row;
the project's own place stays behind as a quiet well with its sessions folded,
and the list keeps its scroll room meanwhile, so the fold never slides the list
under the finger. The project rail lifts its tile. Neighbours glide aside, the
list auto-scrolls near its edges, Escape puts the project back, and a press on
a session row, a project action or the rename field never lifts the project.
While a project is up the lists take no hover, tooltip, peek, text selection,
system long-press menu, image drag, pull-to-refresh or drawer swipe. The order
is saved once, on landing, through `permuteManualProjects`, which keeps
projects a filter hides in their slots. Any sort allows a move: one made under
*Recent activity* or *Project name* keeps the order on screen and switches the
sort to *Custom order* (announced). Alt+Shift+↑/↓ on a project row moves it one
place the same way. Covered by `apps/web/test/projectArrange.test.ts`.

On touch-capable screens (`any-pointer: coarse`) project row actions stay
hidden at rest, except on the focused project: its new-chat and ⋮ actions stay
visible because touch tablets have no hover and iPadOS fires no `contextmenu`
on long-press, so it is their only route to the project menu (New
conversation, Project settings…, Repositories…, Memory). New chat is a row
action (and a toolbar or rail-header control); New conversation lives only in
the menu.

Archived sessions are not listed inline in the navigator. When a project has any
archived session (a loaded row, or one bounded `archived=true` summary probe), a
quiet `Archived` entry under its session list — and `Archived sessions` in the
phone project menu — opens the per-project archive view
(`ArchivedSessionsDialog`, overlay `archived-sessions`; dialog on desktop,
tall sheet on phones). It pages `/api/sessions/summaries?archived=true`
(server-side title/branch/path `query`) and merges archived transcript hits
from session search. Archive-date presets (today / past week / past month /
older) and the branch filter apply to loaded rows, using `updatedAt` as the
archive time, the same clock archive retention uses; paging continues on scroll
and stops early once a recency window is satisfied. Rows open read-only, and
restore (`bulkSessions("restore")`) or permanent delete work singly or on a
selection. Pure rules live in `apps/web/src/archivedSessions.ts`.

Session and project verbs are optimistic: delete, archive, restore (single and
bulk), rename, pin and labels for sessions, rename and close for projects, and
queued-message removal reflect the action before the server answers. Session
verbs go through `store.beginOptimisticSessionChange` (via
`withOptimisticSessionChange` in `init.ts`): while a request is in flight, list
pages and WS projections pass through the pending hide/patch, so a stale view
cannot resurrect or revert the row. A rejection restores the previous fields
(a deleted open chat reopens if the person has not navigated elsewhere) and the
caller shows the usual `setUiError` notice; requests are sent once and never
replayed. Guarded background deletes (`expectedLastEventSeq` /
`expectedUpdatedAt`, failed-startup cleanup) stay confirm-then-remove because
their precondition can legitimately fail. A user delete still runs the
composer's local draft flush before the chat closes. Security-sensitive actions
(credentials, device grants, permission replies) and model-visible history
facts are not optimistic.

The same rule covers package and settings surfaces that hold their own list
state: non-sensitive settings toggles and list removals (Behavior policies, MCP
servers, packages), task-tracker card archive/delete, column rename/remove and
status changes and task title/description edits, goal pause/resume/stop,
Coach goal edits/status/primary, scheduled-agent pause/resume, walkthrough
step decisions, review-loop pause/stop and inline-AI settings saves change
locally first and restore with an error notice on rejection; a refused edit
returns to its editor with the typed text. Adds whose id the server allocates
(tracker comments and columns, Coach goals and actions) show at once as a
pending row with no actions; a rejection keeps or returns the text so it is
one click from resending, never silently dropped. Creation that must allocate server
resources does not keep its modal open: *Work in isolation*
(`launchIsolatedSession` in `apps/web/src/isolatedSessionLaunch.ts`) closes
the dialog, shows the project's spawn surface and focuses the new chat only if
the person is still there; a failure returns to the previous chat and offers
to reopen the dialog unless the create outcome is unknown. A model-visible toggle may still show the requested
state as display-only intent until its canonical event lands (message
pin-to-context, `components/messagePin.ts`). Project appearance and
workspace-composition saves close their dialog at once through
`saveProjectAppearanceOptimistic` (icon inlining runs before the single PATCH).
Project defaults in Settings → Projects (harness, model, model memory,
isolation) go through `saveProjectDefaultsOptimistic`; `null` clears a default
in the preview exactly as on the server.
A person's own default harness (Settings → Harnesses → *My default*, Spaces
§13) outranks project defaults for chats they start: while it is usable and
nothing was chosen for the new chat (`newChatRouteChosen` in
`apps/web/src/personHarnessDefault.ts`: harness tab including Auto, model,
thinking, agent or profile), the composer shows that harness and the create
names no harness, model or agent, so the server pins it. An isolated create
runs without the person's context, so it names the harness instead. Any pick
keeps the old route; with no usable default nothing changes.
Fork, whose child id only exists after the server answers, takes a placeholder
`openingSessionId` claim so the chat enters its loading layer immediately, and
does not open the child if the person navigated meanwhile. The first-run
project setup flow stays blocking: its finalize step has an explicit retry and
recovery contract.

### Shared chats: who wrote a prompt

Conversation rows carry no role labels ("You", "Polyth") or avatars; the role
is the article name. In a chat several people share, a prompt **someone else**
wrote shows that person's name once, quiet (`--font-response-meta`, muted),
above its bubble (`.msg-person`), and its article label becomes "Message from
{name} sent at {date}". One's own prompts and agent responses stay unnamed.
The name comes from the message's server-recorded author
(`SessionPerson`, see [Spaces §14](../architecture/spaces-and-tenancy.md));
a missing name reads "Someone else". A message a judge sent for its owner
(`author.via: "judge"`) is always labeled "Sent by a judge" (after the person's
name when it is someone else's judge), and its article label ends with
". Sent by a judge"; the row carries `data-via`.

### Shared chats: who can open a chat

Sharing UI appears only when a projection carries `sharing` (the server's
per-reader view, §14.3); a legacy single-user install shows none of it. The
rules the shell applies live in `apps/web/src/sessionSharing.ts`; the server
stays the authority and refuses anything the UI should not have offered.

- **Share dialog** (`ShareSessionDialog.tsx`, the `session-sharing` overlay,
  dialog on desktop and sheet on phones): the audience — Only you, Specific
  people, Everyone in this Space, limited to `allowedVisibilities` — and the
  people list with one access select each (capped by `maxGrant`), an
  add-person select and Save/Cancel. Save sends the whole list with
  `expectedRevision`; a 409/403 reloads and says what changed. Without share
  rights it is a read-only "Who has access" view; a delegated subagent only
  explains that it follows its parent and opens the parent's dialog. A name
  wraps to a second line before it truncates.
- **Entry points**: "Share…" (or "Who has access" below manage) in the
  desktop row menu, the phone recent-row menu and the session overview lines
  (desktop status popover, phone overview sheet).
- **Navigator marker**: a quiet `SharedIcon` (Lucide `Users`) on a row only
  when `sharing.shared`; its label names the owner of someone else's chat,
  otherwise says whether the Space or specific people can open it. Private
  own chats carry no marker.
- **Header**: someone else's chat names its owner — the desktop caption
  ("Shared by {name}"), the phone title row after the status slot.
- **Access-shaped chrome**: rename, archive, delete, swipe actions and
  double-click rename need `manage`; below `collaborate` the composer is
  people-only (see "People in a chat").
- **Lost access**: the `session/removed` socket message removes the row; if
  that chat was open the shell leaves it and shows a transient notice.
- **Space policy**: Settings → Users → Sharing; Space admins edit it with
  autosave guarded by its revision, everyone else sees it read-only.

### People in a chat

Contract and server rules: [Spaces §14.8](../architecture/spaces-and-tenancy.md).

- **Person colours** (`personIdentity.ts`): each person has one of eight
  tones, `data-person-tone="0…7"` → `--person-tone`, derived from the
  theme's signal colours (red, orange, amber, green, teal, blue, purple,
  rose around the wheel). `assignPersonTones` takes everyone who can open the
  chat, the reader included, so every reader sees the same colours: no two
  people share a tone while tones are left, and up to four people use only
  the even tones (no near neighbours, and a person keeps their colour from
  chat to chat). A monogram on a tone (`.person-mark[data-person-tone]`) is
  filled with it, lettered in `--bg`. The same colour marks a person in the
  chat (name and monogram), the `@` list, mention chips, the conversation
  header ("With Ann, Max", each name in its colour — the chat's legend), the
  message card and the notification centre.
- **Mentions**: the composer `@` list shows a "People" group (who can open
  the chat: identity mark, full name, access) before files. Picking a person
  inserts `@FirstName`, or `@First_Last` when another person here shares the
  first name (`mentionTokenFor`); deleting the token drops the mention. A
  private chat lists nobody; when its `@` list is empty and the Space has
  other members (the sharing DTO's `people`), the owner sees one quiet line,
  "This chat is private…", with a "Share…" button that opens sharing.
- **People mode** (a collaborator mentions someone): the model/effort row
  steps aside and one quiet line above the editor holds a People | Agent
  segmented choice (radio semantics; People by default) and, with
  `collaborate`, a "Share with the agent" switch (off by default). The send
  action becomes a pill naming the recipient ("Send to {first name}",
  "Send to N people"); it posts a `person/message` and never queues behind or
  steers the agent.
- **People-only composers** (a conversation; a reader with only `view`): no
  model row, Add menu, shell, stop/queue or agent toggle. The rail passes
  `context.agentless = true`, and the host leaves out widgets that declare
  `agentOnly` (goal, approvals, workflows, recap, voice with the agent,
  conversation tools); dictation stays. Viewers get one quiet line, "You can
  view this chat · Ask {owner} if you need the agent". The placeholder says
  the agent will not see the message (a short "Message people…" on phones).
- **Timeline**: a person message is a chat bubble in the Messages manner
  (`--radius-bubble`), prose at the response caliber. The reader's own sit at
  the inline end on `--accent`/`--accent-ink`; everyone else's at the start
  on `--bubble-person-bg`. Consecutive messages from one author within five
  minutes form a run, 2px apart: the author's name opens its first bubble
  (inside it, semibold, in their colour), a 28px monogram in their colour
  and the bubble tail (a masked flare, so it matches the fill on any
  wallpaper) sit beside its last (reducer flags `continuation` /
  `continued`). A one-to-one conversation (one other person can open it and
  only they have written) shows no names or monograms; a group names its
  voices from the first message; agent chats always name. A
  centered time divider ("Today 3:19 PM", `chatDividerParts`) opens the first
  message, any message after 15 quiet minutes or on a new day (`timeBreak`;
  never right after agent work); the exact time sits beside each bubble and
  shows on hover/focus. One to three emoji alone render large without a
  bubble (`emojiOnlyCount`). A live arrival rises from its tail corner.
  A mention chip wears the mentioned person's colour (a lighter pill of the
  ink on one's own bubble); the reader's own mention is the one solid
  accent. A carried
  message says "The agent gets this with the next message", then "Shared
  with the agent" once a prompt has delivered it. It is not a prompt: no
  prompt recall, title, queue or activity grouping.
  `conversation/session-started` is a centered link row with the agent glyph
  that opens the new chat.
- **Navigator**: an `@` mark while `attention.mentions` is set; conversations
  use a people glyph in the status slot (also in the phone hero's recent
  list), no shared marker (a conversation is shared by nature), and list
  beside ordinary chats (`lanePurposeOf` treats `conversation` as the
  ordinary lane). An unread conversation shows its count as a filled accent
  pill (`.session-unread-count`, `conversationUnread`; "99+" past 99) and a
  bold title in both navigators and the phone hero list, whose time is the
  last message's. Rows update live: every message republishes the chat for
  each reader. Conversations have Mute/Unmute in the row menu.
- **New-message alerts** (`notify.ts` `alertPersonMessage`, routed by the pure
  `planPeopleAlert`): a live `mention`/`message` inbox row
  - for the chat the person is reading on screen: no alert; the row is
    marked read;
  - Polyth on screen, another chat: a **message card** in the notification
    stack (`notify/ConversationCard.tsx`, record field `conversation`), one
    per chat so a burst updates it in place and brings it forward. It reads
    like a messenger: the newest sender's monogram in their colour (a small
    accent `@` when the burst mentions the reader), then the sender's name
    over the chat's title — or, once several people wrote, the chat's title
    over "Mentioned you · N new messages" — then the newest three lines, each
    voice named in its colour ("+N earlier" above them). The head is one
    button that opens the chat. Under the text, a reply field ("Reply to
    Ann", "Message Release planning") posts an ordinary person message as
    the reader (idempotent `clientOperationId`) and marks the chat read; a
    started reply keeps the card (sticky) until it is sent or cleared,
    "Reply sent" shows briefly, a failure keeps the words. Escape clears a
    draft, then closes the card. Lifetimes: 8 s (`message`), 10 s
    (`mention`); the desktop stack widens to 360px while one shows. Plus the
    completion sound and, with "Only in background" off, the OS alert, when
    the kind is chosen in Settings → Notifications;
  - Polyth hidden: the chosen OS alert (one per chat, `renotify`), unless
    Web Push is active, which covers it from the service worker.
  Reading a chat (on screen) clears its card, unread people inbox rows and
  OS notifications. Notification-centre rows of people kinds show the
  sender's monogram in their colour instead of the kind glyph. A chat is marked read only while the page is visible;
  coming back marks the open chat read. `message` alerts are on by default.
- **Conversations**: "New conversation" in the project menu opens a
  dialog/sheet: people with check marks
  (search appears above six members), the first message, then an optional
  title whose placeholder is the people's names. In a conversation,
  collaborators get "Start session" in the composer rail (a glyph on
  phones). Choosing messages replaces the editor with "N selected · Cancel ·
  Continue" in the same dock (a round check leads each row; rows toggle by
  click, Space/Enter, or a long-press on a phone; Escape cancels; state in
  `conversationSelection.ts`).
  Continue opens a dialog that quotes the chosen messages, then asks for an
  optional instruction, a title (the conversation's), a model (project
  default unless picked) and a one-time editable copy of the participants;
  with nobody left the new chat stays private.

### 3.1 Host catalog pickers

The Canvas add-widget menu uses the host-owned compact catalog treatment in
`workspaceCatalog.css`. Catalogs with more than four choices keep search and the
package filter at the top, group results by the owning package, and use metadata
rows instead of oversized cards. A picker with one to four choices drops that
chrome and uses a compact action strip/grid instead. The Canvas picker adds
category, supported-zone, and capability details and toggles canvas visibility
in place. Package grouping/filtering is presentation metadata: it does not grant
package authority or change widget placement rules.

#### Phone Workspace editor

The phone Workspace (`WorkspacePanel.tsx`) customizes in two steps inside its
one Sheet: add on a full page, then arrange and manage in place. Its header is
the same row in both modes: Back leads (`dismiss="back"`, where the Back swipe
takes the layer) and an Edit switch trails (`SheetAction` `kind: "switch"`,
`role="switch"`); editing is a mode, so Back leaves the Workspace from either
mode and the content that replaces the other mode settles in
(`is-mode-switched`). The Back swipe follows the finger while editing too: a
reorder starts only from a still press or a grip (`touch-action: none`), so a
moving finger is never one, and once an item is lifted
(`data-arrange-dragging`) the swipe stands down.

- **Add page** (`WorkspaceGallery.tsx`, `workspaceGallery.css`): a full-height
  page drawn as the sheet's own top layer, moving with the phone stack grammar —
  in from the inline-end edge; Back, Done, Escape or a swipe (the editor peeks in
  behind) pop it. A large search field needs every word of the query in the
  title, description or package and ranks title hits first, marking them
  (`searchPanelItems`); All / Widgets / Apps / Layout filters carry live counts.
  Without a query the page shows *Suggested for this project* (the kind's
  default widgets not placed when it opened), every app as a tile grid, each
  package's widgets A–Z, then the layout elements (`panelGallerySections`);
  sections longer than their preview (8 apps, 4 widgets) fold behind *Show all*.
  Apps already placed when the page opened sort last, fixed for the visit.
  Everything renders metadata only, never a live widget. A tap adds — an app
  joins the other apps, anything else goes to the end (`insertPanelItem`); a tap
  on an added single-use item takes it off; repeatable items add another. Back
  in the editor, the newcomers are marked once and brought into view.
- **Arrange** (`WorkspaceEditor.tsx`, `workspacePanelEditor.css`): the
  arrangement drawn as it will look (tiles four to a line — three in narrow and
  six in wide containers — and widgets and layout elements as full-width rows),
  every control on the item itself: a corner minus removes, a widget's size pill
  cycles its sizes, headings and labelled dividers are edited in place. Undo
  walks back every change of the editing session (a burst of typing in one label
  is one step); *Reset to default* restores the project's default arrangement and
  is undoable. Rows show metadata only.

Reordering is `workspaceArrange.ts`. A touch lifts an item after a 220 ms press
without moving (a swipe still scrolls); a row's grip lifts at once
(`touch-action: none`); a mouse or pen drags after 4 px; arrow keys (Home/End)
on a tile or grip move it and Delete removes it. A pointer move only transforms
the lifted copy (drawn inside the sheet) and re-aims; React renders only when
the hole moves. Aiming reads the resting geometry measured after that render,
in the scroller's content coordinates: an item counts as passed once the held
item's centre (a row's: the finger's inline position) is past its middle in
reading order, with a 10 px stickiness margin that cannot oscillate. Neighbours
glide by FLIP (Web Animations, `--motion-normal`) from wherever they are on
screen, on layers they keep for the whole drag; each move stops, reads, then
writes, so it costs one style and layout pass. The list auto-scrolls near its
edges (scroll anchoring is off meanwhile); once lifted, page scrolling, the
system long-press menu, text selection and the browser's own drag of an image
or link are blocked. Blocking the scroll needs the no-op non-passive
`touchmove` listener the engine keeps on the list: WebKit and Chromium decide at
touchstart whether a touch's moves can still be cancelled. Escape or a
cancelled pointer puts the item back; a kept touch move lands with a haptic tap.
The order is saved once, on landing, through `permutePanelItems`, which keeps
items this device cannot draw in their slots. The navigators move projects
with the same engine (see the navigator above).

### 3.2 Rail and zone editor

Every icon rail and shell zone (top rail, right rail, sidebar toolbar, header
actions, composer, status bar) opens the same editor from its Customize pencil:
`CustomizeZoneButton` → `RailEditor.tsx` (`railEditor.css`, model in
`railEditorModel.ts`). Desktop and tablet get an anchored panel (vertical rails
open beside themselves so the rail stays visible); phones get a tall sheet.
The panel shows "Shown here" as single-line rows in rail order (drag, or
Alt+↑/↓ on the handle, through the shared `railDrag.ts` engine; minus removes),
then compact tool and widget tiles. Search appears only past
`RAIL_EDITOR_SEARCH_THRESHOLD` items.

One home per icon (`railPlacement.ts`): a capability launcher lives in exactly
one place — the top rail (primary tier), the right rail (more tier) or one
zone as its launcher widget (`capability:<id>`, or a dedicated one: the header
bell `notification.bell` IS the Notifications launcher, so a bell and a
Notifications rail icon are never both drawn). Tiles of items shown elsewhere
carry that rail's name and adding them moves them (`placeCapability` /
`removeCapability` leave the old home first). Legacy layouts that still hold
both are drawn once: a visible launcher widget wins and the tier rails skip
it. A widget that is not `duplicatable` is shown in at most one shell area:
on load the first visible instance in `UI_SLOTS` order keeps it and later
ones stay placed but hidden. Nothing in a rail is pinned or locked: Terminal
and Workflow only *start* on the top rail (`defaultPinnedTop`, until the
person places them anywhere) and, like every launcher, widget and panel
button, can be reordered, moved to another rail or hidden (a hidden launcher
stays reachable from search, its shortcut and the rail editor's tiles).
Right-rail panel buttons that are not capabilities (slot-contributed panels,
`railPanelSurfaces`) reorder within the right rail and hide through a
Technical placement under their id. The account menu beside the header rail
is not a rail item: it holds Edit mode, Your account (Settings → Users, own
account view), About, the tour and All settings, not a launcher.

**Four draggable rails.** The top rail (left of the header), the right rail,
the top-right header rail (`HeaderActionsRail` in `Header.tsx`, areas
`session.header.actions` then `app.header.actions`) and the navigator's
Project rail (`components/sidebar/ProjectRailTools.tsx`, area `sidebar.rail`,
drawn under the project icons) are `railDrag.ts` zones `top`, `right`,
`header` and `sidebar`. Each rail draws ONE order the person controls,
mixing its launchers, panel buttons and placed widgets
(`components/RailZoneWidgets.tsx`) as drag items: a launcher —
tier icon or launcher widget — under its capability id, any other widget as
`widget:<instanceId>`; legacy slot contributions render in place and do not
move. Drag (long-press on touch) or Alt+Arrow reorders; dropping on another
rail moves the item there through `commitRailZoneOrder`, which leaves the old
home first. A rail accepts a widget only where its definition supports one of
the rail's areas (`railWidgetFits`); Search and Settings support the top,
right and Project rails; the header and Project rails accept any launchable
capability whose launcher widget fits them. The Project rail stores its order
as the `sidebar.rail` placement order. A header order is
mapped onto its two areas with the fewest moves (`headerRailSlots`). The top
and right rails store their whole mixed order (`railOrder.top/right` in the
capability layout record, written by `commitRailZoneOrder` together with the
launchers' tier ranks): a drop anywhere lands exactly where it was dropped
and survives reloads. `orderRailItems` reads it: stale ids drop, and an item
the order does not mention yet — a new arrival, or every item of a rail never
rearranged — keeps its place right after the item it follows in the rail's
natural order (tier launchers, then panels, then placed widgets), so an
existing layout looks exactly as before until its first rearrangement. A
launcher already living in a rail as its widget is only reordered there,
never converted to a tier icon. The keyboard path between rails is the zone editor: a tile shown
elsewhere moves the item here. The header editor lists and reorders the row
exactly as drawn. While Shift-customize is held, placed widgets in the widget
rails carry SlotHost's HTML5 drag instead of the rail's pointer drag (so they
can be dropped onto the Canvas, the status bar or another widget area) and
show even when unavailable; built-in tier launchers keep the pointer drag.

**Pulling an icon off its rail.** An icon dragged away from *every* rail and
released is removed, the way an icon leaves the macOS Dock. "Away" is farther
than `REMOVE_DISTANCE_PX` (50px, straight-line) from the edge of each drag zone
and of the project rail (`data-rail-region` on `.sidebar-project-rail`); between
a rail's 28px hit area and that line a release still puts the icon back, as
does one outside the window. The verdict is shown before the release: the
source rail closes over the gap (`RailDragState.removing`, so neighbours glide
together through the same FLIP as any preview), the ghost goes translucent with
a danger ring and carries a "Remove" pill (`raildrag.remove`, a sibling of the
ghost body so it stays level, and carried below the ghost within 44px of the
window's top edge so it is never cut off). A pointer already past the line
disarms only 6px closer (`REMOVE_HYSTERESIS_PX`), and returning onto a rail or
pressing Escape reverses it. On release the ghost swells and dissolves in a
puff of smoke (`playPoof`: a core and six puffs, transform and opacity only,
about 480ms, theme-aware ink, every node removes itself and a timer backs the
animation events; reduced motion, the in-app setting and low-resource desktop
just remove the icon) and the zone's `remove` runs. `removeRailItem`
(`railPlacement.ts`) is the editor's minus: a placed widget is hidden in place,
a launcher or panel button moves to Technical, so the icon stays one click away
in the editor, search and its shortcut. A zone opts in with `remove` (and
`canRemove`): `top`, `right` and `header` do; the editor's list and the view
tabs do not, and a widget its package marks `requiredVisible` is neither offered
the pill nor removed. A touch drag ticks (`haptics.ts`) when the verdict changes
and when the icon goes, since a finger hides the ghost.

**Dragging a launcher in from a window.** A launcher offered outside the
rails — today every Custom actions tile (`ActionTile.tsx`) — can be dragged
straight onto a rail. The source only calls `setDragCapability` (`dnd.ts`)
with its capability id; the host's document-level
`installExternalCapabilityDrag` (installed once in `init.ts`) sees the
`CAPABILITY_MIME` drag, arms the rails through `beginExternalRailDrag` and
lets the rail under the pointer show the same landing slot a rail-to-rail
drag does. Each rail opts in with `externalMime: CAPABILITY_MIME` and spreads
`useRailDragZone(...).dropProps` onto its drop container; only a rail whose
`accepts` really takes that id highlights and accepts, so an action scoped to
another project is refused. The payload is read on `dragover` (never in
`dragstart`, and never before the drop in Firefox), and the drop persists
through the same `commitRailZoneOrder` — one drag can therefore both reorder
within its own window and place the item on a rail.

**Curated header rail.** By default the top-right rail holds exactly Search,
Settings and Notifications (`HEADER_RAIL_DEFAULT_WIDGETS` in
`widgets/widgetLayout.ts`). Any other widget whose default area is a header
area — Session history, the header Goal and Auto-approve twins, package
header icons — starts hidden there (still placed, one click away in the
editor); their composer counterparts keep their own defaults. A layout saved
before this is curated on load (`curateHeaderRail`) only while its header is
still pristine — every pre-curation default it holds (Search, Settings,
Notifications, History, header Goal, header Auto-approve) still shown in its
default area; a person who already rearranged the header keeps it. Visible
header widgets still in the area the standard arrangement put them are then
hidden (still placed); anything the person moved into the header and unknown
ids are kept. An item whose package registers after the layout is read is
listed in `headerRailPending` and decided when its definition arrives
(`ensureWidgets`). The `headerRail` marker is only a fast path: an older
client that drops it makes the next load re-check, and a header changed since
is no longer pristine. The non-duplicatable dedupe runs after the curation. The account menu beside the rail is not a rail
item.

**Default arrangement** (`projectCompositionPlan.ts`). A project that was
never arranged — a new one, or one whose `capabilityLayout` record was deleted
to reset it — receives one complete, explicit placement for every capability
(`defaultCapabilityPlacements`), recorded with a `defaults` version marker.
Each package declares `defaultRails` on its capability: per project kind (each
of the project's directions, or `general` for a project without any) the
launcher starts on the `top` or `right` rail; an unlisted kind starts it under
More. Several directions take the most prominent rail any of them asks for. A
capability without `defaultRails` keeps its `standardTier` where its package
auto-places (`autoPlacesContribution`); an explicitly included package always
gets a visible rail. A person's Personal project (`Project.personal`, §3.3) is
the `personal` kind whatever its composition says (`projectKinds(…, { personal })`,
`RailPlanOptions`): only launchers that list `personal` start on a rail —
today Files, Agents and Planner on the right rail, the top rail empty — and
everything else, standard tier or not, waits under More. While every project
shares one interface (§3.4) it plans as General like the rest. The same set
drives the phone Workspace (no default summary widgets for `personal`) and,
in that project, the tablet shortcut rail, which shows the project's rail
launchers, Notifications and Settings instead of the account's pinned
`mobileShortcuts`. Rails are capped — the top rail keeps
`DEFAULT_TOP_RAIL_LIMIT` (5) launchers by `standardRank` and spills the rest to
the right rail, which keeps `DEFAULT_RIGHT_RAIL_LIMIT` (6) launchers it can
draw (a right-pane destination); one launcher per package per rail. A rail
may start empty (a Home project has no right rail). Capabilities that arrive
later take the same per-project decision (`capabilityArrivals.ts`). Any
rearrangement by the person drops the `defaults` marker, so neither a later
plan nor project setup ever replaces it. The mobile Workspace panel, until
customized, lists the same launchers in rail order (an unarranged project gets
the standard launcher set), followed by its project kind's glanceable summary
widgets — `DEFAULT_PANEL_WIDGETS` in `workspacePanel.ts`, taken round-robin
across directions, capped at `MAX_DEFAULT_PANEL_WIDGETS` (4), skipping widgets
of disabled or project-irrelevant packages and showing none until the
project's composition is known. A widget that reports itself unavailable (`isAvailable`) is omitted outside
edit mode: a session card such as Session usage, or Usage limits in its
default `current` source, disappears until an active session exists instead of
drawing a "No active session" empty state (edit mode still shows it so it can
be reordered or removed). Full-surface views stay launchers. Agent
actions (`session.work-status`) and Activity timeline (`session.activity`) are
technical diagnostics and are never a default; they remain in the library.
The defaults are recomputed, never persisted: the first edit saves the layout.

**Command launchers** (`kind: "command"` on a capability). A capability that
acts on a press instead of opening a destination — every custom action is one
(`custom-action.run.<id>`) — may sit on any rail without a pane (the right
rail counts it as drawable, `railDestinationIds`), is never active (no
`aria-pressed`), never closes the open pane (`toggleCapability` only calls
`open()`), and is its own launcher rather than sharing its package's one slot
(`uniquePackageLaunchers`). A capability's own `icon` (a monochrome component
taking `size`/`strokeWidth`) wins over its package mark in `railIconFor`; it
renders as the rail's direct `svg` child so the rails' glyph sizes apply.
What a press shows is the package's: a custom action opens its Terminal tab
or shows its run as a result notification (`host.notifications`, §4.8).

<a id="view-tabs"></a>**View tabs** (`HeaderViewTabs.tsx`, model `viewTabs.ts`). Chat, Canvas
and every primary workbench profile (Tasks, Creative Studio…) form one
customizable rail beside the brand: drag a tab (long-press on touch,
Alt+←/→) to reorder it, and its Customize pencil opens the shared
`RailEditor` to reorder, hide or bring tabs back. Every tab can be hidden,
Chat included (the brand still returns to Chat). Visibility keeps its
owners: Canvas is the project's `canvasEnabled`, an optional profile its
`workbenchProfiles` offer; Chat and always-offered profiles are hidden
through `viewTabs.hidden`, and the order is `viewTabs.order`, both in the
project's capability layout record (setting them never drops its `defaults`
marker). The tab this device is on is always drawn so it can be left; a
switch with a single drawn tab is omitted outside Edit mode. Drag ids are
`tab:<id>`, so a tab never lands on a launcher rail. The tab group wraps its
26px segments instead of taking `--control-h-sm`, so it is exactly as tall
as the top rail's pill beside it in every style and a selected segment never
spills out of it; selection is the plate and the label ink, never a heavier
weight that would widen the tab. There is no header ⋮
"More workspace tools" menu: the top rail draws exactly what was placed and,
short of room, scrolls sideways from its start while the session title keeps
240px.

Edit mode reveals the pencils on touch tablets too (`min-width: 481px` with a
coarse pointer); the transient Shift reveal stays mouse-only. Settings →
Appearance → Layout → Rail size and spacing → *Set each rail* → **Icon spacing** (`ui.railSpacing`, 0–20 px,
default 6; records saved before the setting existed keep 4) publishes `--rail-gap`, the gap of the left, right and top rails;
coarse pointers never go below 8 px.

### 3.3 First-open interface tour

After sign-in, an account that has not seen it gets the interface tour
(`shellIntro.ts` model, `components/ShellIntroTour.tsx` + `.css`). A spotlight
cut out of the scrim frames the real control and a one-shot arrow runs from the
card to it: welcome → the composer card ("Start right here": no setup, work
starts at once) → the Navigator (chats, and projects added later) → the
add-project button, presented as optional → top rail → right rail
→ dragging icons between rails and off them → functional customization (Edit mode, zone
pencils, Settings) → visual customization (Settings → Appearance). Phones use
the `phone` variant of each step (navigation button, tools island; no right-rail
or drag step); a wide window whose tools left the top bar (`bare`, the
fresh-install layout) uses the `barless` variant: one **Tools** step on the
launcher strip instead of the two rail steps, and the appearance step finds the
docked Settings (`[data-rail-item="widget:shell.settings"]`) when it stands in
for the rail's gear. An account that may not add projects skips that step,
and without any project (none could be made for it) there is no composer, so
the start step is left out. Steps
resolve the first *visible* selector in `anchors` and centre the card when none
is on screen. `data-intro-anchor` marks controls whose class is ambiguous —
keep those attributes when restyling the rail.

Admission (`decideShellIntroAdmission`, run by `App.tsx`) waits for the first
account settings snapshot (`isClientSettingsSettled`, 5 s fallback) and a
non-loading project registry, and never stacks over another overlay; while
open the tour owns the store overlay `"onboarding"` and ends if another overlay
replaces it. A new account normally has its personal project by then (below),
so no picker follows; when the folder picker is the fallback, it waits for the
tour. Any close (Done, Skip, Escape, a step's
button) records `{ seenVersion }` in the account preference `core.shell-intro`
(monotonic, synced by `settingsSync.ts`), so it is shown once per account, not
per device. Bump `SHELL_INTRO_VERSION` only for a substantially new tour. It can
be replayed from the user menu or the command palette ("Interface tour").

The add-project step's **Add a project now** does not end the tour: it
suspends it (`suspendShellIntro`, recorded as seen so a reload does not restart
it, and noting the project ids that exist) and opens the project dialog. Once
no overlay is open, `App.tsx` resumes it after `SHELL_INTRO_RESUME_DELAY_MS`
(`resumeShellIntro`). When a new project id appeared, the tour continues on
**Your project is ready** (`project-ready`, shown only then, pointing at the
active project's rail tile); a cancelled dialog continues with the step after
add-project. A resume lands by step id (`shellIntroResumeIndex`), so a changed
step list cannot shift it; replaying the tour drops a pending resume.

Tour copy is written for people who have never used a developer tool: everyday
words ("buttons", "tools at the top", "add-ons"), no rail/composer/package
jargon in the main text, and Git/SSH only as a developer aside. Keep new steps
in that voice.

**First run without a project.** Nobody has to choose a folder to start. When
the project registry is truly empty (not a transient empty list during
recovery), `refreshProjects` (`init.ts`) asks `POST /api/projects/personal`
once per document for the person's **personal project** and publishes it as the
registry; meanwhile the registry stays `loading`, so the picker never flashes.
It is a private (`private` resource, owner only), non-Git folder in Space
storage with the `user` project icon, named with the localized
`personalproject.name`. The server refuses it to viewers, system principals and
project-limited accounts, and once the caller can see any other project
(`conflict`); then the folder picker opens as before.

While it is the **only** project (`soloPersonalProject`, `personalProject.ts`)
the shell carries no project chrome: the Navigator lists its chats flat (no
project row, no rail icon; Sidebar and `MobileNavigator`), the composer has no
project/checkout bar above it (`SessionContextBar` is not mounted), the tablet
header titles a fresh chat "New chat" and captions no project, the fresh
chat greets with `personalproject.greeting` instead of naming the project, and
starters keep to everyday ones (`StarterContext.personal`,
`PERSONAL_STARTERS`). Its storage path is never shown as a detail. Adding a
real project turns it into an ordinary project group again, and all of that
chrome comes back. Its rails stay simple either way: it is the `personal`
project kind, so it starts with only Files, Agents and Planner on the right
rail — no Source control, Terminal or Custom actions — and the rest waits under
More (§3.2, Default arrangement).

### 3.4 New project flow and folder picker

Add project opens `ProjectSetupFlowDialog`: step 1 asks "What are you working
on?" with `ProjectCompositionEditor` (`purposeHeading={false}`, since the step
header asks it). Per-package visibility sits in that editor's collapsed
Workspace accordion. The accordion lists only enabled, non-core packages that
own a rail launcher: a registered capability with `rail !== false`
(`railLauncherPackageIds`). It ignores the active project's relevance.
Background helpers, importers and settings-only integrations get no Show/Hide.
An earlier override on a package that is no longer listed appears as a
removable row. Below the step header, everything from General to the
Cancel/Continue row is one scroll region (`.project-setup-scroll`); the
expanded Workspace list never scrolls on its own, so a short (half-screen)
window stays usable. Continue opens step 2, `ProjectFolderDialog` with
`onBack`. Back keeps the chosen directions. Settings reuse the same picker
without `onBack`.

When the account uses one interface for every project (Settings → Projects →
Interface across projects, `projectInterfaceScope.ts`), directions shape
nothing, so the flow opens `ProjectFolderDialog` directly: no step labels, no
`onBack`, the project is created as General and the shared arrangement is
never reseeded (`seedInitialProjectWorkspace` is skipped).

`ProjectFolderDialog` keeps its contract in its header comment. The main rules:

- **No keyboard on open.** Initial focus is the `.folder-list` listbox,
  never a text field. Typing a path is opt-in: click the empty end of the
  breadcrumb bar (`.folder-crumbs-edit`), press Mod+L, type `/` or `~` in the
  list, or use the ⋯ menu. Escape returns to the breadcrumbs.
- **Simple first, pro behind a menu.** The location bar shows Home, Up, the
  breadcrumbs (home collapses to `~`) and a ⋯ menu with Go to path… and Show
  hidden folders. The list supports type-to-select. One bottom bar
  (`.folder-foot`) holds the ways to add (New folder plus
  `project.create.options` chips) and the primary button, labelled
  `Open “<folder>”`. On phones the chips become one swipeable pill row above a
  full-width primary.
- **Escape is layered.** The Dialog's Escape listener sits on its panel, so a
  bubbling React `onKeyDown` cannot stop it. Inline fields and source panels
  claim Escape in `onKeyDownCapture`, skipping open popups (`listbox`, `menu`,
  `aria-expanded="true"`). The first Escape collapses the field or panel; the
  next one closes the picker.

`project.create.options` contributions (`packages/git/widgets/GitProjectSource.tsx`,
`packages/ssh/widgets/ssh/SshProjectSource.tsx`) render a
`.folder-source-chip` with `aria-expanded`. When open, they also render a
`.folder-source-panel` with its own fields and confirm button. The slot context
provides:

- `busy`
- `browsedPath`
- `armedId`
- `arm(id, { soloBrowser })`. Solo sources such as SSH hide the local browser.
- `disarm(id)`. It only clears that id.
- `onProjectOpened()`
- `onConfigure`

Only one source is armed at a time, and it owns the primary action while open.
Mounted coverage is in `apps/web/test/projectFolderDialog.test.ts`.

### 3.5 First-run setup and sign-in screens

`SetupScreen.tsx` and `LockScreen.tsx` render before the app boots
(`bootstrap.tsx` phases `setup`, `restart` and `locked`). Setup asks only for
what cannot be defaulted:

- **Steps.** Polyth Desktop first asks how Polyth will be used: one quiet
  well of three radio rows (`.setup-usage`, the selected row carries the only
  accent besides the primary button) — "just me, on this computer" (default),
  "me, from my phone too", "with other people" — with a one-line foot under
  the button saying what happens next. The first two need no password: Start
  calls `completeLocalSetup()` on the desktop bridge (the main process takes
  the name from the OS account) and restarts into the workspace; "from my
  phone too" then opens Polyth Link (`/?settings=tunnel`). The progress dots
  stay hidden (height kept) for this one-step start. "With other people" shows
  three dots and continues to the account (name, and a password with a reveal
  toggle instead of a confirmation field) → recovery codes → automatic restart;
  Back from the account returns to the choice. A shell without
  `completeLocalSetup` starts at the account. A standalone server first asks
  for the setup code printed by `npm run setup:claim`, shown with a copy
  button. The owner login is fixed (`owner`, stated under the form) and the
  organization defaults to "Personal".
- **No password, no form.** For a password-less owner (`accessMode: "local"`
  in `/api/auth/status`) a locked Desktop window asks its main process for a
  new session once per minute (`claimOwnerSessionRenewal`) and reloads; the
  lock screen shows no sign-in form but "Welcome back" + Continue in Desktop,
  or, in a browser, where Polyth opens and where to set a password. Settings →
  Users → your account offers "Set a password…" (`SecureAccountDialog`:
  password → recovery codes → Protect account); "Add user" opens the same
  dialog first, then the add-user form.
- **A claim never strands the flow.** Desktop requests its claim only when the
  person continues, and replaces a claim the server refuses once with
  `requestSetupClaim({ fresh: true })`. A claim that expired while the codes
  were open makes Create show new codes with a notice and a fresh
  acknowledgement, not an error. A server returns to the setup-code step and
  says whether the code expired. Back → Continue keeps codes whose claim lives.
- **Errors are sentences.** Server error codes map to `setup.error.*` copy
  (`problemFor`); a raw code such as `invalid claim` is never shown. All copy
  goes through `tr()`.
- **Recovery codes** are a monospace sheet in four-character groups (a code
  font exception to `html[data-font]`); copy and download produce unbroken
  codes, and a narrow card wraps a code into two even halves.
- **Fields read as fields** under the default borderless appearance: lock-card
  inputs keep a soft fill (`--lock-well`) and `--borderless-edge`, and the
  checkbox keeps its outline.
- **Scrolling and window chrome.** `.lock-screen` is its own scroll container
  (phones clip the document, the desktop app clips its body) and centres the
  card with auto margins, so a tall card stays reachable. In a hidden-titlebar
  desktop window its top band is the drag region.

Mounted coverage is in `apps/web/test/setupScreen.test.ts` (with the real
desktop claim broker, and the usage step); source guards are in
`setupRecoveryUi.test.ts` and `authBootstrap.test.ts`.

## 4. The seams in detail

For repository scope, canonical file identity, preview tabs and workspace search,
see [Workspace repositories and resources](workspace.md). Repository pickers
belong to individual surfaces; they do not establish global repository state.

Source control keeps commit identity, Git transport, and provider API access
separate. Commit identity and hosting accounts belong to the signed-in person
([Spaces §14.4](../architecture/spaces-and-tenancy.md)): the repository-identity
control shows the instance owner the checkout identities below, and everyone
else their own commit identity (or "Set commit identity", flagged) with links
to it and to their accounts in Settings; the validated remote target is remembered per repository/session scope and is
the one used by Fetch, Pull, Push, and Sync; and
GitHub/GitLab account contributions describe the provider API account. A
identity label must never imply that it changed credentials or selected a
provider login, and the identity editor never stores or asks for a secret.

**Git identities** (titled *Repository identities* in Settings) are
Space-wide `SourceControlProfile`s (name, email, an
optional SSH **signing key** `~/.ssh/*.pub`, an optional **hosting account**
reference and an **auth method**). Each project picks one
(`repositoryProfileIds[projectId]`); a project without one uses the **default
for all projects** (`globalDefaultProfileId`), then System Git. The identity
dialog (`SourceControlIdentityDialog.tsx`) offers exactly the auth methods
Polyth carries out: *This machine* (host helpers, agent or CLI — nothing
written), *Account* (Polyth binds the project to the identity's service/host
account through `/api/git/account`; a personal account applies to its owner
without a binding; tokens only ever reach Polyth's own HTTPS fetch/pull/push),
*SSH* (`core.sshCommand` with that key) and *Anonymous* (`credential.helper=`
and a key-less `core.sshCommand`). Signing writes `gpg.format=ssh`,
`user.signingkey`, `commit.gpgsign`/`tag.gpgsign`; Polyth marks what it wrote
(`polyth.managedsigning`, `polyth.anonymous`) and removes only that. The
client reconciler (`sourceControlRuntime.ts`) applies the resolved identity to
the checkout through `POST /api/git/identity` (`signingKey`, `anonymous`
besides `name`, `email`, `sshKey`) for the instance owner only. Polyth-made
commits by the owner and system work carry the project's identity
(`projectCommitIdentity`, host-matched against `origin`) even before the
checkout was reconciled; other people commit as their own profile with the
checkout's signing turned off for that one Git child (`unsigned`), so they
never sign with the owner's key. Projects reconcile their checkout config when
opened in the UI: a changed default reaches an unopened project's Terminal and
agent shells only then.

The **project source-control account** is the one transport-credential choice
Polyth owns. Provider packages register a `SourceControlCredentialProvider`
(`@polyth/contracts/source-control`) with the Git package's
`source-control.credentials` registry: GitHub lists the host's `gh` logins
(local-trusted deployments only), GitLab lists its Polyth-connected accounts
(PAT accounts supply their token; `glab` accounts defer to the host's own
helpers). The clone panel lists the accounts whose origin matches the entered
URL, defaults to the provider's active account, and offers System Git. The
chosen account authenticates the clone and is then bound to the project
(`/api/git/account`, Space-admin to change; Source Control settings show it as
"Project account"); Fetch, Pull, Rebase, Push and Sync from Polyth authenticate
the bound host with it. Credentials reach exactly one Git child process through
an origin-scoped inline helper that reads them from that child's environment —
never argv, the URL, the repository config or logs. Only the account's login is
recorded as `credential.<origin>.username`, so the user's own helpers pick the
same account in Terminal and agent shells. SSH remotes always use SSH keys; the
account then only selects the provider binding. Source Control profiles with an
SSH key are offered beside the accounts (`identity: { profileId }` on
`POST /api/projects/clone`, Space-admin like an account): the server clones the
repository's SSH address (`git@<host>:<path>.git`, rewritten from an HTTPS URL)
with only that key, unattended (`BatchMode`), and writes the profile's
`core.sshCommand` before registering the project; the panel pins that profile
as the repository's commit identity, so commits, fetch, pull and push all use
the same identity. Choosing such a profile under "Commit as" selects it as the
account unless an account was chosen explicitly. The cloned project is
registered through the request's Space-scoped project service; if registration
fails the fresh checkout is removed so the clone can be retried. Agent shells
and Terminal still use the machine's Git credentials (§14.4 "Not covered"). If remote inspection is unsafe or
no remote is configured, keep local editing available and disable remote actions
until a safe target is available. Source control presents remote failures and
working-tree conflicts in one recovery region above its tabs, with one set of
agent draft actions. The failure reason and remote stay together; conflict
counts remain visible alongside the recovery hint. Without a remote failure,
the conflict recovery region appears only on Changes.

Settings → Source control (`GitSettings.tsx`) is one page with five
`SettingsTabs`, one per job: **Accounts** (default), **This project** (only with
an active project), **Workflow**, **Display** and **Space** (only for Space
admins). A settings target picks the tab: `gitSettingsTabFor` maps every
`data-settings-item` to the tab that renders it, `sectionId` may name a tab
directly, and a new target on the open page switches tabs in the same render,
so the host finds the row. A tab that is not offered falls back to Accounts and
keeps the choice (an admin deep link opens once the role is known). The
Accounts tab label carries an amber dot while the person has no commit identity
and no installation fallback.

- **Accounts** — **Your commit identity** (`PersonGitProfileSection`,
  `GET/PUT/DELETE /api/git/profile`, any member): a draft form with `SaveBar`
  and Remove in the section header. Then the `settings.integrations` slot
  (context `{ projectId?, spaceAdmin }`), where each hosting provider renders
  the person's own accounts as one `Section` through the shared
  `HostingAccounts` (`@polyth/code-hosting/accounts`): an `ItemList` row per
  account with the provider mark, a label badge, "On/Off in this Space" and the
  per-Space switch, Remove behind ⋯; an empty state whose action reveals the
  connect form (token in a password field cleared once sent, also on failure,
  optional label and server). Providers own their routes and every word of
  copy (**GitHub** `/api/github/accounts`, **GitLab** `/api/gitlab/me/accounts`).
  Last, for the instance owner only, **Repository identities**: the default
  for all projects as a `Select` row and the identities as an `ItemList` (open
  = edit, ⋯ = use for this project / make default / delete).
- **This project** — the repository as one `ItemRow` (name, branch, changes,
  ahead/behind, *Open Source control*) or an empty state when the folder is
  not a repository; **Commits** (owner: the project's identity `Select` and
  what it commits as; anyone else: their own identity as a fact with
  *Change*); **Git access** (the selected remote as a fact, for Space admins
  the project account picker, which lists only service/host accounts because
  personal ones are never bound to a project, and the SSH/HTTPS guide behind a
  disclosure); then the `settings.integrations.project` slot (context
  `{ projectId }`; GitHub shows the repository and the gh sign-in there).
- **Workflow** — Commit messages (the Space's model choice), Branch names (the
  template with a live example) and Merge conflicts (where the agent resolves
  them and the prefilled request), each section with a reset.
- **Display** — Changes (with an inert preview rendered by the real
  `ChangeSection` from sample files, so tree/list, line counts and density show
  their effect), Diffs and History, each section with a reset to
  `GIT_PREFS_DEFAULTS`.
- **Space** — **Space service accounts** (the "Agents may use Space accounts"
  switch, `/api/git/service-policy`), then the `settings.integrations.space`
  slot (context `{ projectId?, spaceAdmin }`; GitLab renders **Space GitLab
  accounts** there for admins).

Checkout identities show, and the background identity reconciler writes them,
only when the profile DTO's `usesInstallationFallback` is true or the profile
route is unavailable (`mayWriteCheckoutIdentity` in `personGitProfile.ts`).
Every project also has **Project settings → Git identity** (`git.identity`
contribution, `ProjectGitIdentity.tsx`): the owner picks that project's
identity or creates one for it; anyone else sees their own commit identity and
a link to change it. Search items: `git.personProfile`, `git.personAccounts`,
`git.sourceControlProfiles`, `git.defaultIdentity`, `git.projectIdentity`,
`git.authentication`, `git.commitMessageModel`, `git.branchTemplate`,
`git.conflictAgentTarget`, `git.display`, `git.servicePolicy`. The identity
dialog's label/field grid becomes one column in narrow containers.
The former Integrations settings route is a hidden compatibility redirect.

Git action errors in the package go through `reportGitError`
(`packages/git/widgets/gitRefusal.ts`): the friendly toast plus, for
`git-identity-required`, a "Set commit identity" action and, for
`git-account-required`, "Connect account" (both `openSettingsPage("git", {
itemId })`). The route carries only the code, so a lost membership is
recognised by its message and gets no action. A refused remote step keeps its
inline status with the same button until acted on, and does not offer the
conflict-agent draft.

**SSH remotes** (Settings → SSH remotes, Spaces §14.6) group "Your servers"
(personal) above "Shared servers" once the person has or may add their own
(`canAddPersonal`); otherwise it is one list. The instance owner chooses
Shared / Only me when adding (`owner` on `POST /api/ssh/connections`); a
member adds only personal ones, and someone who may add neither sees a quiet
"not available to you" note instead of Add. Personal connections send no auth
fields and sign in only with an uploaded key: the key dialog (`SshDialogs.tsx`)
takes a masked textarea or a file, sends it once with
`PUT /api/ssh/connections/:id/key`, clears it immediately and never reads it
back; it opens right after adding one. Shared connections the caller cannot
edit hide Edit, Delete, Disconnect, installs and configuration choices. For the
instance owner a shared connection shows **Access**: a summary row and a dialog
(people in any Space, every member of chosen Spaces; empty = only the owner)
saved with `PUT /api/ssh/connections/:id/access`, a minimal copy of the harness
accounts Access dialog.

### 4.1 Slot contributions (`host.slots.register`)

```tsx
host.slots.register({
  slot: "session.message.actions",   // a UiSlot from @polyth/contracts
  id: "myfeature.quote",             // stable, unique within the slot
  render: (props) => <QuoteAction {...props} />,
  order: 20,                         // optional; order then id, deterministically
  meta: { /* host-defined descriptors, e.g. commandPalette.commands payloads */ },
});
```

- The `UiSlot` union lives in `packages/contracts/src/index.ts`
  (`UI_SLOTS` runtime array, `UiSlot` type, `isUiSlot` guard). A slot exists
  only if it is in that list.
- **Who renders:** host components mount `SlotHost slot="…"` (e.g.
  `Timeline.tsx` mounts `session.timeline.before/after` and
  `session.message.actions`, plus one `session.timeline.event` host per
  package timeline event. A contribution's `meta.eventTypes` both admits those
  event types into the timeline and routes each event only to contributions
  that list its type (`acceptsContextEvent` in `SlotHost.ts`); renderers
  should still return `null` for a malformed payload rather than draw
  placeholder values. A projected activity group is one timeline row spanning
  its members' seq range, so a fact landing inside that range (compaction,
  harness switch) splits the group around itself (`splitRowsAtEvents` in
  `timelineEvents.ts`, `splitActivityGroup` in `utils.ts`) instead of sorting
  below the whole block. The permissions toast stays pinned at the
  timeline's lower edge so it remains reachable while history scrolls.
  Identical pending approval subjects share one row with a request count;
  each decision answers every request visible in that row through its own
  canonical request ID. Session, permission, tool, targets, preview and allowed
  scopes must match. Requests arriving after a click need a new decision;
  a partial failure leaves only unanswered requests available for retry.
  Each request row of that card mounts `session.permission.notes` between its
  scrolling explanation and its decisions (context: `sessionId`, `requestId`,
  and `sourceSessionId` for a subagent's mirrored request), for package notes
  about that one request such as a permission judge's check or verdict; a contribution
  renders `null` when it has nothing to say about the request.
  `Composer.tsx` mounts `composer.leading`,
  `composer.trailing`, `composer.meta`, `composer.pending`; `Composer.tsx`
  also mounts `composer.config` on the quiet configuration row beside the model
  chip, for package indicators about the effective next-turn route (context:
  `model`, `resolvedHarnessId`, `thinking`, `harnessSelection`, `sessionId`,
  `projectId`, `spaceId`). The row only mounts with the model/effort chips, so
  a contribution must render `null` when the route is not its concern. `ContextPie.tsx`
  mounts `composer.context.details` inside its card; `Header.tsx` and
  `MobileSessionHeader.tsx` mount `session.header.status` beside the shared
  session status control; `Header.tsx` also mounts `app.header.center`;
  `StatusBar.tsx` mounts `app.statusbar.leading/trailing` while the opt-in
  status bar is on (§4.10); `App.tsx` mounts `app.layers` once over the whole
  shell for package-owned floating layers (voice mode, or a renderless
  controller such as custom-action's result notifier): a contribution renders
  nothing until it has something to show, portals and positions itself, and
  stays transient — never a second notice system (passing messages go through
  `host.notifications`, §4.8); the
  composer's `ModelPicker` (`@polyth/models/model-picker`) mounts
  `modelPicker.header` for catalog-routing controls. It uses one anchored
  catalog surface on desktop and phone with provider headings; desktop adds a
  compact search field, while the phone surface has none (harness tabs and
  provider groups are its navigation, and a catalog past the render cap pages
  with "Show N more"). Favorite reordering is desktop drag-only and there is
  no edit-mode control. On touch every row and heading is one tap tall and the
  strip, headings and rows share one inline inset with fixed effort/star/check
  columns (`responsiveOverlays.test.ts` pins this in Chromium). That primitive is the **only** surface for choosing catalog
  models: host settings (session/project defaults, Timeline route recovery,
  a member's allowed models), package settings (Judgment, Custom Titles,
  commit messages, Files inline AI, Memory utility model, schedule, workflow
  nodes) and feature widgets (OpenCode roles, Gallery, MultiRun, Fusion)
  render it instead of a native `<select>`, a free-text model id or a forked
  catalog list. `apps/web/test/modelSelectionUnification.test.ts` enforces it.
  Every model row displays and restores its last account-synced thinking effort,
  keyed by harness, provider and model. The shared reactive cache belongs to
  `@polyth/models/web-prefs`; changes from another picker, browser tab or server
  snapshot refresh open lists and the composer. An explicit current choice or
  `ModelRef.variant` takes precedence over the saved effort for the selected
  row. Explicit Auto is saved as an empty string, distinct from an untouched
  preference; unsupported saved efforts fall back to the advertised default
  and are never submitted. Opening a single-select picker, or switching its
  harness, puts the keyboard-active row on the selected model (a search starts
  on its first match); multi-select starts on row one and Enter toggles that
  row in place. After a harness tab switch, the composer and Timeline route recovery
  select the model last chosen in that harness (rule and memory:
  `docs/architecture/multi-harness.md`, the composer route paragraphs); other
  picker hosts keep their own selection.
  A set of models (Fusion sources, the workflow Auto allow-list, a member's
  allowed models) uses its multi-select mode: `selection` plus `onToggle`
  (optional `maxSelection`). Rows toggle membership and the popover stays
  open; there is no per-row thinking menu, and the empty row clears the set
  through `onPick(undefined)`. Only non-catalog speech presets (dictation
  STT/TTS/local speech models) stay outside the picker. Its optional empty row
  (`emptyLabel`) represents an explicit "no model" route without falling back
  to the first catalogue entry and is the first keyboard stop (ArrowUp/Home
  reach it, Enter clears the selection). Automatic routing does not invent a
  pinned highlight while its runtime target is unresolved: the enabled roster
  remains rendered with one roving keyboard entry, and a selected tab appears
  only after resolution or
  an explicit choice. `Sidebar.tsx` mounts the sidebar slots;
  `ContextRail.tsx` mounts `contextRail.tabs` and `workspace.rail`). `workStatus.sections` remains in the `UiSlot` vocabulary only as a deprecated compatibility identifier. The retired `WorkStatus` host is no longer mounted, so new packages must not target that slot.

The command palette
  consumes `commandPalette.commands` through the command bridge
  (`apps/web/src/commandBridge.ts`). A contribution is visible only where
  the host renders that slot. Results are ranked by
  `rankCommands` (`apps/web/src/paletteOrdering.ts`): every `group` renders
  once (registration order without a query; the group holding the best hit
  first with one), and label prefix/word hits beat keyword, group, id and
  hint hits. Selection follows the entry id, so late session/file results
  never move it; the first Escape clears a typed query, the next closes.
  Desktop has no title bar: the search field leads, the panel is anchored
  near the top and grows downward, and the footer lists key hints.
- **Ordering:** `order` then `id`, computed independently of registration
  time (deterministic across reloads).
- **Session-list badges:** desktop `SessionList.tsx` and phone
  `MobileNavigator.tsx` mount `session.list.badges` with `sessionId`,
  `questions`, and `permissions`. Git owns the isolation lock in this slot,
  including summary-only sessions and legacy `polyth/isolate/` branches.
  A session whose isolated branch was merged shows a green branch icon
  instead, from the durable `isolationMerge` receipt (a navigator summary
  field) — it outranks the lock while post-merge cleanup is still pending.
  The phone host renders its pin, runtime status, and unread mark separately;
  it must not add a second isolation lock.
- **Desktop session row geometry:** the open button (`.session-btn`) is an
  empty, full-row hit surface; `.session-row-body` paints above it with
  `pointer-events: none` in three fixed columns — a state mark reserved on
  every row (running, needs reply/approval, failed, unread; empty when idle),
  the title followed directly by the subagent disclosure (a real button,
  ArrowRight/ArrowLeft on the row also toggles it), then meta: worktree pill,
  running clock, and the identity group (`session.list.badges`, then pin) at
  the trailing edge so those icons line up down the list. The row hover card
  spells out the state the mark shows.
- **Delegated children (desktop and phone):** a session with a `parentId`
  (an `agent.spawn` subagent, a workflow unit) is listed only inside its
  listed parent's disclosure, pinned parents included, and never takes a row
  or a page slot of its own (`isNavigatorRoot`, `apps/web/src/sessionTree.ts`).
  A child whose parent has not loaded is withheld while
  `apps/web/src/sessionParents.ts` reads the parent once; it stands alone only
  when the parent is archived, filtered out or gone. Opening a child unfolds
  its ancestors and keeps its top ancestor in view. Search lists matching
  children as results, as before. The disclosure pill is live, folded or
  open (`SubagentCount.tsx`, `subagentActivity.ts`): a plain count while every
  child is idle, a pinging accent dot and *working/total* (`2/3`) while
  children work, and a steady amber dot and *waiting/total* while one waits
  for an approval or a reply (that outranks work). A grandchild's state counts
  for the listed child it hangs under; the pill's accessible name spells out
  all three counts.
- **Stable ids / replacement:** registration is replace-by-id within the
  slot; a later registration with the same id supersedes the earlier one.
- **Disposal:** the returned `Unregister` removes only its own registration;
  a superseded `off()` is a no-op.
- **Error isolation:** `SlotHost` wraps every contribution in its own
  `SlotBoundary` — one failing renderer disappears alone, never collapses the
  host or its siblings.
- **Context:** the host passes a bounded `props` record (e.g. the message,
  session summary, editing flag). Read the mount site to see what is
  available; never reach past it into host internals.

`sidebar.session.actions` renders after the built-in entries in both desktop
and phone session menus. Contributions receive `sessionId`, `status`, and
`closeMenu()` for dismissing the invoking menu after an action succeeds. Use
the shared menu-item styling and semantics so keyboard navigation includes the
contributed action; unregister it when the package is disabled.

**Navigator multi-select.** A select toggle (`SelectIcon`, `aria-pressed`)
sits immediately left of the session search field in the desktop service
bar, right after the search tool in the phone navigator header, and beside
the list filter in the compact drawer toolbar. It enters and leaves selection
(project `⋯` → Select sessions remains as a second entry); Escape, and Android
Back through the escape stack, end it. Desktop rows show checkboxes and a click
on the row title toggles the row instead of opening it (double-click rename and
long-press menu are off); phone rows turn their status slot into a check mark
and a tap toggles the row (swipe and long-press are off while selecting). `SessionSelectionBar` shows the count and
runs, per session, the same routes as the row menu: Pin/Unpin (Unpin only when
every selectable row is already pinned; archived rows are skipped),
Archive/Restore (`POST /api/sessions/bulk`; Restore when every manageable row
is archived), and under `⋯` Share with the Space / Make private (visibility
only, so named people keep their access on Share; Make private confirms first;
only manageable, non-inherited chats are sent). Refusals are counted and
reported together; one failure never stops the rest.

`sidebar.sessions.bulk.actions` renders package menu items in that `⋯` menu.
Contributions receive `sessionIds`, `closeMenu()`, `done()` (ends the
selection and refreshes the affected lists) and `report(operation, succeeded,
failed[{id, code}])`, which announces the result the same way as the host
actions. Custom Titles contributes *Regenerate titles* (its per-session
regenerate route, three at a time). Git contributes *Move out of isolation*
for selections holding isolated sessions: each status is read live and sorted
with the row menu's `isolationMenuChoice` — nothing to integrate returns,
changes are committed and merged, and conflicts, running agents, delegated
work or recovery are left isolated and reported as `needs-review`; one confirm
names all three counts, then sessions run one at a time (merges into a shared
branch never race) and the server re-checks each one.

`sidebar.project.leading` renders package rows at the top of a project's
session list, above its pinned chats, on desktop (`SessionList`, not in search
results) and phone (`MobileNavigator`). Contributions receive `projectId` and
`activeSessionId` (null while a package page owns the canvas, so no chat row
is current then) and `onNavigate()`, which a row calls after it opens
something so a drawer or the phone navigator gets out of the way; the desktop
list also passes its `query` and `attentionOnly` filter, and the phone
navigator passes `surface: "phone"` (its rows use the phone metrics). Rows
take their measures from the list's own tokens (`--nav-row-session`,
`--nav-session-size`, `--session-lead-size`, `--session-pill-inset`,
`--session-menu-size`) so they read as peers of chats: nothing is highlighted
at rest (no pinned-chat backing), hover and the current row use the chat
row's wash and glass, state marks sit in the leading column (spinner, amber
shield, red `!`, unread dot), and actions open from one menu reached by right
click, the ⋮ trigger, long press and Shift+F10/ContextMenu. A row that opens a
package page is current exactly while `store.getSnapshot().activePage` names
it. The Agents package draws its agents here as a foldable group (see
`docs/dev/architecture.md`, `schedule`).
`host.sessions.claimListing(purpose)` lets a package present the sessions of
one `purpose` (and their delegated children) in its own UI instead of the
ordinary lists — an agent's runs are read from its diary. Claims are
reference-counted and released with the package; opening such a session is
unchanged. The Agents package reaches those sessions instead from the agent's
menus (a Conversations drill-in) and its conversation's heads, and names the
agent in the header of its own session in Chat (`session.header.status`); a
working agent's row shows its own glyph with a travelling arc rather than the
chat spinner.

Session grouping and order live in the list options' **Sessions** section as
two drill-in rows, **Group by** and **Sort by**, each naming its current
choice; selecting one opens its choices in place of the menu, with a Back row
(ArrowRight/ArrowLeft drill in and back, mirrored in RTL). Built-in groupings
(`apps/web/src/sidebarPrefs.ts`): None, Date (newest day first; today draws no
heading) and Type — one type per chat, in this order: needs attention, in
progress, drafts (only a chat that never ran, so typing a draft never moves a
chat), shared with others, isolated, shared workspace. Sort: recent activity
(the default navigator order), date created, title (natural, case-insensitive)
or type. `arrangeSessions` groups then sorts before a list is paged, so the
first page holds the leading groups; pinned chats keep their own section and
order. The desktop sidebar and the phone navigator share these functions and
the `useSessionArrangementEntries` menu rows. The choice is account
presentation, synced in `core.sidebar` (`grouping`, `sessionSort`); the former
"Date groups" switch reads as the Date grouping and `showDateGroups` is still
written for older clients. Packages contribute groupings with
`host.sessions.registerGrouping({ id, label, keyOf, labelOf?, rankOf?,
subscribe? })` — pure functions of a session and the package's own state; the
host draws headings and rows. A stored package grouping waits for its package
to register and reads as None meanwhile. Chat markers add "Marker".

`session.message.actions` supplies `sessionId`, `projectId`, `spaceId`,
`kind` and `messageRole` (`user`/`assistant`), `messageId`, `messageText`, and
`eventSeq`; user messages also supply their attachment references. These are
presentation inputs, not server authorization. The host renders these
contributions inside the role's quick-action layout (`MessageActionBar`), so
the user orders them and places each on the bar, in the More menu or off.
Describe the button with `meta.messageAction` (`MessageActionSlotMeta` in
`@polyth/web-sdk`: label, description, icon, `roles`, `menu`, `available`);
without it the button is listed by its id and stays on the bar. A contribution
that sets `menu: true` must honour `MessageActionSlotContext`: with
`messageActionPlacement: "menu"` it renders no trigger, stays mounted, and acts
each time `messageActionRequest` increases (not on mount), anchoring any
popover to `messageActionAnchor()`. Render bar buttons with
`ChatActionButton` so they match the built-in actions. Sandboxed managed
message actions get this automatically from `pluginBridge.ts`. The composer supplies its existing execution context plus
`workflowDraftText`, `workflowAttachments`, `workflowBusy`, the current
`workflowModel`/`workflowHarness`/`workflowAgent` defaults, and conditional
draft consume/restore callbacks to the workflow widget. Server launch still
validates scope and attachment ownership. See [Workflow presets](workflows.md).

**Composer action discovery:** a leading `/` opens the host-owned action
catalog. It keeps one flat keyboard selection order while visually grouping
project, Space, personal, built-in, plugin, and current-agent sources. Rows
show the canonical description, command/skill identity, argument hint, and
specific provider or package provenance without turning every attribute into
a badge. A native runtime alias that replaces a portable skill fallback keeps
that skill's presentation scope. Commands, Skills, and Behavior are also
keyboard-selectable Settings destinations at the end of the catalog; Behavior
rules are applied automatically and must not be presented as runnable slash
commands. Loading, unavailable, empty, and no-match states stay distinct, and
empty/error states retain those Settings recovery destinations. `#` snippet and
`@` file suggestions share the popup chrome but their rows carry no leading
icon or provenance, so a row reserves the icon track only when it renders one.

**Built-in host actions:** a few built-in commands are host actions, not
prompts. `/compact` compacts the conversation — the active runtime's native
compaction, or Polyth's own summary-and-fresh-leg compaction when the runtime
has none — and renders the same expandable context-compacted block as the
Context rail control; it never creates a session, echoes the command, or
spends a model turn. The Compact controls (context pie, Context rail, "Compact
before proceeding") show for every agent session. While a compaction runs the
timeline shows a "Compacting conversation…" row (`CompactionProgress`, harness
package) and Send stays busy (`contextWindow.compaction.active`); a Polyth
compaction that fails after it started replaces that row with the reason until
the conversation moves on. A project/user
override or an explicitly selected native runtime command with the same name
keeps its own transport. A chat with no active session, native context, or
admitted conversation shows an immediate localized nothing-to-compact notice
without calling the runtime, and the server's matching refusal maps to the same
copy. Rules and tests live in `apps/web/src/composer/compactCommand.ts`.

**Composer draft admission:** Send clears the visible input immediately for a
prompt with an optimistic echo, while its scoped recovery draft remains staged
until admission settles. Server draft reconciliation waits for both admission
and the echo handover: a canonical message can arrive before the send response.
A send to a session outlives the composer that started it — the first send
remounts it hero-to-timeline, and a slow open remounts it again behind the
loading layer — so a session's unsettled admission is shared by every mounted
composer (`admittingSessions` in `Composer.tsx`), not held per instance. Any
mount during that window keeps the staged text out of its input, and the
created chat counts as admitting from activation, before its composer mounts.
Local autosave and lifecycle flushes also wait. A reload drops the hold, so the
staged copy is shown again for crash recovery while the admission is still
unsettled; once the turn was admitted, the server has already consumed the
matching draft, so the chat is not marked Draft and the prompt is not restored.
Boot reconciliation (`reconcileClientMutation`) also retires a local recovery
copy that only repeats the newest admitted prompt, so a killed tab cannot
replay it into the composer.
The input observer keeps the submit-time clear and any newer typing during
that wait, so a late autosave projection cannot restore the submitted text or
overwrite the next prompt. Rejected sends restore the submitted text only when
no newer input edit has taken its place; when the sending composer is gone, the
one now showing that chat takes the text back into its empty input.

**First send is detached from navigation:** once Send is pressed on a fresh
chat, create → setup (auto-approve, goal, handoff) → first prompt runs to
completion even if the user opens another chat or project meanwhile. Only a
changed connection, account or Space (`persistenceScopeIsCurrent`) aborts it;
the captured project/session name the target, not the current view. The new
chat is focused only while the user still watches its spawn surface; otherwise
it is listed and keeps working in the background. Send-pending holds are per
surface, so the chat the user moved to stays sendable; the new-chat surface's
hold stays with the composer that sent, so a fresh new chat in the same project
does not wait for the earlier creation. Pinned by
`composerSendDraftReconciliation.test.ts`.

**Running composer delivery:** while a turn is active, the terminal composer
control is one segmented pill. A sendable draft makes the primary segment
follow the configured steer/queue/interrupt preference; the default is Queue.
An empty composer makes that segment Stop. On touch devices, the primary
action is admitted on pointer-down, so a layout change cannot swallow the
first tap, and the editor keeps focus (the keyboard stays open). With a sendable draft, a chevron
segment opens explicit `Send now` and `Stop` actions through the shared
`Menu`; without one, Stop stays standalone and no menu is mounted. The split
owns the only divider and outer elevation, so the secondary
action cannot read as a separate round button; its popover pointer aligns near
the divider. The running send glyph draws its plane and badge in one SVG
viewBox, so the mark scales with the action on desktop and phone; the badge is
a single even-odd path whose plus is a real hole, so it shows the action's own
fill instead of a fixed colour that vanishes when the fill matches the ink.
The plane and fold are cut at the badge disc's edge (the plane outline closes
along the disc circle), so no stroke lies behind the hole: an uncut tip at the
disc centre shows straight through the plus and fills its middle.

**New Chat:** explicit New Chat actions automatically restore the newest unsent
text and attachments into the fresh composer. The restored draft stays in the
scoped local record across native renderer restarts, with older recovery entries
bounded to three. Returning to an existing unsaved new-chat surface through
navigation or a native reload promotes a legacy shelved entry when no newer
draft exists; newer text and intent metadata win. A page reload restores the
unsent new-chat text too: when the composer puts a stored draft back into its
input on a switch or first mount, that is a restore and is never saved as the
new chat's text (`composerNewChatReloadDraft.test.ts`). The worktree control stays
usable with the main checkout while branch/worktree choices refresh.

**New Chat Customize** (`components/mobile/HeroCustomize.tsx`): the fresh
chat's Customize panel has two entries, one per input. With a mouse, the
hero's pencil (top-right corner, accent glyph once anything differs from
default) is a customization-zone trigger (`zone-customize-trigger`): hidden at
rest and shown while Shift is held over the screen or the workspace Edit mode
is on, which also outline the tiles and let them reorder by drag; the screen
gets no zone wash. On touch, a long press anywhere on the screen
(`HeroEditMode.tsx`, 550 ms, not on text fields, cancelled by a 6 px move)
enters the **edit mode** (`heroEditing.ts`, UI state only): the click that
ends the hold is swallowed, the tiles wobble and take no taps, each gets a
hide badge (built-ins join `hidden`, board items keep their settings) and a
grip that reorders shown tiles (`useSortable`, `HeroWidgetHost`), and a
toolbar offers *Add widget* (opens the panel with Add widget folded out) and
*All settings*. The phone header's actions island becomes *Done*; other
shells put Done in the toolbar. A tap on empty space, Escape, switching
project or leaving the screen ends it. The hero's handlers ignore events
whose DOM target is outside it, since React bubbles the portaled panel's
events through the hero. The panel opens as a compact `ResponsiveOverlay` dialog (sheet on phones,
Clear screen / Reset pinned in the footer) of switch rows in two inset groups:
*On this screen* — Greeting, Shortcuts, Recent sessions, Apps (the three
built-ins reorder by dragging their grip or with arrow/Home/End keys on it,
via `useSortable.ts`; a sliders toggle folds Recent's or Apps' options out
inline) and the widgets on the account's board (`heroBoard.ts`), listed in the
same sortable list because built-ins and items share one order
(`heroOrder`; moving one also mirrors the built-ins' relative order into
`heroWidgetPrefs.order` for older clients). Only items for the project in
view are listed; copies of one widget are numbered. An item's sliders fold out
Size (its `panelSizes`), *Only in this project*, the widget's own settings
(`settingsRender`, else `SchemaWidgetSettings`), Duplicate and Remove; its
switch hides it and keeps its settings. *Add widget* at the end of the group
folds out every widget that supports `session.empty.widgets`, grouped by
package, with search above four; a non-duplicatable widget already shown
reads *Added*, and a new item opens its options; *Composer* — Project and branch (the fresh
composer's `SessionContextBar`), its Isolate switch (disabled while the row is
hidden; hiding never changes `workInIsolation`, so the project default
applies), and the composer's `composer.leading/trailing` mini-widgets.
Capability launcher widgets stay with the rail editor's one-home rule. Composer
widgets are the project's shared widget layout, and the panel says so. Phones
show an *Arrange* row instead; it closes the sheet and asks the fresh-chat
composer to enter its rail editor (`requestMobileRailEdit` in
`composer/mobileRail.ts`). Clear screen hides the greeting and every screen
widget (board items of this project included) but leaves the composer alone.
Reset restores the shipped screen (`defaultHeroWidgetPrefs`, which keeps
Recent's chosen projects; board items are hidden with their settings kept and
the board order cleared) and does not touch composer widgets. Screen choices live in `heroWidgetPrefs`
(`hidden`/`order`, `recent`, `chrome: {greeting, location, isolation}`,
`apps: {ids, labels}`) and sync with `core.hero-widgets`; a synced value
without `recent`, `chrome` or `apps` keeps local choices, and a stored order
missing a newer built-in gets it appended.

**New Chat Apps** (`builtin.hero-apps`, `components/mobile/HeroApps.tsx`):
package windows the user pins onto the screen as icon tiles (rail glyph on an
accent-tinted squircle, optional name under it) in a centred grid whose short
last row aligns to the columns. A tile opens the window through the
capability's `open()`. Candidates are `useWindowPackages()` (same set as
Shortcuts' *Package windows*); nothing is pinned by default, so the widget
renders nothing until the user picks apps. The Apps fold-out in Customize
shows pinned tiles (drag or arrow keys to reorder, × or Delete to remove), the
remaining packages as tap-to-add tiles, and a *Show names* switch. An unloaded
package keeps its place in `apps.ids` and reappears when it returns.

**New Chat Shortcuts** (`builtin.hero-starters`, model in `apps/web/src/starters.ts`):
pinned starters lead, then workspace-state suggestions; the `+` chip opens
`StarterPicker`. Besides prompts, commands and skills, the picker lists every
package that opens a window (*Package windows*: placeable, available
capabilities with a registered surface, minus Edit workspace —
`windowPackages` in `starterPackages.ts`). Their ids are `package:<capabilityId>`;
picking or tapping the pinned chip opens the window through the capability's
own `open()` instead of inserting a prompt, and the chip wears the package's
rail glyph. Package windows are never suggested, so they only appear once
pinned, and a pinned one whose package is unloaded or not relevant to the
project simply does not render until it returns.

**New Chat Recent list** (`builtin.hero-recent` in `session.empty.widgets`):
no heading and no chrome of its own. Its options live under the Recent row of
the Customize panel: count 3/5/8/12, Show
All/Active/Unread (Active = working, needs approval/reply, reconciling),
Subagent sessions (children with `parentId`, off by default because the
navigator nests them), Projects Current/All/Selected (checkbox list; picking
Selected starts from the project in view; rows from another project show its
name), and text size S/M/L relative to `--font-label`. Choices live in
`heroWidgetPrefs.recent`. Selection is the pure
`selectHeroRecentSessions` (`apps/web/src/heroRecent.ts`) over sessions in the
client store. The count sets the list's height, not its length: the rows
scroll inside it, a bottom sentinel reveals another `heroRecentPageSize` rows,
and once the cached matches run out it pages older summaries through
`useSessionSummaryPages` with `heroRecentSummaryQuery` (server-side project
narrowing only for exactly one project; status/subagent filters stay
client-side). Nothing is fetched until the cache cannot fill the next page.
A narrowed list (status filter or Selected) that matches nothing renders an
empty line; an empty default list renders nothing.

**Context liquid:** the running primary (Stop, or the Send now / queued-save
segment) is also the session's context gauge. Desktop and phone session titles
show no provider logo or context indicator (the former donut and logo modes and
their settings are gone); the session status popover/overview still reports
context percent and tokens. Chat settings
`chat.mobileSessionTitle` stores the account-synced `ui.mobileSessionTitle`
preference: `hidden` removes the title control while keeping navigation and
actions in place; `title` shows the transparent two-line title; `button`
restores the glass island with the original single-line title type role.
Missing or invalid values (including the retired `logo`) use `title`. Visible
attention cues add a leading status dot; live announcements remain
available when the control is hidden. Header clearance follows the chosen
mode and text size. `ContextLiquid` derives the session's context gauge and
renders inside the button: an outline in the action's own
solid color while the context is empty, a gently drifting liquid of that color
rising with usage, solid when full. Unknown usage stays an outline. The model
context limit still gives fresh sessions an estimated `~0%` gauge before the
selected harness reports live occupancy; an explicit unknown/compaction sample
remains unknown rather than being treated as zero. The solid
rules in `styles.css` publish `--context-liquid-tone/-ink`, so the fill follows
the same desktop/phone colors as the solid action; a copy of the glyph inside
the liquid switches the submerged part to the ink color along the wave, and
any rule that sizes the host glyph through a child combinator must also size
that copy. The level transitions through the registered `--context-fill`;
reduced-motion and low-resource modes keep a still level. The idle Send stays
solid. `contextLiquid.test.ts` measures glyph alignment and tones through the
real cascade.

**Context pie:** an open session also shows its context-window share as a
quiet pie on the model line, right after the thinking-effort chip (after the
model when it has no effort), on desktop and engaged phones. `ContextPie`
renders the same `useActiveContextGauge` value as the liquid: a thin ring with
the used slice inside, neutral below 70%, amber to 90%, red above (the session
overview meter's thresholds and tones, via `contextTone`, which also colours a
window known only as a fraction); a dashed empty ring when tokens are
observed but the window limit is unknown, and also while nothing is measured
at all (a fresh leg, a compaction, an epoch replacement, a catalog without the
window): the pie never leaves an open session, because its card is also the
way to the cache controls and compaction. It is dimmed while the last known
value of the same context awaits fresh telemetry. A new unsent chat has no
pie. Its accessible name and tooltip carry
percent and tokens; activation opens the shared `ContextUsageCard` (also used
by the session overview) in an anchored `Popover`, which is the only way to
read the numbers on touch. Below the card it says when the agent was asked to
delegate (the model's `contextPressureLevel`, from the server's context-pressure
stamp), mounts the `composer.context.details` slot (Usage fills it with the
session's cache warmth, the re-write a cooled cache costs and **Keep warm** for
30 min–8 h; see the Usage README) and, when the
harness supports compaction, a Compact button that runs the same path as
`/compact` (disabled while the session works). Focus returns to the pie on close only when the pie
held focus, so a tap while the phone editor is focused keeps the keyboard and
the engaged composer. The resting phone row keeps the pie right after Add
(the model line dissolves with `display: contents` and only the pie stays).
`packages/browser/test/hostContextPie.test.ts` measures all three placements
through the real cascade.

**Phone composer launcher rail:** `MobileComposerRail` owns a mobile-only
arrangement below the editor, using the existing composer mini-widget catalog
and direct `composer.leading`, `composer.trailing`, and `composer.execution`
contributions. Desktop continues to use its independent slot placements.
An idle composer (no focus, draft, attachment, shell mode or rail editing)
*rests* as one `--composer-height` row: Add · the context pie (when the open
session has one) · placeholder · the launcher the engaged rail shows nearest
Send (the last one of the run beside Send, else the last one of the leading
run's unscrolled part, else its first launcher besides Add) · Send/Stop. The resting row
measures the engaged lane count from the card, so both states agree before the
composer has ever been engaged. The model line and
other launchers are hidden with CSS, not unmounted, so a control in use (an
active dictation) survives engagement; only rail editing, not the rail itself,
holds the composer engaged (`composerLayoutState({ railEditing })`). A running
turn does not change either geometry. The switch between the two does not
jump: `useComposerMorph` (`apps/web/src/composerMorph.ts`) eases the card's
height on the keyboard's curve (`keyboardMotion()`) with the content held at
the card's bottom edge (`data-composer-morph`), so the rail (Add, Send) stays
put while the top edge rises with the keyboard; the dock itself rides the
keyboard on the compositor (`keyboardRide.ts`; see
`docs/dev/mobile-viewport.md`, *Following the native keyboard*). Engaging, the
editor is the one row that opens: the model line holds the rising top edge,
and the editor, its content at its own top, is uncovered downward between the
two. The model line never moves against the card's top-left corner once it
shows: until the card is tall enough to hold it there it is pushed above the
edge and transparent, then it fades in in place (on the morph's clock).
Resting is the mirror, not a swap: the hook keeps the card presented as
engaged (it returns the presented state; `composer-expanded` and the rail's
`resting` follow it) while the card shrinks to the row's height — measured by
giving the root the resting class for one synchronous read — so the editor
closes under the model line, the model line fades out in place before the
falling edge reaches it, and the row is presented (with `flushSync`, in the
morph's `finish` frame) once the card is the row's size. Presenting the row
first left it floating in a tall, empty, shrinking card with the model line
and editor gone on the first frame. Both ways the controls the row and the
rail share (Add, the resting launcher, Send) glide between their row and
rail places on the morph's clock, the rail-only launchers fade, and the
editor's first line (its placeholder) travels between the row's line and the
engaged one — the editor row stops clipping for it while the transform undoes
the row's opening or closing — so neither presentation moves anything (Send
stands ~17px further right in the row; the placeholder used to vanish and
reappear both ways). An interrupted morph hands the card's height, the model
line's opacity and each control's and the editor's place to the next one. The
morph ends exactly where the card settles: anything that sizes the engaged
rows runs first (the editor's auto-grow is a layout effect declared before the
hook), no row but the opening editor grows or shrinks with the easing height
(the editor counts at its content's size), and a row that still changes
mid-way — the keyboard re-banding the shell, a late render — re-aims the
running morph instead of snapping the card at the end. Engaged, the model/effort line stays above the editor.

The rail is two runs of `--tap` launchers, not a grid of lanes: the leading
run reads from the inline start (and scrolls horizontally when it overflows),
and the run beside Send hugs Send/Stop, which cannot be removed. The space
between them is whatever the leading run leaves. Membership and order are what
is saved, so a narrower screen, a wider Stop/split action or a launcher with
nothing to show (`isAvailable` false, which gives up its place outside
editing) never moves another launcher; a launcher put beside Send stays beside
Send. The measured lane count (`mobileRailColumns`) only picks the resting
launcher and the drop zone beside Send.

Editing works like the iOS Home Screen. There is no edit control: a 500 ms
touch hold on any launcher (`MOBILE_RAIL_HOLD_MS`; not on Send) starts it, and
the release does not also press the launcher. A mouse press never does (the mic
uses it for push-to-talk); a right click arranges straight away. Keyboard and
assistive users get a visually hidden "Edit composer buttons" button on the
model line that appears on focus; the new chat's Customize panel still asks
through `requestMobileRailEdit`. Editing blurs the editor to release the
software keyboard, makes live launchers and Send inert and wiggles every
launcher (still under any reduce-motion source: the OS preference,
`data-reduce-animations`, desktop low-resource). Each one carries a minus badge
(none for package-required controls) whose enlarged tap box grows only outward,
so the middle of a button is always the drag handle. The badges overhang the
row, so the phone rail never clips (`overflow: visible`, overriding the narrow
desktop rail's scroll) and, while editing, gains top padding and stacks above
the editor so a badge is never under the text field; a launcher with nothing
to show is drawn with its quiet catalog glyph. Dragging lifts the launcher under
the finger and reflows the others live; reaching the last lane or Send drops
it into the run beside Send, anywhere else places it by reading order in the
leading run, which wraps while editing. Arrow keys move the focused launcher
along the row and across the gap. Only the drop persists; cancellation, window
blur and unmount do not. Below the rail, as in the iOS Control Center editor,
a "More buttons" tray lists every launcher not in the rail (the rail's own
defaults first, so one just removed is in sight) as chips with the launcher's
mark (`widgetIconFor`; `capability:<id>` launchers wear that capability's mark),
its name and a green plus badge. The tray is two rows that scroll sideways
behind a fading edge, so a long catalog never pushes the rail off screen; two
chips with the same name add their widget descriptions. Tapping a chip adds the
launcher to the end of the leading run, where it settles in like an arriving
one. Under the tray, Reset (the catalog defaults, saved for this scope) and
Done; Escape or a tap anywhere outside the rail also
ends editing. Reflow and the drop settle on the shared motion duration and skip
animation for reduced-motion and low-resource modes. Holding and dragging in
one gesture is attempted (a non-passive `touchmove` keeps the touch once a
launcher is lifted), but Chromium's touch emulation still cancels it;
releasing and dragging again always works.

The arrangement is one account-owned UI preference (`core.mobile-composer-rail`
in `composer/mobileRail.ts`), a map of Space + project key to arrangement that
`settingsSync` mirrors to the server blob, so a client that has never opened
the project still inherits the buttons the user arranged elsewhere. A scope
with no record of its own shows the arrangement most recently edited in the
same Space (`readEffectiveMobileRail`) and gets its own record only once it is
edited, so a project the user has not arranged yet does not fall back to the
package defaults. Records keep the `{v:1,slots}` shape: the leading run, then
`slot:gap` and the run beside Send. A client that predates the runs reads the
gap as an unknown launcher id and keeps it, rather than stripping and pushing
back the record; positional records from such a client (`null` lanes) are
read with the last empty lane before a launcher as the start of the run beside
Send (`mobileRailFromSlots`). It never
changes desktop visibility or placement, and one project's key never touches
another's. `localStorage` (`polyth.composer.mobile-rail.v2`) is the synchronous
cache; the paired mobile app also mirrors it through the app-owned
client-context store, because its Link loopback shell starts from an empty
`localStorage` on every launch (`navigatorState.ts` hydrates it before the
first render). The older per-key `polyth.composer.mobile-rail.v1.<space>.<project>`
record is read once as a migration source and never wins over the map.
Unknown launcher ids survive package disable/re-enable; a malformed id or
unknown key from another client is dropped at the parse boundary (never read
as an empty lane). Resize changes only the presentation.
If browser storage rejects a write, editing remains usable in memory for the
current page lifetime. The editing grid scrolls vertically after three rows,
so a large arrangement stays bounded on short phone viewports. Widget
configuration continues through the existing widget service and slot renderers
retain their individual error boundaries. `MobileComposerRail.css` loads after
`composerAdaptive.css`; `mobileComposerRail.test.ts` covers the layout record,
Space/project isolation, the synced map and its hostile values, the legacy
migration, the hold gesture, mounted add/remove and pointer cancellation, and
`settingsSyncBehavior.test.ts` covers the cross-client round trip.

**Phone composer glass:** the dock is a large surface sitting directly on the
workspace wallpaper. It keeps the shared gradient-glass shape but takes a
reduced share of the user's fill, so the wallpaper reads through it instead of
the dock looking like a solid slab next to the fading timeline. The top
navigation/action islands share this rule, contour and phone edge, so the
controls over the conversation read as one family with the composer (see
[styles](styles.md) for the per-theme edge). The override repeats the composer
identity and follows the chrome glass rule in `styles.css` because the railbar
`:has()` selectors inflate that rule's specificity. `data-glass="off"` and low-resource mode
keep the opaque fallback; reduced motion keeps the selected glass material.
`packages/browser/test/hostMobileComposerPosition.test.ts`
pins both the reduced fill and the glass-off fallback.

**Phone session overview:** the session status trigger opens a full-screen
neutral mobile surface rather than a top-origin drawer. The product header owns
the safe area and close target; live/attention sessions appear under `Active`,
while chronological history appears under `Recent` with relative day labels and
clock times. The current session is selected inside `Active`, optional context
occupancy is metadata only when known, and unavailable context does not create a
section. Rows use one 20px status slot, text metadata in the second line, and
the safe-area bottom reserve; compact desktop callers may continue to use the
shared top-sheet presentation.

A dormant session with an owned runtime epoch pending after a restart belongs in
`Recent`: opening or sending to it starts the existing automatic reconciliation.
Show the neutral "Reconnect on use" status where detail is useful, rather than
an attention warning on every historical session. A borrowed or unclassified
runtime identity break remains "Runtime changed" because it can require user
confirmation or further diagnosis. A failed planned harness transition also
keeps its warning.

A session stopped by a provider limit/quota with a pending server-owned resume
(`SessionProjection.resume`) resolves to `rate-limited`, not `failed`: an amber
Lucide `Timer` mark and "Resumes after limit" in the sidebar, phone navigator,
island and session header, and its own calm amber project pill instead of the
red error count. Attention and live work still outrank it; once the resend
starts or the wait is cancelled, the session shows its real state again.
The navigator's summary projection carries `resume`, `runtimeControl` and
`harnessTransition`, so every one of these marks is correct on the row before
the session is opened instead of flipping once its full projection loads.

The same pause covers a provider that refuses the request itself (`4xx invalid
request`, `RateLimitScope: "request"`). That refusal is usually about the one
call, not the conversation, so the server retries it on a short backoff ladder
and stops after `REQUEST_RETRY_MAX_ATTEMPTS` auto-resends: the durable
`SessionProjection.autoRetry` budget is keyed to the prompt the chain replays,
so it counts real resends across the hidden auto-resume messages that
`turn/started` otherwise clears. Its row reads "Auto-retrying", and the
timeline's inline recovery notice (same quiet-glass surface as a limit stop)
names the refusal with the provider's own error text in the heading
(`{provider} refused this request`, the error on its own meta-size line under
it, the template's separator dropped;
"retrying" only when the stop carried no error), shows `attempt n of m` and a
slim progress rail instead of a countdown only. Once the budget is spent the stop settles as an ordinary
failure — the generic failed-turn notice with its explicit retry — so a
persistent rejection can never loop resends. Provider capacity stops keep
their unbounded wait policy.

When the runtime reports the `compaction` capability, an auto-resumable notice
also offers **Compact before proceeding**: a quiet whole-pill switch in the
notice's top-end corner above the recovery buttons, with its explanation in a
tooltip and as the switch's accessible description. On phones (≤640px) it is a
full-width settings row (label at the start, switch at the end) above a
two-column grid: Resume now / Cancel wait share one row, the model picker takes
the next. There the warning glyph moves to the top-end corner beside the
heading, so the copy, switch row and buttons share one start edge. The choice is stored on the server
plan (`SessionResumeState.compactFirst`, set via `setResumeCompact` /
`POST /api/sessions/:id/resume/compact`), so the timer honours it with no
client open. Before the resend (timer or **Resume now**), the server runs the
same native compaction as `/compact` and waits for it to end — including a
native compaction that finishes in the background — before it resends, so the
resend never queues behind it (a `failed` session would never dispatch that
queue). **Resume now** with compaction answers once it is under way; the
timeline's "Compacting…" row carries progress. When the native compaction is rejected, fails or never reports an end,
the server falls back to Polyth's own compaction with the **configured small
model first** (the session's model is the one out of quota); a runtime without
native compaction takes that path directly. The flag is cleared before
compaction runs, so a retried resend never compacts twice. Compaction only
saves tokens: if both fail, the failure is logged and the resend still runs. A
harness switch skips it, because the old runtime's context is not the one that
continues. The automatic resend of a `failed` session runs ahead of messages
queued behind the stopped turn; the idle session then drains them.

**Fresh-turn anchor:** a submitted prompt reserves the distance from the
timeline's focus line (50% of the visible reading area) to the visible bottom,
less the tail clearance (the surface's `scroll-padding-bottom`), and aligns the
prompt's bottom onto that line. The reserve exists only while a turn is live.
Every row of the live turn (action block, thought, answer, marker) then fills
DOWN: the rows the reader sees stay still while new ones land under the tail,
in the blank below the prompt, and only once the tail reaches the composer edge
does the view follow that edge (a lift for a discrete arrival, plain follow for
streamed growth). Nothing is lifted onto a line mid-screen, so the tail never
waits there above blank for the turn to end and drop back down. A card below
the tail (an approval or secret request in `session.timeline.after`) takes its
height out of the reserve in the same measure: it hangs from the tail toward
the composer, and when it does not fit (a short viewport, the on-screen
keyboard open) its bottom rests on the composer edge, so its actions never
park mid-screen; when it is answered, the rows it pushed up glide back to where
they were before it (at most its own height; below-tail content shorter than
2 px is layout rounding, not a card), and a card that fit moved nothing to undo. A session
opened mid-turn lands with its tail on the composer edge, the reserve below the
view. When the turn ends, its reserve is handed over in place after a short
beat (~150 ms, so late footers and the final status land first): nothing
moves. Blank the turn left under a short answer becomes a held floor at the
reader's position (`heldTailScroll`); it is released only once nobody can see
it — content grows over it, the reader scrolls away from it (trimmed when the
scroll rests), or a send, Jump to latest or session switch resets it. A new
turn (send, queue, steer, auto-resume) inside the beat cancels the handover.
A finger that scrolled owns the scroll from touchstart until its momentum has
come to rest (no scroll event for 150 ms after the finger lifts): no follow
write, sheet resize or handover runs in between, because touch WebKit stops a
momentum glide dead (or blanks the scroller, before Safari 27) on a scroll
write. A tap moved nothing and releases at once, so its own layout change (a
card answered under the finger) is followed like any other. The document hears
the gesture's end too: the touched node can unmount mid-gesture. A turn that
starts without a visible prompt (a hidden resend, a resume, a server wake)
inherits the blank the previous turn held, so no row drops. Every
lift starts from the pixels the reader last saw: the follow
engine records the layout of each write, so content that changed above the
visible rows before the next refresh (prepended history, late layout, a browser
clamp) moves nothing by itself. Layout that moves the whole transcript from
above — a long session's suffix window (`timelineWindow.ts`) unmounting its
oldest row as each new one arrives, history landing above, late layout far up —
is measured by the reader anchor (the row at the top of the reading area, by
layout offset) and shifts the held geometry with it (`foldLayoutShift`: extent
high water, painted layout, a held tail position). It is never
held as blank below the tail. Rows arriving below the tail rise from where
they were inserted (directly under the last row the reader saw, even when that
row is still travelling), and a fresh
mount or session switch lands at rest without a glide. A lift moves only the
rows whose path crosses the reading area — a row that starts and ends outside
it on the same side lands at once — so no row appears at its final place
across rows that are still moving, while touch WebKit is never asked for more
compositing layers than the glide shows; no `will-change` is written for it.
Follow targets and the extent floor use the in-flow tail height; temporary
transform overflow must never ratchet the scroll extent. The extent ratchet
keeps fractional layout measurements and follows its held position, rather than
the rounded-up spacer end, so spacer rounding does not introduce pixel jitter. A lift that starts
mid-glide supersedes it row by row, and a row that
entered in the same commit keeps only an opacity fade, never two transforms —
whichever starts first (`timelineLiftOwns` in chatMotion's entrance).
The lift measures its travel after the entrance releases its transform, so a
remaining entrance offset cannot shift the first lift frame.
On send, the user bubble rises from the composer seam while previous rows
keep their visual continuity. The existing send profile (360ms desktop, 420ms
touch) has no overshoot. Admission retargets the running send animation from
the optimistic echo to its canonical row without restarting the clock. The
`chat-send-flight` tag bounds geometry suppression while the prompt lands.
A queued prompt that enters the chat (steer from its row, empty-composer
promotion, or server dispatch) is never shown in both places: its row leaves
the queue in the same commit its echo or `user/message` (stamped with its
`queueId`) lands in the timeline, not after the runtime confirms admission and
the queue is re-read (`departedQueueIds`, `launchingId` in
`QueuedMessageList`). A refused admission (`turn/failed` without
`queue/dispatched`) or a failed promotion brings the row back from the next
read. A row that the server queued because the session's runtime could not be
recovered (`delivery/fallback-queued` with `runtime-recovery-unavailable`,
`reconciliation-blocked`/`-unknown`, `session-epoch-pending`/`-unknown`) does
not drain by itself, so the list leads with a status row that says so and
offers Resume, which promotes the oldest waiting row and retries the recovery
(`queueStalledOnRecovery`). Reasons that clear alone (a running turn, a pending
answer) show nothing. The leaving row folds in place — a 120 ms fade with a 6 px lift, its slot
closing over 220 ms — and the prompt row takes the same `chat-send-flight`
from the chip's position (`queueLaunchMotion.ts`). Reduced motion removes the
row at once with no flight.
An optimistic echo handing over to its canonical row preserves manual reader
detachment; status updates to the same pending send do not restart following.
The existing agent activity block owns waiting feedback; no separate loading
message is added to the transcript. Answers and reasoning
render incoming provider chunks immediately, without a client-side typewriter. Any transcript — short or overflowing — keeps its
current reading position at completion, without a downward glide or a growing
top runway. Its live reserve is removed, but where that reserve is still in
view, the extent floor retains exactly enough space to prevent the browser
from clamping the scroll, including when the working-status dock leaves and the
scrollport grows in the completion commit. Idle layout refreshes preserve this
position; content growing over the blank, the reader scrolling away from it, a
new send, session switch or explicit Jump to latest clears the hold. A newly opened short chat starts naturally at the top. The
mounted regression checks are in `apps/web/test/timelineMotion.test.ts`; the
overflowing-chat Chromium gate is `apps/web/test/timelineMotion.live.ts`. On phones
the floating session island covers the top of the
timeline scrollport. Its CSS clearance (`--timeline-pad-top`) also publishes
`--timeline-visible-top-inset`; fresh-turn alignment, send and tail-lift motion,
row entrances, and `scrollIntoView` use the area below that inset. The short
keyboard band keeps this clearance while its smaller visual viewport reduces
the available reading height. That phone mask ramps back down across one
fixed reading gap (`--timeline-fade-bottom`, message + group gap, 40 px at
default density), so a row leaving the scrollport toward the composer
dissolves instead of clipping against a hard line. It deliberately does not
follow `--timeline-pad-bottom`: that includes the JS turn-sheet runway, which
can cover most of the viewport and would fade text from mid-screen. The composer dock is a
normal-flow sibling and already defines the visible lower edge. Keep these
boundaries together when changing phone chrome or chat motion.

In the wide shell the idle launcher strip (and the tablet band's cluster)
floats over the workspace's inline-end edge, where the timeline scrollport's
scrollbar would otherwise sit under it. `timelineStripLane.ts` measures how far
the idle strip reaches into the scrollport, plus the shell's column gap, and
publishes it as `--timeline-strip-lane` (a non-inherited `@property`) on
`.timeline`. It becomes a transparent `border-inline-end`, inside which the
scrollbar sits, so the scrollbar stops a column gap before the strip; the
inline-end padding gives the same width back, so the reading column keeps its
place, centred on the whole workspace. An open pane (in flow, or a package
window laid over Chat on purpose) never moves it, and a scrollport that does
not reach the strip (a split pane, a mirrored shell) gets no lane. Pinned by
`apps/web/test/timelineStripLane.test.ts`.

**First-send surface handoff:** a prompt submitted from the fresh-session hero
replaces that surface with the transcript in one commit. The hero holds on
screen for one motion beat with `data-leaving` — its body fades to the composer
edge while the composer itself stays put — then the transcript mounts with
`data-first-send`. That attribute keeps the arriving `timeline-wrap` and
composer dock opaque instead of fading up from blank, and suppresses the
session reveal for the id the spawn produced so it does not replay mid-handoff.
The submitted prompt keeps the normal composer→timeline flight, and a replaced
status dock is a text handover rather than a fresh entrance, so a short turn
cannot blink back to "Spawning agent…". The suppression is bound to the spawn
request and resulting session and is cleared by the next session switch; a
recent send can therefore never animate another chat's mounted history.
Reduced motion skips the hold and still suppresses the blank fade. Pinned by
`apps/web/test/firstSendHandoff.test.ts` and the self-booting
`apps/web/test/firstSendHandoff.live.ts` geometry gate.

**Open questions:** a pending agent question is a row of the conversation at
the point it was asked (`QuestionCards.tsx`, rendered by `Timeline`), not a dock
between the timeline and the composer. It lives in the one timeline scrollport
at its full height — no internal scroll box or height cap — and its action
footer is `position: sticky` to the scrollport's bottom edge while any part of
the card is in view. Like a pending approval it is a trailing card, not a lift
row (`TIMELINE_LIFT_ROW_SELECTOR` excludes `.question-open`): it hangs from the
tail toward the composer, and a question taller than the reading area
opens once at its start (the reader is detached from the tail, so Jump to latest
appears, lifted clear of the sticky footer). Sending shows progress on the
pressed button and a failed send stays in the card as an inline error;
Cmd/Ctrl+Enter moves to the next step or submits. Choosing "Other" reveals its
text field; a ticked-but-empty Other is neither a valid answer nor sent.

**Answered questions:** the open stepper owns a pending question only. Once
answered, declined or expired, the same row hands over to the record: the
question stays in the conversation where it was asked (`QuestionRecord.tsx`): a quiet
card at the response edge, then the answer as the person's own bubble with the
user-message action layout (copy, Revert & edit). It splits activity like a
prompt. Revert & edit on an answer cuts from the answer onward — the question
keeps its row, says the answer was reverted, and the composer receives each
question quoted above its answer to edit and send as the replacement turn.
Declined questions and a subagent's mirrored question offer no revert; Fork is
not offered because a mid-turn prefix has no exact native branch point.

**Rewind cut and replacement:** an active Revert & edit is represented by one
quiet cut marker at the end of the retained prefix. It does not count or narrate
the hidden branch; the branch appears only through an explicit peek, and a still
running old turn is represented by the existing activity dock rather than a
second transcript row. Submitting the replacement removes the cut marker and
mounts the optimistic prompt in the same commit, so the established composer →
prompt send motion is the only prompt flight. Reverting is model-driven: the
click fades and moves nothing; the confirmed marker (WS or request, whichever
lands first) keeps the cut rows in their slots — same DOM, no remount — for one
220 ms exit; one commit then removes them while the survivors glide to the
composer edge (280 ms, downward allowed); only then do the cut marker and the
restored draft appear. With motion off the confirming commit is the whole
change. Restore and regenerate use the same bounded reflow — canonical scroll
first, then surviving rows retain their pixels and new rows fade in — and
there is no cloned bubble, pulsing pending prompt, decorative composer ring, or
staggered sequence. Same-harness runtime-leg bookkeeping stays invisible; an
actual cross-harness continuation gets one compact `from → to` timeline divider.
Native harness compaction is also a durable package timeline event: it renders
as a localized, full-width `Context compacted` message with the shared short
time formatter. The whole header is a disclosure button; its body mounts only
while open and shows what carried over — the harness's own summary under a
`Summary` label when the event has one (headings kept at card scale, never
styled as assistant prose), otherwise a one-line note, then up to six clipped
visible messages from before the marker. `Start new chat from here` opens a
new chat in the same project whose editable draft names the source session
and repeats that summary, the active pins and those messages; nothing is sent
until the user sends it. Package timeline events inside a rewound range remain
hidden with that branch.

**Action grouping and Thinking separators:** Chat settings exposes matching
segmented selectors for Action blocks and Thinking blocks. Grouped mode projects
tool/task work into activity cards. A card's header is named by the actions
inside it (`activityTitle.ts`): up to three of the most significant kinds
(changes, tests, commands, delegation, then reads, searches, web, tools,
tasks), told in the order they first happened, with file kinds counting
distinct paths — "Read 4 files, edited 2 files, ran tests". A card with only
reasoning reads "Reasoning"; the generic "Activity" remains only for an empty
one. The toggle's accessible name carries the same title. At ≤620px the
meta drops its step/file counts (`.activity-summary-counts`) and keeps the
duration, so the title gets the row. Ungrouped mode returns each action to its
own timeline row and therefore removes the activity-only Thinking mode, falling
back to collapsed if it was selected. Standalone tool rows share the same
tail lift and reader anchoring as grouped actions and messages. Changing the
Thinking preference preserves unchanged message/action identities and open
action details; only the Thinking disclosure resets. In grouped mode,
collapsed/expanded reasoning remains a standalone quiet row between activity
cards. Its compact preview uses one line for short thoughts and up to two for longer ones.
Opening replaces the clamped preview with the whole thought from its first
word: the first line lands exactly where the preview's stood, beside the
chevron, which shrinks into the same corner; the row grows from the folded
header's height without fading or sliding the text already on screen, so the
clamp seems to lift and nothing the clamp hid is skipped or repeated.
Thoughts with two lines or fewer are static:
no ellipsis, chevron, or expand control. A long single-line thought still gets a
disclosure. A reader-opened thought stays open when its row remounts (render
window, live tail folding); changing the Thinking preference folds them all.
Activity mode keeps the thought inside the surrounding technical
card and hides it when no technical work exists. The Expanded preference shows
the entire thought in the timeline's normal scroll flow, without a height cap
or nested vertical scrolling, in both grouped and ungrouped modes and on narrow
screens. A manually opened collapsed disclosure retains its bounded scrolling
well, whose lower edge fades while more text waits below (scroll-driven, where
supported). Both use the same prose type and dim color as the header; the
disclosure uses the shared motion/reduced-motion contract.

**Activity block look:** an activity group is a column of text, not a card:
no plate, border, shadow or glass in any appearance or resource mode. Its
summary and steps start on the prose edge, and hover bands bleed
`--activity-bleed` into the gutter. One 1px thread (`--borderless-edge`, so it
survives Borderless appearance) drops from the summary's state mark and
carries the steps of an open block, warming toward the accent while the turn
runs. Steps are separated by rhythm alone (34 px rows,
`--hit-min` on touch). A finished step shows its duration but no tick, since
the block's own mark says done; failures and running steps keep their glyph.
The summary title (weight 500) never truncates; its counts give way first.
An open summary pins to the top while its steps scroll. It does so only where
`container-type: scroll-state` exists, and it takes the readable glass only
while `scroll-state(stuck: top)` holds. Elsewhere it stays in flow rather than
sitting bare on the steps. The inline command Stop is a red outline with no
fill.

**The live line:** a block is one row, live or not. While it is the tail of a
working turn (nothing follows it yet), its summary line names the step in
progress — the step's glyph, its name and quiet preview, exactly as the folded
step reads (`ActivityTicker.tsx`, `activityTicker.ts`). Each new step takes
the line's place in it: the old words rise away as the new ones rise in, in one
grid cell, transform and opacity only, so the block never adds, removes or
resizes a row while it works (the leaving words are out of flow, so a look whose
pill hugs its line resizes once per step). Every line stays at least one dwell
(900 ms) before the next may replace it — with motion off too — and a burst
skips straight to its newest step instead of queueing a backlog; once anything
follows the block or the turn ends, the line settles on the summary the same
way. Task lifecycle never takes the line (the title and overview own it).
Nothing after the block waits for it: the next thought, answer or block renders
the moment it arrives. Everything that describes the line follows the words on
screen, not the newest event: the block's accessible name always contains the
visible line, and a command the line names gets its Stop beside the line
(outside its button) only once it has run for 700 ms, so short steps never
flash it; an open block shows the step's own Stop instead, a delegated agent is
stopped from its session, and a Stop that leaves while focused hands focus to
the line. Lines are never a touch target. Reduced motion, the low-resource
profile and a hidden tab change the words in place (a hidden tab without the
dwell). A task row inside the block reads like a step: its mark in the icon
column, the task text in the step-name voice, then its kind (`Task
completed`, …) in the quiet preview voice, which gives way first on a narrow
line. The contract is pinned in `apps/web/test/executionUi.test.ts`.

**Activity block looks:** Chat settings → *Activity block style*
(`UiSettings.activityBlockStyle`, published as `body[data-activity-style]`)
picks how the steps are held together. Everything above is the default
`thread`. The others keep the same rows, rhythm and plate-free column and drop
the thread and its fold flash:

- `ledger` — the summary line runs on into a hairline, and steps sit under the
  state mark, ruled from one another by hairlines;
- `chip` — the summary is an outlined pill that hugs its words (accent while
  the turn runs), and the steps sit under it without lines;
- `margin` — where the conversation frame leaves a gutter (wider than 960 px
  and not a short touch screen, so the frame pads by at least `--gutter`),
  the icons hang in it and every word starts on the prose edge. In a narrower
  frame the icons come back into the line: the thread look without the
  thread.

Every outline is a `--borderless-edge` shadow or background, never a border,
so Borderless keeps it. The look is pure body-level CSS, so switching it
restyles every block already in the transcript without a re-render.

**Status above the composer:** the live agent status (`AgentStatusDock`, also
used for the spawn status and on the Agents page) and the git package's edited
files (`PendingChangesBar`) are lines of text, not cards: no plate, shadow or
glass. The status reads mark · model · action, then the files tally and the
elapsed time. Light moving through the action's words and an accent dot on the
mark say "live"; reduced motion and low-resource mode keep the words still.
The action outranks the rest: the model name gives way first, and at 600 px or
less the files tally steps aside. Folded, the edited files are one summary
line whose title carries the count. Open, the files hang from the same thread
as activity steps, and Undo / Review are text actions (Review in the
text-safe `--chat-ink-accent`). Their quiet inks follow the wallpaper wash
([styles](styles.md), "Wallpaper wash"), so they keep 4.5:1 on any preset
theme and wallpaper.
Chat settings → *Status above the composer* (`composerStatusStyle`,
`body[data-composer-status-style]`) picks `line` (the base), `tab` (a faint
tab growing out of the composer's top edge, inset from its corners, further
in on a phone's pill composer; the composer drops its top padding under it)
or `capsule` (a centred hairline pill that hugs its words; the open file list
sits in a hairline frame). Pinned in `apps/web/test/composerChatStyle.test.ts`
and `packages/git/test/sourceControlVisualGrammar.test.ts`.

**A watched pull request above the composer:** while the chat watches a pull
request (see the `github` row in [architecture](architecture.md)), the GitHub
package's `session.composer.before` contribution (`ChangeRequestWatchLine`,
shared from `@polyth/code-hosting/widgets`) is one more line in the same
grammar, on the same chat frame as the agent status line: the pull request
mark (an accent dot while checks run), `PR #n`, a 36 px hairline bar of the
head commit's checks (passed `--green`, failed `--red`, running accent, not
started a hairline), the state words, and a text **Stop** (44 px on touch).
The words are runs that keep their own ink: the failure count in `--red`, the
failing checks' names in `--text-dim`, what still runs neutral; else *All
checks passed* (`--green`), *Wakes after this turn* or *Retrying the check*
(`--amber`). The line is an `inline-size` container: at 560 px or less the
count of comments held back from outside accounts steps aside, at 480 px or
less the abbreviation (`#n` stays), the names and the running count (the bar
still shows it) do too, so a phone reads `#128 ▬ 1 failed · Stop`. Pressing
the reference and state opens the pull request in Polyth's own GitHub view
(`requestChangeRequestOpen` + `openWorkspacePane`; the browser only without
that surface). The line enters and leaves through the host's
`ComposerNoticeRow`, so starting or stopping a watch folds instead of popping
the composer. The watch's moments are timeline facts (`ChangeRequestWatchEvent`):
a centred line between hairlines for started and ended (a merged pull request's
mark in `--purple`), and a wake with a chevron that opens into its evidence:
failed checks with their log links, comments as `@author path:line` with the
first line of what they said (two-line clamp; only trusted comments ever reach
the event), the commit and wake count, and *Open PR #n* (in Polyth). On a
narrow column the words wrap under the title instead of being cut. Only
`https:` links render. The PR view's action row adds a *Watch in this chat*
switch when the provider declares `watch` and a chat is open; its name never
changes, `aria-pressed` and the accent wash with a dot say it is on.

**Subagents above the composer:** while any delegated child of the open chat
works, waits for a person or is paused, its subagents hang from the agent's own status
line: one island (`.subagent-island`, `SubagentActivityDock.tsx`) holds the
line and, on a 1px thread dropped from the line's mark like the activity
block's, the branch. `SubagentBranchScope` wraps the composer's status zone
(the `session.footer` slot, the startup dock and the host's live dock in
`builtinSurfaces.tsx`), and whichever status line shows there hangs the
branch: the git package's live dock, the host's live dock or the startup dock
(`SubagentBranchIsland`). A status line placed anywhere else stays one line.
Once the agent ends its turn the island keeps an idle line of its own
(`AgentStatusDock` `idle`: no live dot, no light through the words) that reads
*Waiting for subagents* (*Subagents paused* when only paused ones are left),
so a parent that handed work off never looks idle.

The branch is the list itself, shown at once: no head row, no fold and no
*Stop all*. Each active or paused subagent is a row on the thread, waiting
ones first, then the rest in delegation order (a pause keeps its place, so the
row the person acted on never jumps), with its state mark (running ring, reply
question, approval shield, or `PausedMark`: the ring at rest with a pause
sign), title, then its ask or action (*Paused*), run time, model (the parent's
when inherited) and *Nested: n* for active subagents of its own. The thread
leaves the line's mark and runs into the first row. A row opens its chat; its
media controls sit in one column set: Pause (only on a row whose own turn
runs) or **Continue** (▶, accent wash), Stop (■, red under the pointer), then
the chevron — solid glyphs like the composer's Stop, shown on the hovered or
focused row and always on touch screens and paused rows; on touch, adjacent
glyph buttons keep their 44px targets apart. Pause interrupts the turn but
keeps the work open (`SessionService.pause`, `projection.paused`); Continue
runs a hidden continuation turn on the same history; Stop on a paused row ends
the work. Both show their outcome at the click (*Pausing…* / *Continuing…*,
the other control disabled) until the child's projection confirms it or the
request fails. The paused chat itself ends in one quiet status line — the
paused mark, *Paused*, **▶ Continue** and ■ — that rises in as the pause lands
(`PausedNotice` in `Timeline.tsx`); writing to the chat also continues it.
A row waiting for a person shows its ask in amber with **Allow** /
**Deny**, the zone's only primary: they answer the child's request mirrored
into the parent's log (`sourceSessionId`; the server forwards the answer), the
same reply the permission card sends; the ask leaves at the click and a failed
reply brings it back. A high-risk request, a guarded account, a question or a
nested subagent's wait offer **Review** instead, which opens that child chat:
nothing risky is allowed from one line. Past four rows the list ends in *+n
more*, which shows the rest. The action and run time never push the model
out: the action gives way first.

Motion, only after the list's first paint and none under reduced motion: a
state change swaps the mark (it grows in) and the control set (fades in) in
place while the mark's colour eases; a subagent that arrives rises in
(opacity + 4px, composited); one that ends is held as an inert ghost with its
last words and folds from its measured height to zero while it fades
(`useLeavingRows`, `--motion-surface`), so the rows below slide up instead of
jumping.

A working child's action comes from an OpenCode task snapshot or, for the
listed rows, from a passive read of the newest 40 events of its own log
(`prefetch=1`, so no runtime is woken) every 4 s while the tab is visible,
named by the same `liveAction.ts` as the agent's own line. In a container of
520 px or less (a phone) a waiting row takes its decision onto a line of its
own, rows drop the chevron (the row itself opens the chat) and a running row
leaves the model out so its action and time stay readable. The agent's own
logo wears its harness profile's color, as the composer's model chip does.
In the Standard look the island is text on the canvas; the other looks
give it their in-flow card (the line inside keeps none), and the Tab and
Capsule status styles frame the whole island. State
comes from the canonical child projections (`parentId`) rolled up through
grandchildren (`apps/web/src/subagentActivity.ts`), the same source as the
navigator's disclosure pill. Pinned in `apps/web/test/subagentBranch.test.ts`.

**MCP tool rows:** every harness's MCP naming (`mcp__server__tool`,
OpenCode `server_tool`, Antigravity `call_mcp_tool`/`mcp_server_tool`, Codex's
bare tool plus `server` input) is folded into one call by
`apps/web/src/toolCallView.ts` before classification, so a wrapped
`agent.spawn` is still a Subagent and a wrapped `polyth_browser` still a
Browser action. Polyth's own tools read as what they did ("Plan", "Message
session", "Web search", "Saved to memory") with a human preview; another
server's row is titled by its brand ("GitHub", "MemPalace") with action and
target in the preview. Expanded, `ToolCallDetail.tsx` shows the carried text
(a message sent, a memory saved), then result blocks — a todo checklist with
progress, result lists, a session card that opens the session, plain fields
or clamped text — then remaining request fields in words. Transport fields
(`ServerName`, raw ids, bookkeeping such as digests and revisions) never
render; the raw call stays behind "View raw result". Native todo tools and
`polyth_todo` share the `@polyth/todos` normalizer and the same checklist.

**Session activity details:** the Chat settings row `chat.activityDetails`
controls the reusable details surface opened from the agent activity dock and
session status. `tabs` (the default) exposes Usage & cost and Plan & review as
keyboard-accessible tabs with horizontal swipe switching only on tab content;
`all` renders
both panels together and lets the containing popover or sheet own vertical
scrolling. The dock opens details on wide, compact, and phone layouts; the
header opens the full session overview on compact and phone layouts.
The details sheet gives the session title the full content width, with up to two
lines at the largest size that fits between the title and label type roles.
It refits when its width, title, UI font, or text preferences change; titles
that still exceed two lines at the readable floor are clamped. The sheet keeps
its accessible overview name and close target, without repeating overview,
activity-detail, or status labels beside the title. Its height follows the
visible viewport with a bottom safe-area reserve, and the body scrolls to
Recent when needed.

Figures (context, usage) keep their tiles. The latest request and the task plan
read as text, aligned with the tiles' copy. The plan's steps hang from the same
`--borderless-edge` thread as chat activity, and the step in progress lights
its stretch in accent. A failure is told by its mark, not by red words.

On wide desktop the overview popover is as wide as the chat column of the
window it opens from: the conversation holding the opener (the status dock),
else the chat under the header title. `DesktopSessionStatus` measures the
timeline's content box into `--session-status-column`; 360px is the floor and
the width with no chat on screen. Sections reflow by container width, never
the viewport: from 540px the figures go four across, from 720px the context
card stands beside them, and from 560px the sharing line joins the title row.
The request and the plan stay one column, so a short request never leaves a
hole beside a long plan.

The surface reads the live render model for context, token usage, separate cache
reads/writes, cost, ChatMetrics-compatible session duration, and task-plan
progress. The content panel labels the cached last user message as a latest
request excerpt, never as an agent-authored summary. Missing usage samples
display unavailable values rather than invented zeroes; reported zero remains
zero. The shared duration helper caches message bounds by array and model
version together with message counts, so live one-second ticks do not rescan
the session. Native/derived context fractions remain visible even without a
reported token limit. An estimated token sample keeps its `~` marker and uses
the shared localized short-number formatter when the window limit is unknown;
the same localized context copy is used by the activity card and compact
context indicators. There is no second session data path.

**Live activity handoff:** a step changes its block's line in place (see *The
live line*), so a step never folds out of the transcript. While the reader follows the tail,
anything else that shrinks at the tail does not shrink the scroller: a high-water extent floor
(`--timeline-extent-floor`, capped at half a viewport of held blank space, and
on top of the blank a live turn already keeps below its tail never so much that
the tail rises into the top quarter of the reading area) keeps
the geometry and is released explicitly, through the canonical-scroll-then-FLIP
path when the shrink outgrows that cap, handed over in place when the turn ends,
or dropped when a new prompt establishes its own reading anchor. The floor holds
only transcript rows: content below the last row (an approval or secret card in
`session.timeline.after`) is never held, so when it leaves the rows it pushed up
glide back down instead of leaving the viewport blank until the next row
arrives. While such a card does not fit under the tail, no floor is held below
it either: the held blank glides out so the card stays on the composer edge. Outside a live turn the follow engine animates no
shrink and lifts only discrete steps of 24 px or more, so a card that can
change size while idle animates its own box instead: the git isolation card
(`packages/git/widgets/isolationCardMotion.ts`) grows in, morphs between its
states and collapses out (gap included) in small per-frame steps the tail follow
renders as a glide, never measuring itself at a smaller size, which would clamp
`scrollTop` for a frame. After a merge it shows the merged state for a beat,
then collapses while the transcript notice takes over; the mounted contract is
`packages/git/test/isolationCardPresence.test.ts`. The card does not wait for
`GET /api/isolation/:id` when the client already knows the answer: a
merge-ready, resting projection is the server's own verdict from the end of
the turn, so "Changes ready" shows in the commit that delivers it (the server
re-checks everything when Merge is pressed), and a session's last answer for
the same isolation state and working/resting phase is kept in a bounded
in-memory cache keyed by connection, account, Space, project and session, so
returning to a session shows its card at once while a fresh read confirms it.
An answer never shows for another session, a 4xx answer is never overridden by
the projection, and a parent that hosts delegated isolations waits for the
server (only it knows whether they block Merge). Pressing Integrate shows the
integrating steps at once: the server persists its first phase (`publishing`)
only after snapshotting the workspace and building the merge, seconds on a busy
host, so the card's own merge request stands for that phase until the server's
answer or a refusal returns it to the ready card. While the agent works the
status is read once, not on every projection update of the turn. A read that
fails in transit (a phone's
Link connection still returning after resume outlasts the shared ~4 s read
retry, or a busy repository answers 5xx) keeps the status
already held for that session and retries with the package loader's backoff
(1 s, 3 s, 10 s, 30 s, then every 60 s) and at once on foreground, `pageshow`
and `online`; a 4xx is final. On the server the read uses the indexed newest
`turn/stopped` fact instead of loading the session's whole log, and runs its
independent Git reads together; the latency contract is
`packages/git/test/isolationCardLatency.test.ts`. An idle read keeps only the
held tail position described above. While a turn is in progress, answers
already closed by a later prompt keep their response footer's box but render it
dormant (`data-dormant`, invisible); removing those footers reflowed the whole
transcript at every send and again at turn end. The identity panel is one per
turn (its terminal answer), but every finished answer keeps its quick actions:
an interim answer that tools, an answered question or more prose of the same
turn follow gets an actions-only footer (`data-actions-only`). In the live turn
an interim answer takes that footer's (dormant) box the moment a row lands
under it, while it is the tail's neighbour; added at turn end instead, every
footer in view pushed the rows below it down at once. On touch
(`(hover: none), (pointer: coarse)`) actions-only footers are not shown: a
row of quick actions under every interim answer doubled the activity gaps;
the turn's final answer keeps its footer. With a mouse, over a block that
footer *is* the group gap (no top margin, a negative bottom margin of
`--conversation-group-gap`). On phones prose, thoughts and blocks share one
gap (`--conversation-group-gap` = `--timeline-gap`, 12px); touch block rows
keep a 44px hit box but lay out as 36px (`--activity-row-trim` pulls the
block into the gaps around it), and consecutive blocks' hit boxes meet
(`--space-1` apart with a mouse). A thought row keeps prose's ink gap (group
gap less its header pad). A progress update (an
interim answer followed by a block) only quiets its ink; new type metrics would
reflow the lines right above the block that just arrived. The overflowing think
→ act cadence (thoughts between blocks, a burst, interim prose, a straggler) is
the `never bounces` case of `timelineMotion.live.ts`: no visible row moves down
while the turn is live, and the first case pins that none moves as it ends. Composer/status dock mutations share the timeline's geometry
refresh before paint, so a dock height change cannot expose a native scroll
clamp for one frame before the resize observer restores the live extent. The
same refresh retains manual reader and active-touch ownership. Because every
dock mutation costs a synchronous transcript refresh, the per-keystroke path
mutates nothing unless the editor's height really changes: auto-grow measures
on an inert twin of the editor (`apps/web/src/composerAutoGrow.ts`) and writes
`style.height` only on a new value, `AdaptiveTextInput` keeps its mount-time
`defaultValue` (a live one made React rewrite the textarea's text child on
each key), and the hidden file input is memoized so React does not re-apply its
attributes. The tail geometry the transcript writes on `.timeline`
(`--timeline-turn-sheet-space`, `--timeline-extent-floor`) is registered
non-inherited, so a write during streaming restyles the two spacers that read
it rather than every row; see [selector performance](styles.md#selector-performance).

**When to add a new slot (host work):** only when no existing `UiSlot`
expresses the injection point, and the point is genuinely reusable (more than
one contributor plausible). Adding one end-to-end:

1. Add the name to `UI_SLOTS` in `packages/contracts/src/index.ts` (types +
   runtime value; find every `UiSlot` consumer — grep `@polyth/contracts`).
2. Mount `SlotHost slot="your.slot"` at the injection point in the owning
   host component (`apps/web/src/components/…`).
3. Contribute through `host.slots.register` from the feature package — never
   import the feature component into the host.

New slots are a public-contract change: update consumers and tests
(`apps/web/test/slots.test.ts` style) and document the slot's context in this
repo's docs.

### 4.2 Rail surfaces (`host.surfaces.register`)

Package windows render through the declarative surface registry
(`apps/web/src/surfaces.ts`, hosted by `ContextRail.tsx`). A surface is a
component + navigation metadata; the host handles keep-alive mounting,
content-driven visibility, badges, and persisted widths.

```tsx
host.surfaces.register({
  id: "myfeature",
  title: "My Feature",
  description: "One-line purpose shown under the title.",
  shortLabel: "My",
  icon: () => <MyIcon />,
  capabilityId: "myfeature",   // navigation-metadata association only
  order: 42,
  component: MyPanel,          // a component; owns its hooks/state
  badge: (ctx) => count,       // optional strip badge
  visible: (ctx) => hasContent, // optional content-driven visibility
});
```

- **System presentation is required for packages:** every package home adds a
  `presentation: { kind: "workspace", defaultRatio,
  minWidth, preferredMaxWidth, keepAlive, escape }` block, which makes them
  dockable beside Chat with the pane host. Contextual surfaces
  (Context/Knowledge/Usage/Events) leave `presentation` undefined.
  - Optional `dock: "side" | "bottom"` picks the edge a **pinned** pane
    attaches to. Omitted (or `"side"`) keeps the classic dock beside Chat with
    a vertical resize. `"bottom"` pins the pane as a full-width strip under the
    workspace, lifting Chat's composer above it, with a horizontal resize on
    the strip's top edge (`minHeight` bounds it). On a shell shorter than
    Chat's floor plus the strip's own minimum, Chat yields and scrolls so the
    strip stays inside the shell instead of overflowing off-screen. Dynamic
    and fullscreen modes ignore `dock`. Terminal and Schedule ship
    `dock: "bottom"`.
  - Optional `dockOptions: readonly ("side" | "bottom")[]` lets a pinned
    package window offer both edges. Every pinnable window keeps the same
    pin toggle; a window with two edges adds one header action before it that
    moves (and pins) the window to the other edge (`Dock beside Chat` /
    `Dock below Chat`). The selected edge persists per project/surface. When a chosen edge cannot hold Chat's
    320px floor, the pane promotes to the full-screen layer — a side dock
    never silently becomes a bottom strip just because the window is narrow.
    On wide shells, the promoted pane fills the workspace between the persistent
    navigator and launcher strip; it never paints beneath the navigator or keeps
    the pinned in-flow geometry (which would lay it out inside the ~44px
    launcher strip and collapse it). Terminal is the reference package
    (`dock: "bottom", dockOptions: ["bottom", "side"]`).
  - Side-dock admission (`decideDock`) is judged from the **docked** width
    (Chat + in-flow pane, launcher strip excluded). On the layer, Chat's box
    also spans the strip lane, so that wider box must never re-admit the
    dock: `workspace/dockGeometry.ts` keeps the last docked measurement while
    the shell box (shell and sidebar width) is unchanged, and a real resize or
    sidebar change judges afresh. Without it a pane just below the threshold
    flips dock ⇄ layer several times a second (pinned Tasks/IDE companions at
    ~1100px). `ContextRail.tsx`'s geometry measurement feeds every reading
    through `dockAdmissionWidth`. A live window drag makes a fresh shell box
    every pixel, so the first dock → layer flip inside one box also *learns*
    the layer's overstatement (strip + seam + gap, 58px on desktop;
    `learnLayerInset`) and later fresh layer readings subtract it. Pinned by
    `apps/web/test/dockGeometry.test.ts` (negative control included).
  - **Focused split** (a focused profile with `presentation.companionWidth`,
    see §4.7; IDE): the work surface (Files) is the flexible
    primary column and Chat a companion of fixed width. `decideFocusedSplit`
    (`surfaces.ts`) docks only when work-min (`FOCUSED_WORK_MIN` 600, or the
    surface's `minWidth` if larger) + Chat-min (`FOCUSED_CHAT_MIN` 360) fit the
    mode-independent width above; a split that left re-enters only 24px above
    that threshold (`dockWithHysteresis`, `DOCK_HYSTERESIS`). Chat's default
    follows the window: the hint's `target` from 1600px, the midpoint of `min`
    and `target` from 1280px, `min` below. Past the work cap (the surface's
    `preferredMaxWidth`, never below `FOCUSED_WORK_MAX` 1100 here) Chat fills
    up to its `max`, then the work surface grows. Measured on desktop with the
    automatic project rail below 1600px: 1024 → layer; 1100 → Chat 360 / work
    625; 1280 → 400 / 765; 1440 → 400 / 925; 1600 → 440 / 762; 1920 → 440 /
    1082. The existing separator resizes the seam (8px hit area inside the
    pane's seam, grip on hover/focus; Arrow 16px, Shift+Arrow 64px, Home/End
    limits; double-click resets). Only a drag or keyboard resize persists, as
    Chat's width per profile per project (`splitChatWidths[profileId]` in
    `polyth.workspacePane.v2.<projectId>`); within ±12px of the band default it
    snaps and forgets the saved width. A saved width is clamped on read to
    [Chat-min, workspace − work-min], so it moves the seam but never pushes the
    split onto the layer; the pane width is always derived. Entry is a
    cross-fade (never a width animation), and a dock ⇄ layer change caused by
    geometry (same surface and mode) carries `data-geometry-flip` and does not
    animate. Below the dock threshold the work surface takes the ordinary
    full-screen layer; there is no floating companion Chat yet. Pinned by
    `apps/web/test/focusedSplit.test.ts`.
- **Compact package windows fill the viewport:** workspace panes and contextual
  panels share a host with no backdrop filter, inset to every screen edge. This
  also applies to short coarse-pointer landscape viewports wider than 960px;
  desktop launcher geometry must not contain or shrink their windows. The
  window is its own screen: it covers the shell header and the phone session
  menu (header/floats at `z-shell + 2`, the phone Workspace at
  `--z-stack-workspace`, a package window at `--z-stack-package`), and its own
  `ModuleView` Back/Close row is the navigation. Only the top safe area is
  reserved inside its frame. Closed keep-alive panes do not retain the
  viewport host.
- **Phone layer stack (Chat → Workspace → package window):** on phone these
  are three layers of one stack (`mobileLayerStack.ts` decides,
  `MobileWorkspaceLayer` hosts, `stackNavigation.css` moves them). A package
  opened from the Workspace is **pushed above** it: the Workspace stays mounted
  beneath, inert and retreated, so **Back** is a pop to a layer that is already
  rendered (scroll position and Edit state intact) and never exposes Chat.
  **Close**, Escape and a session switch dismiss the whole stack to Chat.
  Close and Escape also forget the package (`forgetMobileWorkspacePackage`),
  so the next Tools tap opens the Workspace home; a session switch, which only
  takes the window away, keeps it as the Tools resume target. A closing window
  returns focus to its invoker or launcher; on a touch device
  (`pointer: coarse`) it never hands focus to a text entry — not even the
  composer that is the desktop fallback — and falls back to the Tools control
  (`[data-workspace-trigger]`), because a focused field raises the software
  keyboard (it flashed up and down on the iOS app). A phone Back restores only
  the invoker (the Workspace tile) and no fallback: the revealed Workspace
  claims focus itself, and a fallback that raced it left the composer focused
  — with the keyboard open — under the Workspace. Every Back surface performs the
  same pop — the `ModuleView` Back button, native Android Back
  (`handleNativeBack`'s `phoneLayer`) and the interactive edge swipe — and each
  names the Workspace as the destination before the package leaves. A package
  opened straight from Chat (Tools resume, palette, file reference) gets its
  idle Workspace underlay only after it has finished arriving. A closed
  keep-alive pane must never present itself: `ModuleView` takes `presented`,
  and only a presented phone frame becomes the resume target or takes focus
  (the hidden frame falls back to the placeholder id `panel`, and registering
  it once closed the Workspace that Back had just opened).
  - *Motion is one grammar for every layer:* the arriving layer travels in from
    the inline-end edge (`stack-in`), the leaving layer travels back out
    (`stack-out`), and the layer beneath retreats by `--stack-parallax` and
    dims (`stack-cover`/`stack-uncover`) with the same duration and curve
    (`--motion-stack`, `--motion-stack-ease`), mirrored by `--stack-dir` in
    RTL, so the pair always covers the screen together. Presence is
    presentation-only and paced by the same token
    (`scheduleSurfaceExit(done, "--motion-stack")`); reduced-motion and
    low-resource modes skip the hold and the global rules remove the animation.
  - *Input during motion:* the covered Workspace stays inert and its backdrop
    swallows taps; while it settles back, its veil also swallows them, so a
    second tap on Back cannot reach Edit. A stack layer never dismisses on a
    scrim tap, and a covered layer releases the page scroll lock.
  - *Interactive Back:* dragging toward the inline end (`edgeSwipeBack.ts`,
    attached by `ModuleView` and the Workspace) makes the layer follow the
    finger while the Workspace peeks in behind it; a release past the commit
    point, or a flick, hands its position to the same exit animation through
    `--stack-from`, and anything else springs home. It stands down only while
    an Edit item is lifted. Where it may start follows the swipe setting
    below (default: anywhere on the layer). A settle-back that a layer can be
    dragged from next (`stack-uncover` on the Workspace, the Settings list)
    fills `backwards`, never forwards: a finished animation that holds its
    end state outranks the inline transform, and the layer would ignore the
    finger until it remounts. `underMotion` names the element that plays the
    layer beneath's settle-back, so a flick's shortened duration reaches it
    and is released when that animation hands over.
- **Phone shell swipes** (`swipeSurface.ts` controller, `mobileGestures.ts`
  decisions, `shellSwipe.ts` gates and peek, `PhoneShellSwipes.tsx` for Chat):
  - *Map (LTR; RTL mirrors):* on Chat, a finger travelling right pulls the
    **Navigator** in from the left and one travelling left pulls the
    **Workspace** (tools and widgets) in from the right. The open Navigator
    closes with a leftward swipe from anywhere on it, session rows included
    (a row's only swipe is Pin, toward the inline end; Archive is in the row
    menu), the Workspace and every package window go Back with a rightward
    one. Chat swipes start only while Chat is the top
    layer (no Navigator, Workspace, package, overlay, modal, sheet or menu),
    and only in the phone shell. A Workspace pulled in by a swipe always opens
    its home, not the remembered package the Tools button resumes.
  - *Setting:* General → Swipe navigation (`ui.swipeNavigation`, item `general.swipeNavigation`):
    **Anywhere** (default) starts a swipe anywhere on the surface or at its
    edge; **From edges** only in the 32px edge zone the finger moves away
    from; **Off** disables every phone and tablet swipe: shell, Back, Settings,
    the tablet drawer. Sheet drags, the media viewer and the toast follow the
    finger regardless (they are the surface's own handling, like a scroll).
  - *Host:* the whole navigation layer — shell, Back, the tablet drawer and
    phone Settings — runs only in the installed app. Opened in a phone browser
    (Safari, Chrome, any coarse-pointer web host) the browser owns a drag from
    the screen edge for its own back navigation, which the page can neither
    pre-empt nor observe, so `swipeHost.ts` stands Polyth's swipes down
    entirely (`swipeZoneInHost` returns `null`): the browser's gesture wins
    cleanly instead of two layers fighting for the same touch. A fine-pointer
    desktop browser keeps the tablet drawer's swipe (no competing system
    gesture), and the installed Capacitor app keeps every swipe. This is a
    capability decision (`isNativeMobile()` plus `(any-pointer: coarse)`), not
    user-agent or device sniffing, and it is independent of the setting above.
  - *Who keeps a touch:* away from the edge a swipe must clear 12px and be
    clearly horizontal (1.6:1) or it gives up; it never starts in editable
    content (`input`, `textarea`, `select`, `contenteditable`, sliders), while
    text is selected, in a subtree marked `data-owns-swipe` (empty = both
    directions, or `toward-end`/`toward-start` for one; a session row owns
    `toward-end` at rest and both while Pin is showing; an edge start still
    navigates over any owner), or in one marked `data-no-edge-swipe` (owns
    even the edge). At the moment of decision it
    also yields to an ancestor with `touch-action: none` (drag handles,
    drawing/terminal surfaces) and to a horizontal scroller that can still
    move that way; a scroller already at its end hands the swipe on. Packages
    with horizontal gestures that are neither should mark them.
  - *Peek:* a Chat swipe mounts the surface the moment it claims the touch
    (`flushSync`), as an inert, non-modal peek resting off-screen and moved by
    an inline transform. A release past the commit point (35% or a flick)
    replaces the peek with the open state in one synchronous commit; anything
    else springs it home and unmounts it without an exit (a peek never takes
    focus, so nothing is handed back).
  - *Animation vs. inline drag:* a dragged surface is moved by an inline
    transform, and an animation (even a finished `both`/`forwards` one)
    outranks inline styles. The open Navigator's entrance fills forwards, so
    `MobileNavigator.css` drops its animation while `data-swiping` is set, and
    a drag that springs home leaves `data-swipe-handoff="rest"` so the entrance
    does not replay. Any new draggable surface needs the same.
  - *Hand-off:* a release publishes where the finger left the layer
    (`--nav-swipe-from`, `--stack-enter-from`, `--stack-from`) and a duration
    for the rest of the travel (`--nav-swipe-settle`, `--stack-in-settle`,
    `--stack-out-settle`, `--stack-uncover-settle`) computed by
    `settleDurationMs` — the share of the distance left, never slower than the
    finger (the curve's initial slope matches the release speed), at least
    120ms, at most the token. The stack grammar's shorthands stay unchanged;
    the swipe durations are separate longhand overrides, and the Navigator and
    swipe-entered Workspace use dedicated two-stop keyframes selected by
    `data-swipe-handoff`. `holdHandoff` takes start positions back when their
    animation ends, but keeps durations and the selecting attribute until a
    different animation starts on that element (or it is cancelled or
    replaced): a CSS animation re-reads its timing even when finished, so
    restoring a longer duration would wake it mid-travel.
  - *Motion and performance settings:* following the finger is direct
    manipulation and always tracks; every autonomous part (settle, spring
    home) is 0ms under `prefers-reduced-motion`, Reduce motion
    (`data-reduce-animations`) and low-resource mode (`motionIsReduced`), and
    a leaving layer is parked off-screen until it unmounts so it cannot flash
    back. Input cost: the always-on `touchstart` listener is passive; the
    non-passive `touchmove`/`touchend` listeners exist only for a touch that
    may become a swipe, so a vertical scroll is released to the browser's
    asynchronous path after its first move (Chromium-verified).
  - *Shared mechanics:* the controller cancels the page's pending press (a
    long-press cannot open mid-drag), swallows the drag's own `pointerup` and
    synthesized click, lets one swipe claim a touch at a time, turns a second
    finger into a cancel, gives a selection haptic as the drag crosses the
    commit point, and marks `html[data-stack-swiping]` (no text selection)
    while dragging. The full-screen Workspace sheet, the Navigator and phone
    Settings drop their own container focus ring (it lies outside the
    viewport at rest and would ride the moving edge); the leading edge casts
    `--shadow-stack-edge` / `--shadow-drawer-edge`.
  - *No jump at the claim:* a swipe is recognised only past its slop; the
    layer then leaves rest with the finger and closes that gap over the next
    claim distance at twice the finger's speed (`caughtUpTravel`), after which
    it sits exactly under the finger. Release speed is the finger's own.
  - *Catching:* a finger that lands on a layer springing home stops it where
    it is and drags it on from there (same session); one that only catches it
    and lifts lets it carry on home (a tap never completes the other way).
    The spring home and every
    scripted settle follow `--motion-stack-ease` (`stackEase`), like the CSS
    hand-offs. A touch whose end never arrives — the page hidden mid-drag
    (`visibilitychange`/`pagehide`), or a new touch while the old one is gone
    — springs the layer home instead of stranding the claim.
  - *Owners and extent:* `data-owns-swipe` keeps a swipe from every surface
    around the owner, never from the owner's own swipe (the toast). `extent`
    measures a layer narrower than the screen (the tablet drawer) against its
    own width for travel, commit and settle.
  - *Tablet drawer* (compact shell, `Sidebar.tsx`): the same grammar as the
    Navigator — pulled in from the inline-start edge, put away toward it,
    released into the drawer's own transition for the rest of the travel. The
    drawer is mirrored in RTL (`inset-inline-start`, `--stack-dir`).
- **Surface motion** (`exitGhost.ts`, `sheetDrag.ts`, `settingsPresentation.ts`,
  `surfaceMotion.css`): every surface arrives from somewhere, leaves back the
  same way, and a drag that dismisses it follows the finger and hands its
  position and pace to that exit.
  - *Exit ghosts:* menus, popovers, sheets, dialogs, Settings, tours and the
    toast are unmounted by their owners the moment they close. Their root
    leaves an exit ghost (`useExitGhost` on the root's ref; React detaches a
    ref while the element is still attached): an inert, `aria-hidden` copy of
    the last frame — scroll offsets, field values and canvas pixels copied, ids
    and `aria-modal` removed, media replaced — inserted in place and marked
    `[data-exit-ghost="<kind>"]`, which plays the kind's exit from
    `surfaceMotion.css` and removes itself. Nothing inside a ghost animates or
    takes input; code that looks for open surfaces skips `[inert]`. No ghost is
    made under reduced motion or where nothing animates it (a DOM without the
    stylesheet). A surface that plays its own exit through presence (`closing`,
    stack layers) or never opened (a peek) leaves none.
  - *Sheets:* on phones a bottom sheet rises from the bottom edge and goes back
    down it; a top sheet drops and lifts; centered sheets on wider screens rise
    and sink in place. A sheet that shows its grabber can be dragged toward its
    edge — by the grabber or the title row at once, by its content only while
    every scroller under the finger is at its start (a list at the top pulls
    the sheet instead of bouncing), never from editable content, an owner or a
    `touch-action: none` handle. The drag tracks 1:1 with no CSS transition; a
    release past 88px (or a third of a short sheet) or a flick dismisses,
    publishing `--sheet-from`, `--sheet-settle` and `data-drag-dismissed` for
    the exit (or the ghost's), anything else springs back. Full-screen Back
    sheets and stack layers navigate instead.
  - *Dialogs* rise into place on wide screens and sink out; at phone widths
    (where they are bottom sheets) they rise from the bottom edge and go back
    down.
  - *Phone Settings* is a full-screen layer of the stack grammar on every
    page: page-scoped CSS (`.settings-page-<id>`) never re-sizes the scrim or
    the shell (`mobileViewportLayers.test.ts` renders General and Usage). Opened from
    the Navigator (`presentSettingsFrom("start")`) it takes the Navigator's
    side: it arrives over it from the inline-start edge while the Navigator
    holds still, retreats by the parallax, dims and stops painting
    (`data-drawer-exit="covered"`), and a swipe toward that edge — from the
    list or a page — dismisses it, following the finger. Opened anywhere else
    it is pushed from the inline end and a swipe toward the end dismisses it
    from its list. Its two stages are layers of one grid cell: a page is pushed
    over the list (`data-stage-motion="push"`: `stack-in`, the list
    `stack-cover` and dimmed) and popped back off it (`pop`), and Back —
    button, Escape, native Back (`stepSettingsBack`, unless something is open
    over Settings) or a swipe toward the inline end with the list peeking in —
    is that pop. A released dismissal hands `--settings-from` /
    `--settings-settle` to the ghost's `settings-out-start|end`; the entrance
    is dropped for good once a finger has moved the layer (`data-dragged`), so
    it can never replay.
  - *Media viewer* (`AttachmentPreview.tsx`): sideways drags move the item and
    a release past the commit point carries it off the edge (a `page` ghost)
    while the next one rides in from the other edge in the same time; a pull
    down moves the item and lifts the dim (`--preview-drag` on its own layer)
    and the chrome, and dismisses from there or springs back. An image zooms
    in the viewer itself (`mediaZoom.ts`; the page never zooms): two fingers
    pinch around their midpoint, a double tap zooms into the tapped point or
    back to rest, a zoomed image drags within its bounds (clipped to the stage
    via `data-zoomed`), and a trackpad pinch (ctrl + wheel) zooms on desktop.
    While zoomed, or with two fingers down, paging and the pull stand aside.
    The stage is `touch-action: none`: allowing native `pan-y` let the browser
    scroll or bounce the page behind the fixed viewer before a sideways swipe
    was claimed, which jerked the viewer and showed the chat behind it.
  - *Notification:* a notification card (`notify/NotificationStack.tsx`)
    follows a finger toward the inline end on the independent `translate`
    property (the stack owns `transform`), fading as it goes, and leaves off
    that edge (a `notification-swipe` ghost) when released past the commit
    point; closed or expired it sinks back toward its stack edge (a
    `notification` ghost).
- **Compact Files names the open file once.** Below the `feature-panel`
  820px container width the `PaneHost` tab strip is hidden; the stage switch
  (`Files | <file>`) carries the active title and a tab-count button opens the
  open-files switcher sheet (`PaneHostHandle.showSwitcher()`). The file
  toolbar holds the Edit/Preview segmented control and, on touch shells, the
  visible file-actions menu (which also closes the file); wide shells keep the
  context menu. Do not add a second file-name bar or a duplicate close button.
- Every registered surface renders through the host's single `ModuleView`
  structure: header, title/description, actions, close, body, and content
  wrapper. The host chooses `page`, `panel`, or `workspace` content behavior;
  package components return feature content only. Packages must not add
  `.view-page`, `.module-view*`, their own outer close/fullscreen controls, or
  a second page title. Package toolbars and detail headings remain content.
- `order` then `id` determine strip order; replacement is by id; disposal is
  identity-based.
- **Close semantics:** an open package window is dismissed only by an explicit
  user action — its close control, the launcher toggle, Escape, an outside
  click for a dynamic window, or a real session/project transition for a
  non-pinned window. Internal events (a shared layout hydration on boot or
  WebSocket reconnect, project or package catalog
  re-sync, streaming updates) must never close it. `ProjectPanePresentation`
  restore is owned by `activateProject()` alone; the
  `PROJECT_PRESENTATION_HYDRATED_EVENT` listener in `store.ts` skips an already
  open window.
- **Launcher toggle:** every launcher — top rail, right rail strip and placed
  `capability:*` launcher widgets — routes through `toggleCapability()` and
  marks itself `data-pane-launcher=<capability id>`. Pressing a launcher whose
  capability is active (`isCapabilityActive`, so a package home counts while
  one of its pages is open) is not an outside click for a dynamic window;
  otherwise pointerdown dismisses the window and the click reopens it. A new
  launcher surface must carry the attribute.
- **Keep the pinned window** (Settings → Behavior → *Package windows*,
  `UiSettings.sharedPinnedWindow`, on by default; a record saved before
  `sharedPinnedWindowVersion` 2 was written while it was opt-in, so its
  `false` switches on once): the pinned window behaves as one fixed panel
  whose screen changes with the package. While a workspace window is pinned
  (or fullscreen over pinned), a launcher for another workspace window swaps
  the content without closing first, so the mode is kept
  (`toggleCapability`). `ContextRail` then reads and writes one shared layout
  entry, `SHARED_PINNED_PANE_KEY` (`::pinned`) in the project's pane prefs
  (width, dock edge, `::dock` strip height). The pin mode itself is one
  store value (`paneMode`), so unpinning any window releases the frame for
  all: the next launcher closes it and opens a floating window. The shared
  edge applies even while unpinned, so the header offers the edge the pin
  will use. The edge is seeded when the first window pins; the width is not (the geometry is still settling then):
  the frame's last settled width is carried to the next window and stored
  at that switch, or stored when the person resizes the frame. A shared
  width is not capped by a package's `preferredMaxWidth` — only by Chat's
  floor, and raised to a package's `minWidth`. A shared edge the next window
  does not offer (`dockOptions`), or a missing shared entry, falls back to
  that window's own memory, so a package that should share a side frame and
  prefers the bottom strip lists both edges (Planner does). Off: every window
  keeps its own size and edge, and a launcher closes the open window before
  opening the next one.
- **Extension overlays:** a pointerdown on a custom element injected straight
  under `<body>`/`<html>` (Grammarly, LanguageTool, password-manager cards) is
  not an outside click either: accepting a suggestion edits the window's own
  field. Polyth defines no custom elements, so `pathBelongsToPackageWindow`
  treats a hyphenated top-level tag as foreign. Packages with free-text forms
  should still keep unsent drafts across unmount (Tasks does), since any other
  outside click still closes a dynamic window.
- **Window motion:** `ContextRail` owns one direction-aware motion contract for
  every package mode. Arrival runs on `--motion-window` (a long ease-out that
  settles without a visible landing), departure on the quicker, accelerating
  `--motion-window-exit`; the frame, its content, the launcher seam and the
  tablet host share that clock, so no part lags. Dynamic windows glide
  `--motion-window-travel` out of their launcher rail while fading up — frame,
  glass and content as one piece — with the strip, stacked above, covering the
  part still inside the rail; closing runs the same path back. They move on
  transform and opacity only, so the compositor holds frame rate while the
  package mounts. Docked windows grow in flow inside the rail host's frame,
  which carries the rounded corners outward; the window fill stays opaque and
  only its content fades, so no hollow bordered box appears, and the content
  keeps its final width throughout (laid out once, not per frame). The seam
  divider fades with the window. The desktop fullscreen layer fades over a
  quarter of the travel, without scaling its text. A focused split's work
  surface slides in from its rail's side, which flips when the surfaces are
  exchanged. In the 961–1400px band the floating launcher cluster
  morphs into the docked column and back (inset, height from
  `--rail-cluster-block-size` published by `ContextRail`, corners and
  inline-end edge), ending exactly on the idle cluster's geometry; bottom,
  narrow and fullscreen docks keep their own motion. Viewport-facing and
  launcher-facing corners remain square through every mode switch, and so do
  the corners at the window's bottom edge: the sidebar, the rail host, a
  docked or pinned window and the sessions peek run into it, so only their top
  corners round (a floating package window clears the edge and keeps both
  start corners). Bottom and
  compact/full-screen layers use their matching axes. Closing first
  makes the frame inert, keeps only a presentation snapshot through the exit,
  then removes it (compact full-screen layers use the phone layer stack's
  `stack-in`/`stack-out`, above). The kept-alive panes stay mounted and hidden
  beside the leaving one, in their usual order, so an exit never remounts them.
  `data-rail-motion="exiting"` is transient paint state, never
  open-state authority; reduced-motion/low-resource modes skip the hold. A
  hidden keep-alive pane must not retain pane borders, geometry-host materials,
  or launcher-seam styles after the exit.
- **Fullscreen frame (wide shells):** the fullscreen layer keeps the pinned
  window's frame — a hairline border and a rounded top corner on the side
  facing the navigator (`--radius-surface`, so the user's corner scale
  applies), square where it meets the launcher strip and the window's bottom
  edge. It stays opaque over the inert
  Chat beneath; with a wallpaper it repaints the root wallpaper fixed to the
  viewport under the same 92% `--panel` tint a pinned window shows, so the
  wallpaper reads through and Chat does not.
- Workspace panes render their content edge to edge (`contentMode:
  "workspace"`): the package owns its gutter and should align it with the
  window title (`--space-3`).
- The `workspace.right.tabs` **slot** is bridged into rail surfaces
  (`slotSurfaces` in `surfaces.ts`): a slot contribution with
  `meta: { title, description, order, icon, capabilityId }` becomes a rail panel. This is
  the right mechanism when you already have a slot-shaped contribution
  (e.g. `packages/knowledge`'s Tracks panel). Its `capabilityId` must name a
  registered capability: a panel without one is still drawn in the right rail,
  but the rail editor never lists it, so it cannot be removed or moved (the
  host Notifications panel uses the built-in `notification-centre` capability).
- In-repo marks: rail launchers and widget pickers resolve by id through
  `RAIL_ICONS` (`railIcons.ts`; unmatched ids get the neutral package glyph),
  and Settings/package tiles resolve the manifest's semantic `descriptor.icon`
  key through `packageIcons.tsx`. A new package adds its id and key to both
  (`railIconsOnly.test.ts` / `packageIcons.test.ts` guard the fallback).
- Managed trusted plugins cannot pass components through manifest JSON, so
  their UI entry may export `icon` (a `currentColor` package mark taking
  `size`/`strokeWidth`) and `surfaces` (`{ [moduleKey]: { title,
  description?, shortLabel?, keywords?, presentation? } }`). A
  `workspace.right.tabs` contribution whose id is the plugin id (or
  `<pluginId>.*`) and whose module has `surfaces` metadata is registered by
  `pluginBridge.ts` as a real surface plus a `more`-tier capability (rail
  customize menu, search, launchers); `presentation` is clamped by
  `pluginPanePresentation`. The mark is registered with `registerPackageIcon`,
  so `railIconFor`/`widgetIconFor` resolve it for the package id and every
  `<pluginId>.*` id. These carry no `ownerPackageId`, like other managed
  contributions. Without metadata the contribution stays a plain bridged slot.

### 4.3 Built-in workspace surface and package pages

`WorkspaceHost` is shell infrastructure for the built-in Chat surface. Packages
cannot register workspace surfaces into it. A package home (a tool) always uses
`host.surfaces.register` and opens with `host.navigation.openWorkspacePane(id)`;
this guarantees the shared header, actions, resize frame, focus handling, and
dynamic/pinned/fullscreen state machine.

A package **page** is different: it is an object of the navigator that opens
*in place of Chat*, the way a chat does — an agent's own screen. Register it
with `host.pages.register({ id, title, component })` and open it with
`host.navigation.openPage(id, resource?, { projectId? })`; `closePage()`
returns the canvas to Chat. The store holds `activePage { pageId, resource }`
(presentation-only navigation, never history); `activeSessionId` keeps the
chat the canvas returns to. `WorkspaceHost` renders the page component with
`{ resource, projectId }` inside `.page-canvas` behind its own
`ViewErrorBoundary`; there is no `ModuleView` frame, so the page owns its
header (on a phone, where no shell header shows, it also carries the button
that opens the navigator). Rules, pinned by `apps/web/test/packagePages.test.ts`:

- Choosing a view tab (Chat, Canvas or a workbench profile) closes the page,
  because the page renders over every workspace mode. With no chat to return
  to, the lane's first listed chat opens (pinned first, then most recent; no
  children or archived chats) instead of an empty new chat.

- Opening a chat (any person-driven `openSession`, which clears the page
  before its load so the loading row shows where the chat will be), starting
  a new chat (`showSessionChat`), `closeAllModules`, switching project, and
  `conversation.insert` all return the canvas to Chat. Re-activating the
  same project keeps the page; `projectId` first moves the workspace to the
  page's project. A session open that resolves after the person opened a page
  never steals the canvas back.
- Like a chat switch, opening a page closes a floating package window and
  keeps a pinned one.
- While a page is open the shell header shows no chat title or session
  status, the phone header renders no chat floats, and the navigators mark no
  chat row current.
- `host.store.getSnapshot().activePage` reports the open page; disposing a
  package's registration closes its open page.

#### Split sessions view (two chats side by side)

The Chat surface can show a second chat beside the open one. State and rules
live in `apps/web/src/sessionSplit.ts` (pure, tested by
`apps/web/test/sessionSplit.test.ts`); the host component is
`components/workspace/SessionSplitView.tsx`.

- **One active chat.** The *focused* pane is the active chat
  (`activeSessionId`): live socket, composer, status docks and every shell
  surface that follows the active chat. The *companion* pane is a view of a
  background chat, rendered by the same `Timeline` inside a
  `TimelineSessionProvider` (`apps/web/src/timelineSession.ts`). Transcript
  rows read their session and project through `useTimelineSessionId()` /
  `useTimelineProjectId()`, never `activeSessionId`, so a companion never shows
  the active chat's model, pins or files. In companion mode the Timeline
  publishes nothing shell-wide (prompt bookmark, failed-turn toast, person
  selection).
- **Click focuses.** Any click inside the companion makes it the active chat
  in place (`openSession`) and is swallowed, so its rows never act while
  another chat is active. Scrolling and text selection stay free. Places never
  move on a focus change; the composer lifts into the newly focused pane.
- **Freshness.** The socket follows only the active chat. The companion pins
  its history in the event LRU (`pinSessionCache`) and reads the suffix through
  `refreshBackgroundSession` when its projection moves, and every 1.2 s while
  its agent works. A 404 ends the split.
- **Following.** The split follows the active chat wherever it changes:
  choosing the companion moves focus; choosing another chat shows it in the
  focused place; a fresh chat keeps the companion beside it. Chats are not
  pruned from the session list (a list page holds only recent chats).
- **Entry points.** Navigator row menu *Open in split view*, Alt-click a row,
  drag a row onto the workspace (end half, or onto the companion to replace
  it; `SESSION_MIME` in `dnd.ts`), `Mod+\` (*split with the previous chat*,
  toggles), palette commands (toggle, focus the other chat, swap sides, close).
- **Layout.** Presentation only, tab-scoped (`sessionStorage`); the divider
  position is a remembered preference (`localStorage`). Never on the phone
  shell; below two 360 px panes the split rests (the focused chat fills the
  workspace, the pair is kept). The live chat surface never remounts: the host
  always wraps it, and places are CSS `order`.
- **Motion.** Transform/opacity only, on the window clock
  (`--motion-window*`): opening FLIPs the focused chat to its place while the
  companion arrives from the end; closing leaves an exit ghost of the
  companion; swapping sides FLIPs both. Reduced motion turns it all off.

### 4.4 Capabilities (`host.capabilities.register`)

One capability model feeds header, rails, command search, and Settings so
they can never disagree. Registration is metadata + open/available only — a
capability confers no authority (no filesystem/process/credential access).

Each navigation rail renders at most one launcher per owning package. When
present in that rail, the capability whose id matches its owner package id is
the package home; otherwise the first ordered entry is retained. Host navigation
entries remain independent. Initial project setup also demotes duplicate entries
to Technical for every composition, including General and explicit package
inclusion; existing placement preferences are preserved.

Capabilities that arrive later (a package installed, enabled or made relevant
after the project already exists) are placed once per project by
`capabilityArrivals.ts`: the per-project layout records which capability ids
the project has `seen`; a new one keeps its standard place only when
`autoPlacesContribution` allows it (matching direction, explicit project
inclusion, host navigation, or a universal package in an untyped project) and
otherwise goes to Technical, one click away in the rail editor. Rail and
dashboard budgets apply to *chrome* only: a universal package's session
controls (session header actions and composer buttons such as Goal,
Auto-approve, Dictation) are revealed in every project, typed or not; only a
direction-scoped package's controls wait for a matching direction (see
`widgets.md` §10). The
first record after this tracking exists is only a baseline and moves nothing.
Decisions wait until the project's shared layout has synced from the server,
its composition and the package catalog are known and initial package
activation has finished.

Placement, widget layout and the other shared project presentation records
sync between clients through `projectPresentationSync.ts`. Each device keeps
the last server snapshot it synced from (`polyth.projectPresentationBase.v1.*`)
and merges three ways (`presentationMerge.ts`): only what changed locally
since that snapshot is replayed onto a newer server record, so a stale device
cache, or an automatic repair layered on it, never restores an icon another
client hid. Another tab's write is mirrored into this tab's in-memory stores
through the `storage` event.

**Shared or per-project interface.** `projectInterfaceScope.ts` holds a
personal account preference (`core.project-interface`, synced by
`settingsSync.ts`): `per-project` (default) or `shared`. It decides which
local record the stores read and write — `presentationScopeId(projectId)` is
the project id, or `@all-projects` while shared. The storage-key helpers of
the five synced records (`capabilityLayout`, `widgetLayout`, `workspacePanel`,
`canvasEnabled`, `workbenchProfiles`) and the phone composer buttons
(`mobileRailKey`) resolve through it; new presentation records must too. While
shared, `markProjectPresentationChanged` feeds the account preference
`core.shared-project-interface` instead of the project's server record, so a
project record and other Space members' view are never rewritten, and
switching back restores every project's own arrangement. Relevance then reads
every project as General (`projectRelevance.ts`), and `isProjectPresentationSynced`
waits for the account settings snapshot. The first switch to shared copies the
active project's records (`chooseProjectInterface`); "Use … layout for all"
replaces the shared record later. A mode change re-publishes
`PROJECT_PRESENTATION_HYDRATED_EVENT` with every key so stores re-read.

A package may place or unplace the capabilities it registered itself through
`host.capabilities` (optional on older hosts): `placement(id)` returns
`{ tier, onRail }` for the active project (`null` if unknown or not owned),
`place(id, "more" | "primary")` puts the launcher on the right/top rail
(leaving any shell zone it lived in), `place(id, "technical")` takes it off
every rail while it stays searchable, and `subscribePlacement(listener)` fires
when placements may have changed. They act on the active project's synced
layout exactly like the rail editor (`railPlacement.ts`). A package whose items
should be opt-in registers them with `standardTier: "technical"` and offers
an explicit "Add to rail" action. A `kind: "command"` capability is never
auto-placed, even for an explicitly included package.

`legacyStandardTier` is the migration contract for a changed default: a
capability that used to default to tier X and now defaults to Y registers
`standardTier: Y, legacyStandardTier: X`. When `recordCapabilityArrivals` sees
an id this project already `seen`, with no explicit placement and
`legacyStandardTier !== standardTier`, it pins `{ tier: legacyStandardTier,
rank: standardRank }` (seen without an override means it was showing on its old
default), so nothing already in place moves; a never-seen id, or a project
still to be seeded, simply starts on `standardTier`. Custom actions use this
(`technical` now, `more` before). It runs under the same synced-layout gate as
every other arrival decision.

Users rearrange launchers by dragging them (`apps/web/src/railDrag.ts`): a 5px
mouse/pen move or a 320ms touch long-press lifts an icon; dropping it reorders
its rail, or moves it between the top rail (`primary` tier) and the right rail
(`more` tier) through `setCapabilityTierOrder`. Escape or a release beside (but
not on) a rail puts it back, a release farther than 50px from every rail removes
it (§3.2); Alt+Arrow nudges a focused launcher. Each rail registers
a zone with `useRailDragZone` and renders its `order` (a `null` entry is the
landing slot); the engine owns the ghost, FLIP neighbour motion and reduced-
motion fallback, the zone owns what it accepts and how it persists. An empty
rail mounts while it is `receiving` a drag, so it can take its first icon; the
engine measures a rail that mounts mid-drag, follows one that relocates across
its axis (a pane switching between docked and layered), and re-aims at release.
On desktop the header's window-drag region is lifted for the drag. Terminal
reorders inside the right rail but never leaves it.

Use `rail: false` for searchable internal destinations that must never become
rail icons, even through an older placement override. Their surfaces, search
commands and package-internal navigation remain available. A package home stays
active while any of its owned pages is open, and its launcher uses the registered
capability's `open` command so the package can restore its last page.

Markets exposes the single `markets` launcher. Its ten sections remain in the
package's section switcher and search. The package remembers the last open
section on the device under the canonical, Space-owned project id; closing,
reloading or disabling/re-enabling preserves it. A fresh project or invalid saved
section opens Overview. This is device navigation state, outside canonical
session history and account preference sync.

```tsx
host.capabilities.register({
  id: "myfeature",
  label: "My feature",
  technicalLabel: "MyFeature",
  plainDescription: "Searchable plain-language description.",
  keywords: ["my", "feature", "alias"],
  standardTier: "more",          // "primary" | "more" | "technical"
  standardRank: 20,              // ordering within the tier
  open: () => host.navigation.openSettingsPage("myfeature"),
  available: () => true,
  unavailableReason: () => null, // optional honest reason when unavailable
});
```

### 4.5 Settings pages (`host.settings.registerPage`, `host.settings.registerItems`)

The host Settings search field shows no keyboard shortcut hint in phone mode
(viewport at most 700px); desktop keeps its shortcut hint in the placeholder.

- `registerPage` contributes a page into the Settings modal
  (`settings.pages` slot under the hood). `group` is one of
  `"Workspace" | "Engineering" | "Customize" | "System"`; `order` sorts
  within the group; `component` is a plain React component. A compatibility
  route may set `nav: false` and `redirect: { pageId, target? }` so an older
  page id lands on the canonical page without composing a second surface.
- `registerItems([{ id, pageId, label, description, keywords, focusTarget }])`
  adds item-level search rows that deep-link to the page and focus the row
  (the row's element carries `data-settings-item={focusTarget}`).
- Pages are enabled/disabled with their package; the settings page you add is
  the surface for the feature's browser/server preferences — preferences
  still persist per the rules in `README.md` §2.

#### Settings page contract

Every settings page — built-in or package — composes the shared primitives in
`apps/web/src/components/settings/parts.tsx` (packages import it by relative
path; it is an allowed generic shell import). Do not hand-roll row, heading,
empty or error markup.

- **One title.** The shell header renders the page title from the nav label.
  A page never renders its own H1/H2 page title or a row that repeats it.
  `PageHead({ blurb })` renders the one-sentence orientation blurb as the
  subtitle directly under that title; the `title` prop is ignored.
- **Sections.** Group rows with `Section({ title, hint?, action?, tone? })`.
  Sections are the only headings inside a page (also inside detail tab panels).
  `action` holds small header controls such as `ResetLink` (disabled when the
  values already equal defaults). Destructive page actions go last in a
  `Section tone="danger"`. A page with more than ~6 rows has sections.
- **Rows.** `Row({ label, hint?, layout?, top?, disabled? })` for one setting
  (control right, one shared control column). `layout="stacked"` puts a
  full-width control under the label (textareas, long lists, templates).
  `ReadonlyRow({ label, value, mono?, action? })` for facts. Add/edit forms use
  `FormField({ label, hint?, error?, optional? })` — visible labels, never
  placeholder-only fields.
- **Item lists.** Like items that each have an identity and their own controls
  (packages, servers, accounts) are an `ItemList` of `ItemRow({ icon, title,
  meta?, description?, highlight?, trailing?, onOpen?, openLabel?, selection?,
  inactive?, error? })`: one grouped surface, the mark on a 36px tile, the
  row's main control (a `Switch`) last in `trailing`, and a reserved chevron
  column so controls line up across rows and sections. A row that opens
  something (its detail, its own settings page) is one stretched, labelled
  button marked by the chevron; in selection mode a checkbox leads the row and
  a click anywhere on it toggles. On a narrow list the description runs under
  the controls. `HighlightedText` marks search words (shared with
  `textMatch.ts`). Quiet buttons inside a row take the raised step so they
  stay visible on the list surface.
- **Control vocabulary.** Boolean → `Toggle` (never a lone checkbox).
  ≤4 mutually exclusive options → `Seg`. More options → `Select` (from
  `components/ui`). Several independent choices of one kind → `CheckGroup`.
  Mutually exclusive options whose consequences each need a sentence (the
  approval levels in Settings → Permissions, Judgment routes) → a radio list
  on the item-list surface: one row per option with its title and one-line
  consequence, the choice marked by a wash and trailing check. Where choosing
  saves at once and an option raises risk, arrows only move focus (Enter,
  Space or a click chooses) and the risky option confirms first.
  A number → `NumberField({ unit, min, max })` (commits on blur/Enter, clamps,
  Escape reverts); a visual size/scale → `SizeStepper`.
- **Sub-pages and states.** A page with sub-views (harness detail, Monitoring,
  Source control) uses `SettingsTabs({ tabs, value, onChange, label })` (wraps
  `ui/Tabs` + `TabPanel` with the settings spacing) — never a `Seg` or custom
  CSS as a tab strip — and every panel starts with `Section`s, except where its
  only heading would repeat the tab label: then rows or a one-line lede open the
  panel. A tabbed page reads its `settingsTarget` and opens the tab that owns
  the targeted row (see Source control below).
  A value the user cannot change here is a `ReadonlyRow` or status note, never
  a row that looks editable. Status pills use the shared badge tones with
  sentence-case text; icon-only actions (refresh, reorder) carry a label or
  tooltip.
- **Copy.** Sentence case for nav labels, section titles, row labels and
  buttons. Hints are one plain sentence ending with a period, describing the
  effect, not the implementation; no raw ids, env names or vendor jargon as
  copy. All strings go through `tr()`.
- **Buttons.** One primary button per section, right-aligned at the end of
  that section. Secondary actions are `quiet`; low-emphasis inline actions are
  `ghost`; destructive actions are `danger` (and confirm). Disabled is shown
  only for an unavailable action and reads as disabled — the neutral gray
  chip of every variant, with no hover or press — distinct from `quiet` (see
  "Buttons" in [the design system](design-system.md#buttons)).
- **Save semantics.** Simple values autosave on change; show `SaveStatus`
  ("Saved") only where the write is remote or slow. Draft-style edits (several
  fields applied together, long prompts) use `SaveBar` — Save enabled only when
  dirty (and `canSave`, false while the draft is incomplete), Discard reverts. Never mix autosave and an explicit Save inside one
  section without saying so.
- **Empty / error / loading.** `EmptyState({ title, body?, icon?, action?,
  compact? })` — `compact` inside a Section, the panel only when the page has
  nothing else; put the primary "Add …" action in it. `busy` for loading.
  `ErrorState({ error, onRetry? })` for failed loads: it extracts a human
  sentence from Polyth error JSON (`settingsErrorText`), offers "Try again",
  and keeps raw text behind a details disclosure. Never print serialized
  error objects.
- **Search.** Every row that a user may look for carries
  `data-settings-item` and a registered item (`registerItems`) with
  `keywords` for synonyms (e.g. secret/password/token).

**Shell (host-owned, `SettingsView.tsx`).** The host owns navigation
placement: `NAV_LAYOUT` maps first-party page ids to the groups Workspace /
Agents / Code / Integrations / Customize / System and their order, and
`SETTINGS_ICON_BY_PAGE` gives each a distinct glyph (it wins over the package
`icon`). A package's declared `group` only places pages the host does not
list (`Engineering` → Code), after the curated ones. Until the first package
boot settles (`whenPackagesSettled`) the nav shows a skeleton instead of a
partial list. Search matches page titles, `SETTINGS_PAGE_KEYWORDS` page
synonyms (`settings/registry.ts`) and registered items, and groups results
under their page (capped). An item hit focuses and flashes its row; when the
row is not rendered (it sits behind one of the page's own tabs), the hit is
handed to the page as its `settingsTarget` so the page can reveal it, and the
routed-target effect then scrolls to it. Mod+K or `/` focuses the settings search while
Settings is open; Escape clears a non-empty search, then goes back to the nav
on phone, then closes. The header keeps a fixed slot for the package tour
`?`, so the close button never moves. The `?` appears exactly when the
page's package registers an onboarding tour (`settingsPageToPackageId` +
`getPackageOnboarding`); a page without a tour shows no help button. A
workspace package registers its own tour from its web entry with
`host.onboarding.registerTour` (disposed with the package); only framework
pages and external managed packages keep host-registered tours in
`packages/onboarding/builtinTours.ts`. Pages
do not render their own help buttons. A built-in tour step may carry a
web-local `link: { settingsPage, label }` (`packages/onboarding/types.ts`);
the overlay renders it as a button that completes the tour and calls
`openSettingsPage`. The Providers & Models tour opens on such a step, pointing
new accounts at Harnesses (installing more harnesses is optional).

**Users and account settings.** There is no separate Access page. Settings →
Users opens on the signed-in person's account card, then *People* (one grouped
list; the server owner opens anyone else's `UserDetail`), Sharing and, for the
owner, *Sign-in providers* (GitHub/Bitbucket setup, HTTPS only). The account
card opens `AccountDetail`: profile (name, login, account ID), sign-in
(password change and passkeys in dialogs), linked GitHub/Bitbucket accounts,
the browsers signed in to the account, and sign-out. Elevated actions run
through `useOwnerReauth`, which asks for the password only when the server
answers `reauth-required`. The account menu and `?settings=users/account`
open that view directly (`OWN_ACCOUNT_TARGET`). Polyth Link's *This computer*
card shows the host status, the address this browser uses and whether
sign-in is required, above the paired phones.

Harness-specific sections contribute to `settings.harness.detail` with
`harnessId`, `sectionId`, and `label` metadata. Their `order` controls navigation;
`handlesPendingChanges: true` identifies the section that reviews and applies
pending configuration, and `replaces: [sectionId…]` on a harness's own section
hides those shared (`harnessId: "*"`) sections for that harness — OpenCode's
native Providers & Models replaces the shared Models section. Harnesses renders
these contributions (each receives `{ harnessId, sectionId, snapshot,
projectId, update, updateRun, onUpdate, canManage }`) and derives its capability
matrix from cheap `HarnessSnapshot` metadata. Native discovery runs for the
selected harness detail and, on the list, only as the readiness check for
enabled harnesses whose probe answered `unknown`
([readiness in Settings](../architecture/multi-harness.md#harness-readiness-in-settings)).

Harnesses list layout: the summary card names who new conversations use (the
person's usable *My default* first, then Auto), *My default* sits between it and
the list, and the list is one card of rows that share subgrid columns (drag ·
identity · hover reorder · action · switch · chevron), so switches and actions
align whatever a row offers. Logo tiles take a Space's harness color
(`harnessTint` → `--pkg-harness-color`, `data-tinted`) and resolve the logo
from `identity.defaultName` when the Space retitled the harness; the detail's
Overview holds the Appearance section. A row's meta line is status · route ·
version (`0.85.1 → 1.2.0` when a release is newer); its action is the setup
step, else an owner's Update. On touch, and in any container under 560px where
no column is free for hover arrows, reordering is an explicit **Reorder** mode
that swaps the arrows in for the switch. Under 560px a row also becomes two
lines (status alone on the first meta line, the update target moves into the
button), and the detail hero puts its next step full-width under the title with
the small tools (re-sign-in as a key, Check again) in the top corner. The
section tab strip scrolls sideways and fades only the edge that hides more
tabs. The Accounts tab groups *Your*, *Shared* and *Other people's* accounts;
each row keeps sign-in and Access visible and moves Rename/Remove into a ⋯ menu.

The shared **Models** section (models package, `HarnessModels.tsx`) lists the
harness's catalog by provider with a switch per provider and per model. A
provider switch is a bulk change, not a lock: off turns all of the provider's
models off (also ones it adds later), on turns them all on, and either way its
single-model choices start over. Model switches stay live under a provider that
is off, so a person can switch a large provider off, search, and turn back on
only the models they use; the provider's count shows how many are on. It edits
this account's `ModelPrefs.hiddenProviders` (`harness::provider`, the providers
that are off), `hiddenModels` (`harness::provider/model`, turned off inside a
provider that is on) and `shownModels` (turned on inside a provider that is
off), synced like favorites. The parser drops a single-model choice that agrees
with its provider's switch, and when every model of a provider ends up against
the switch, the choices fold into the switch (`setModelsHidden` with the
harness catalog). The model picker leaves hidden entries out of its list and
search (cross-harness search too) except the route's current selection, and
says so when everything, or every search match, is hidden. It is presentation
only: routes, presets and running conversations keep working with a hidden
model.

OpenCode's native **Providers & Models** page (`ModelsPage.tsx`) is the other
half of the same filter, and it is account-owned in exactly the same way. Its
provider and per-model switches edit this account's `modelVisibility` section
(`disabledProviders`, `disabledModels` as `providerID/modelID`, and the
`addedProviders` rows the person added), which travels in the same
server-persisted client-settings blob as `ModelPrefs` — so the list follows the
account onto every client and a second person on the same server keeps their
own. The server filters `/api/models`, `/api/providers`,
`/api/opencode/providers` and the picker-facing runtime catalog and harness
snapshot catalogs (OpenCode rows only — another harness may reuse an id such as
`cursor`) by the **requesting** account, and a change is echoed
to that account's other clients over `client-settings/changed`; the page
re-derives its switches from the inbound snapshot, so an open page converges
without a reload. The section is server-owned: a client's blob write never
changes it (`patchSection` is the only writer). `data/model-visibility.json` is
NOT the account list — it is the host-global physical mirror written into
`opencode.json` (`disabled_providers` + `provider.<id>.blacklist`), which
OpenCode reads as one config per host. Only a provider or model **every** known
account disabled is written there, so one person's hide can never physically
remove another person's provider. The same file is the migration seed for
accounts that predate the section, so existing host-global curation carries over
into each account's list on first read.

### Package library surface (`packages` settings page)

The host's `packages` settings page is one surface for built-in packages and
the packages a person adds. The plugins package contributes the added-package
library through `settings.packages.content`; disabling that package removes
it while the built-in controls stay. The legacy `plugins` page is hidden from
navigation and redirects to `packages`.

**One find state for the page** (`settings/PackagesPage.tsx`, model in
`settings/packageManagement.ts`). A sticky toolbar — search, a status `Seg`
(All / On / Off; core packages count as on) and a category `Select`
(`searchable={false}`, end-aligned) — filters everything on the page. Search
is multi-word (every word must match id, name, description or category) and
marks matches. Counts are faceted and include contributions. Once rows scroll
under it the toolbar lifts with `--shadow-sm`. There is one "No packages
match" state, shown only when neither the page nor a contribution has a match.

**Contributions** receive `PackagesPageSlotContext` (`@polyth/web-sdk`):
`packagesQuery`, `packagesStatus`, `packagesCategory`,
`reportPackageMatches(owner, { all, enabled, disabled })` and
`setPackageDetailOpen(owner, open)`. A contribution lists its own packages
under that find state (it never adds a second search), reports its matches
for every status choice so the counts and the empty state stay honest, and
may take the page over for a detail view: while one is open the host hides
its blurb, toolbar and lists, scrolls to the top and restores the list
position when the detail closes. Packages without a host category do not
match while a category is chosen.

**Built-in lists** are `ItemList`s: "Optional packages" (with "N of M on" and
a Select action) and "Core packages". A row is the package glyph, name and
description, its tour as a `?` icon button, then the switch — or a lock note
for core packages — and a chevron when the package has its own visible
settings page (the row opens it). The switch applies one change immediately:
the row shows the target state with a spinner, a refusal restores the
confirmed state and keeps the reason in the row, success is announced in a
polite live region, and the list is re-read once changes settle.
**Select** enters selection mode (core rows are not selectable): a centred,
floating bar on the raised step offers select-all-shown and Enable N /
Disable N, which send only the packages whose state differs, one request at a
time.

**Added packages** (`packages/plugins/widgets`) follow the same row grammar:
mark, name, version and at most one state badge (Needs review, Error, Update,
Loading), then the switch — or "Review & enable" while required access waits
for approval — and a chevron; the row opens the package's detail. Rows are
alphabetical. With no packages the section shows one invite that is also a
drop target; a ZIP dropped anywhere on the library opens the installer with
it.

- **Adding a package is a dialog** with two tabs, From a file (drop or pick a
  ZIP) and From a link (an archive URL or a supported forge repository; GitHub
  links show the repository/ref and CLI/SSH access, other forges the resolved
  archive URL; fork and auto-update options). The panel keeps one height so
  switching tabs never resizes the dialog. Install stays disabled until the
  shared source contract accepts the value; submissions are blocked while one
  is in flight and a failure keeps the file or link for a retry. A new
  package opens straight onto its detail — its permissions when it needs a
  review.
- **The detail replaces the page** (Back, not a modal): a hero with the mark,
  name and version, status badge and runtime, the one primary control (the
  switch, an update, or "Review & enable") and an overflow menu (reload, check
  for updates or upload a new version, roll back, uninstall). Tabs: Overview
  (description and summary, the screenshot gallery, a facts list grouped as
  adds / access / runtime plus tags and source, the trust note, and a danger
  section to uninstall), Permissions (a review card with the one primary
  action of the view while access waits for approval, access in plain
  language with its constraints, then what is already approved), Updates
  (source, latest version and checks, automatic updates, fork integration,
  rollback), Contributions (grouped by the shared classifier labels, with the
  titles the manifest declared) and Logs.
- **Feedback is in place**: badges, switches and section text change; outcomes
  are announced politely; errors stay inline (`ErrorState`). The library
  shows no toast of its own.
- **Author imagery is host-served.** Declared screenshots render as a 16:10
  framed stage with a thumbnail rail in the Overview and an uncropped viewer
  (a `Dialog` portaled to the body, scoped by its own class). A package
  without a glyph uses the shared package mark.
- **Taxonomy and labels are derived, not declared.** Classifier labels and
  their order come from `@polyth/package-sdk/classify`; registry contribution
  kinds map onto those classifiers in `pluginTaxonomy.ts` (a test keeps the
  map in step with `managedRegistry.ts`); every capability has a
  plain-language label in every locale.

### 4.6 Web reducers (`host.reducers.register`)

Client-side reducers that run whenever an event of a matching `eventType`
arrives, in addition to the shell's built-in `reduce.ts` derivation. The
reducer must be pure and must not append events (it derives UI state only).
The type must be `domain/past-tense`. Currently no in-tree package uses this
seam — the built-in reducers in `reduce.ts` are the model to follow; keep the
reducer DOM-free so it can be unit-tested with `node:test`.

### 4.7 Workspace layout, package lifecycle, and project context

A Project is a stable container. Packages are independently enabled, activated,
and disposed. Several packages may contribute to one Project at the same time.

**Purpose-specific chats.** A profile may declare `sessionPurpose` to own a
separate conversation lane. Session creation persists the corresponding optional
`purpose`; absent purpose means ordinary chat. Only a purpose some package
actually declares names a lane: a marker purpose (the workflow package's
`workflow`) is session metadata and stays in the nearest ancestor's lane — an
ordinary chat when the session has no package ancestor — instead of disappearing
from every list. The host owns routing, remembered
sessions, list filtering and draft separation. Server packages may register
per-turn instructions through `SESSION_PURPOSES` during `onEnable` and dispose
the registration during `onDisable`. Instructions travel through canonical
user-message context before delivery, rather than synthetic initialization turns.
While a purpose lane is active the phone navigator names it in a Chat/lane
switch above the list, because the header's lane switch is hidden on a phone and
opening a lane's chat moves the phone into that lane; without it every other
project expanded onto nothing.
See [Playground](playground.md) for the artifact and legacy-session behavior.

**A purpose is package-owned for the session's whole life.** Disabling or
uninstalling a package removes its profile, so its lane purpose leaves the set of
available purposes. Such a chat must then belong to *no* listed lane — never fall
back into Conversation, which would surface a package's chats as ordinary chats
the moment its package is turned off. `sessionsInLane` enforces this; opening an
orphaned chat still works through `laneProfileFor`. The host also remembers each
purpose's owner package (`ownerOfSessionPurpose` / `sessionPurposesOfPackage` in
`workbench/profiles.ts`), stamped by the activation scope and cached per device,
so attribution survives the package being off and a page reload.

**Disabling a package that owns chats.** Before turning such a package off, the
Packages settings page counts its lane chats (roots and every delegated
descendant, resolved by the same lane rule) and asks: clean up (permanently
delete them and their history) or hide (archive them, restorable). Cancel leaves
the package enabled. A package with no chats of its own disables with no prompt.
The flow is generic — it never names a package — and lives in
`apps/web/src/packages/packageSessions.ts`, pinned by
`apps/web/test/packageSessionCleanup.test.ts`.

**Identity.** The owner package id (manifest / server descriptor, e.g.
`dictation`) controls lifecycle and ownership. Semantic contribution ids
(settings route `voice`, capability `voice`, widget group `voice`) are
caller-defined routing/grouping names. Aliases such as `dictation → voice`
affect enablement lookup (`isPackageEnabled("voice")`) — they do not rename
user-facing routes. Do not namespace every semantic id as `packageId:id`.

**Package web lifecycle.**

```
manifest discovered (metadata only)
  → server says enabled
  → CSS attached for this activation
  → module loaded
  → activation scope created
  → factory / installer
  → contributions live
  → disable
  → package cleanup + scope disposal + that activation's styles removed
```

Disabled packages do not import modules, run factories/installers, attach CSS,
or register contributions. Dynamic `import()` is treated as activation-like
and is not used for disabled packages. Failed activations are isolated and
retryable on a later enable/reconcile; they leave no partial CSS or
registrations.

**Collision.** Cross-owner replacement throws. Same-owner replacement is
allowed and identity-safe (a stale unregister cannot delete the new
registration). Reducers compose per event type and are not exclusive.

**Widget layout** is project-scoped presentation state. The local record
(`polyth.widgetLayout.<projectId>`) is the synchronous cache and is mirrored
to the server through `/api/projects/:id/settings` plus the project-presentation
WS frame. Open pane/tab state and Files/Git/Terminal selection remain local to
the device. Missing storage seeds
`createDefaultWidgetLayout()` from the live catalog; existing storage is
preserved. A widget that acts on the agent's turn declares `agentOnly`; slot
hosts drop it when their context says `agentless` (people-only composers).
`defaultVisible` (and `DEFAULT_VISIBLE` / `requiredVisible`) applies
when a widget is **first seen** by `ensureWidgets` / parse — including when a
package activates after the workspace already hydrated. Existing known widget
visibility is never reset. Recommendations never hide unrelated widgets.
Explicit **Reset workspace** in Customize is the destructive path.

Disabling a package unregisters live UI. Persisted layout placements remain
until the user edits them. Package-owned server data and local preferences are
not deleted.

**Project context** is a live, composable projection — not a Project Type and
not a persistence bag. Each package owns its functional state and may register
`host.projectContext` snapshots (`null` = not applicable). Core aggregates
them into the existing Context surface and merges `recommendedWidgetIds` into
Widget Library ranking together with `WidgetDefinition.recommended` and core
`RECOMMENDED_WIDGET_IDS`. Setup, when needed, is a non-blocking package-owned
action (settings, surface, or dialog). Opening a folder still goes straight to
a usable workspace and composer. The Git package is the in-tree example: it
projects the cached branch for the active project and recommends `git.recent`
without classifying the Project.

Opening a folder adds or activates the Project and focuses the composer; there
is no classification question.

**Sidebar project presentations.** Tree mode nests sessions under expandable
projects. Clicking a project in the phone navigator, desktop tree, or Project
rail only toggles its sessions; it never activates the project, changes the
current session, or closes the navigator. The rail's browsed project is local
presentation state, independent of the active workspace. Opening a session or
using an explicit project action still navigates normally.
Phone project headers are one vertically centred line: the name truncates and
the status pills keep their own width beside it, expanded or collapsed, so the
name never moves. Pills run most urgent first (running, waiting, failed,
paused, finished); when a narrow phone cannot fit them all, the name keeps a
readable stub and the pills that do not fit drop whole from the end (the
group's label still lists every count). An expanded project with nothing to
list says "No sessions".
The phone Navigator is one grid (`MobileNavigator.css`, pinned by
`mobileNavigatorLayout.test.ts` at 320–430px, every density and RTL). Most
rows leave the leading column empty and every row ends in ⋮, so both edge
columns are kept to what their marks need. Project marks are 24px tiles on an
8px content edge; a session's state mark is centred in the same leading
column, and search's Back glyph on that column's centre, 20px from the
screen, never further in than the ⋮ column, so the start side carries no
extra margin. Names, titles, pagination and the empty text share one start
edge 40px in (gutter + mark + 8px). On the end side close, project ⋯ and session ⋯ glyphs share one
column 24px from the screen (`--nav-axis`): the thumb aims at the glyph and a
phone's rounded edge and case lip make the last few points hard to press, so
the end column sits a little further in than the start side (close's ink
lands on the platform's 16pt margin) while every target still runs out to the
edge. New chat and every ⋮ draw the same 28px press circle centred on that
axis (`--nav-dots-wash`), whatever the axis. A row's trailing marks (isolation, merge,
running clock, an agent's next wake) end 12px clear of the ⋮ dots
(`--nav-mark-end`, 37px from the screen): the body runs `--nav-mark-tuck`
into the ⋮ control's 44px target. A
title with no marks runs to that same edge (the row grid has no column gap,
each present mark brings its own 8px lead-in), so the last few pixels of a
long title sit over the ⋮ target; only a subagent pill, a real control,
stays clear of it. Rows keep a 6px edge for the current row's rounded wash.
Small phones (≤360px) use a 6px gutter, a 20px end column and a 4px edge.
The toolbar is the title and four tools. The title is the active Space's
name on the content edge, at a project name's size and a firmer weight; in
the native app it opens the native server menu (the separate Switch server
tool is gone), with several Spaces it is the Space switcher whose last entry
is the server menu, and with nothing to choose it is plain text (the page
never learns a paired server's name). The tools are search, select, Settings
and close. Add project is a quiet last row of the list (a dashed tile in the
mark column, the label on the name edge), hidden while searching or
selecting. The search field is not on screen until the search tool is
tapped: the pill starts as a glass circle on that tool's press wash and
stretches to full width on the stack curve (`--motion-stack`, the keyboard's
clock) while the title and tools drift back, fade and turn inert; Back and
the field's icon, input and filter fade in once the pill is mostly open, so
nothing shows half-clipped. Its input takes focus inside the tap so iOS
raises the keyboard. Back, Escape and Android Back fold it into the tool
again on the quicker `--motion-surface` (contents first, then the pill,
then the title row returns), clear the query and return focus to the tool —
quietly after a tap, with the ring after a key. The input draws no focus
ring (the caret marks it; a text field matches `:focus-visible` on every
focus), and the bar tools' keyboard ring is their round wash, not the slot.
Sort and filter is a circle in the field's round end cap, and a choice
away from the default puts a dot on the search tool as well. The field is
the tools' 44px height and ends on the content edge.
The toolbar's tools are the bar's primary controls and each keeps a full
44px box: their glyphs sit one tap step apart (`--nav-tool-step`, the tool
pitch), and close's box runs from half a step inside its glyph out to the
screen edge. A project's New chat and ⋮ step like a chat row's marks toward
its ⋮: 12px of air between neighbouring glyphs, New chat ends on
`--nav-mark-end`, and status pills stop 12px before New chat. Their press
wash is a circle round the glyph. Project targets are the full row height
and split the room between neighbouring glyphs, so a tap never lands
between two actions, but they are narrower than 44px (never below WCAG
2.2's 24px): the exception `styles.md` records for trailing icon clusters. Search's Back and a row's ⋮ keep a 44px target that runs out
to the edge through a transparent `::after`; press rules set
`background-color` only.
Hierarchy is size and weight together: a project name uses the user's
subheading size at 650, its chats the activity-title role at 500, so a chat
title never outranks its project; a subagent count is metadata caliber.
What repeats on every row steps back without leaving: session, project and
agent ⋮ use the quiet ink (`--nav-quiet-ink`, at least 3:1 on every theme)
and identity marks (isolation, merge, sharing) the matching
`--nav-quiet-mark` opacity, while the pin keeps its accent and the current
row's ⋮ is one step firmer. Pinned chats are grouped by their caption
alone: no row tint (it read as a second current row) and no pin glyph inside
the group. Captions (dates, Pinned, the Agents header) share one faint voice;
only the Pinned glyph keeps the accent. A failed row keeps a faint red wash,
quieter than the current row, and subagent titles step down one ink level
from their chat. A picture project mark fills its tile like an app icon;
glyph marks keep the quiet tile. Titles and names carry
`dir="auto"`, so one written in the other script direction truncates at its
own end and keeps its first words. Navigator controls inherit the row's font
only through a zero-specificity reset, so a control's own type role wins.
Slot content inside a project joins the same grid: the Agents group
(`agents` package, pinned by its `hostPhoneAgentNavLayout.test.ts`) puts
its chevron and agent marks in the leading column, its label and agent names
on the title edge, ⋮ in the trailing column (the same circle and target) and
its trailing measure, a long name included, where session marks end, at a
session row's height. Its header is a caption in the
navigator's date-divider style; folded it is one more line of the list, open
it ends one rhythm step (8px) before the project's chats.
Phone session rows mirror the desktop geometry: the open button
(`.mobile-nav-session-main`) is an empty full-row tap surface, and
`.mobile-nav-session-body` paints above it with `pointer-events: none` in three
fixed columns — a leading state mark reserved on every row (running ring,
needs reply/approval, failed, unread dot; empty when idle), the title followed
directly by the subagent disclosure pill (chevron + count, a real button),
then meta: running time and the identity group (`session.list.badges`, then
pin) at the trailing edge beside the menu button. Running outranks unread for
the mark; unread still bolds the title. Active phone sessions use the row
background and title emphasis without a leading accent stripe.
Child rows use a compact tree indent capped at three visual levels so deeper
trees retain readable titles; the thread guide drops from the parent's mark.
The open button's accessible name includes the derived session status. Explicit
Rename focuses the inline field, retains a visible focus ring, and keeps a 16px
minimum input size above the navigator's inherited control font.
The tree's collapse control temporarily shows the collapsed Project rail
while keeping Tree selected; expanding restores the project tree. Choosing Tree
from the sidebar actions also restores it. Collapsing an explicitly selected
Project rail hides only the sessions column while keeping the project icons
visible, then expands back to Project rail. An older collapsed rail without a
saved return mode restores Tree once when expanded. Clicking the focused
project's icon in an expanded rail also hides the sessions column, after the
double-click window so a double-click cannot trigger it.
Add project and Settings are not fixed footer buttons: they are the
`shell.add-project` widget (shown in `sidebar.rail` by default, hidden for an
account that may not add projects) and the one `shell.settings` widget (in the
header rail by default; adding it to the Project rail moves it there). Both
reorder, move and hide like any rail item, so the rail never shows a fixed copy
beside a placed one. The footer holds only the rail's customization trigger;
it overlays the footer without reserving an empty
row and edits the rail's own icon area (`sidebar.rail`, above the footer),
not the sessions toolbar; while that editor is open the whole rail stays live
(`CustomizeZoneButton` `liveRegion`, Popover `keepInteractiveRef`), so its
icons still drag and sort. The sessions column's header row carries the
`sidebar.toolbar` pencil. The sidebar does not show a server connection status control.
In the wide shell's Project rail the focused project's row is the sessions
column's only header row: name and path, then Search, New chat, the list
options and ⋮. Widgets placed in `sidebar.toolbar` sit before Search. There is
no separate toolbar row. Search opens the field in that row's place at the same
height, so the list does not move. Escape or × clears and closes the field and
returns focus to Search. An empty field also closes when focus moves outside
its row. The toolbar row stays while a query is typed, or while a filter hides
the focused project, so the list options stay reachable. Selection lives in
the project's ⋮ menu there. The tree keeps its toolbar row with the select
toggle. The list-options button lights only for a filter (Needs attention or a
date filter). The layout, sort and grouping choices in the same menu do not
light it.
The compact drawer's sort button lights only for a non-default sort. Covered
by `apps/web/test/sidebarFolderMode.test.ts`.
Each project tile carries a live status dot: green while any of that project's
sessions works, amber when one needs attention. The socket keeps active rows
from every project current as summary projections, so the dot appears and
clears without opening that project.

**Primary workbench profiles.** A package profile opts into the same top-level
switcher as Chat with `presentation: { navigation: "primary" }`. Profiles without
that marker remain internal layout recommendations and are not exposed as
primary destinations. The switcher shows Canvas only for projects that turned
it on (see [Canvas is off by default](widgets.md#the-canvas-is-a-workspace-surface-not-a-separate-app)),
so a disabled-by-default package profile never appears there uninvited. Each
primary profile has a project-scoped
  remembered session lane; Chat and Canvas share the `conversation` lane. The
  host captures the current lane before switching, restores its remembered
  canonical session (or a fresh unsaved chat), and mirrors the profile's active
  non-session surface through the current companion-window host. The Playground
  profile additionally enters a focused split mode: its chat is armed on entry,
  the project rail is the sidebar's resting presentation, and the selected
  project's worktree/session pane is initially visible beside the rail so branch
  navigation is not hidden. The two surfaces can be resized or exchanged
  through the host-owned workbench controls. A focused profile declares this
  through presentation hints (`focused`, `sidebar: "projects"`, and a
  two-surface `splitSurfaces` list); the host does not branch on a package id.
  Any profile may also declare `mirrored: true` (`WorkbenchShellHints`; the
  legacy `sidebarSide: "end"` means the same): see **Mirrored shell** below.
  The `ide-mode` package uses it for IDE mode: the ordinary focused split
  (chat primary, the Files surface at the end) laid out mirrored, so Files
  (tree + editor) comes first, chat beside it and the session sidebar with its
  project rail at the end edge; ordinary chats (no `sessionPurpose`). Files
  follows each chat's edits in every profile (`WorkbenchFilesHints.openSessionEdits`
  is on unless a profile sets it to `false`; [workspace.md](workspace.md#files-panes-and-editor)
  describes the change colours, attribution and review bar). The Tasks profile is not a split: it is an optional
  home-surface tab (the board over the whole workspace, like Canvas; below). A
  project record the person never arranged follows a package template whose
  split order was exchanged, a customized one is kept (`workbench/store.ts`).
  Two typed size hints (`WorkbenchFocusedSplitHints` in `@polyth/web-sdk`)
  are read only for focused profiles and validated as untrusted data:
  `companionWidth: { min, target, max }` turns the split into the focused
  split of §4.2 (work surface flexible, Chat a fixed companion; IDE
  declares `{ 360, 440, 560 }`), and `sidebarRailBelow: <px>` rests the wide
  sidebar on its project rail below that viewport width while the profile is
  active (IDE declares 1600). The automatic rail is in-memory presentation
  (`sidebarLayout.ts` `setAutomaticSidebarRail`, published by `App.tsx`): it
  never writes `polyth.sidebar.layout` or the account setting, and expanding
  it by hand releases it until the condition next becomes true. Deleting the
  property removes the behavior. Opened from Chat (outside the profile) the
  Tasks board stays a companion at `defaultRatio: 0.45`. Packages
still provide content and layout metadata; the host owns buttons, window
geometry, focus, responsive behavior, and restoration failure handling.

**Mirrored shell** (`apps/web/src/shellDirection.ts`). While a profile with
`mirrored: true` is active in the wide shell (≥961px; never on compact or
phone), the host lays the shell out from the other edge without a second
layout: `App.tsx` sets `data-shell-mirror="true"` on `.app` and the flipped
`dir` on `.app-shell`, and gives the document direction back to each content
root (`.workspace`, the sessions column's `.sidebar-main-content`, which is
`display: contents`, and the rail window's `ModuleView`). Every frame
inherits the flipped direction, so flex and grid order, logical borders,
radii, insets, `:dir()` rules and the `--stack-dir` motion sign all mirror
together: the sidebar and its project rail sit at the end edge with their
rounded corners and resize handle toward the content, the launcher strip and
docked windows at the start edge, windows glide in from the strip's side,
panel glyphs turn with their frame (`.sidebar:dir(rtl)`, `.rail:dir(rtl)`),
toasts take the strip's corner and the header title stays centred over Chat
(the header itself never mirrors, so the view tabs never jump). The mirror is
profile-level: closing the work surface keeps the sidebar where it is. The
account preference Appearance → Window layout → **Mirror layout**
(`ui.mirrorLayout`, default off) mirrors every profile the same way; IDE mode
is mirrored either way.
Rules for frame CSS: write it logically (`inset-inline-*`, `border-inline-*`,
`border-start-*-radius`, `padding-inline-*`), multiply horizontal transforms
and shadow offsets by `var(--stack-dir)`, and key direction-specific
exceptions on the frame's own `:dir(rtl)`, never on `html[dir]` (an RTL
locale is the same mirror). Chromium resolves logical insets with the
element's own direction, so frame chrome rendered inside a content root
(the sidebar resize handle) sits outside it. JS that needs the side reads
`useShellDirection()` (`towardEnd`/`towardStart` for flyouts) or the frame's
computed `direction`, never `document.documentElement.dir`. The focused
split's grid row is the shell's height (`grid-template-rows: minmax(0, 1fr)`):
an implicit row grew to the tallest region's content, so a long session list
pushed Chat's composer below the window.

**Window layout** (`apps/web/src/shellLayout.ts`, Settings → Appearance →
Window layout). In the wide shell the account can run the side columns the
full window height: `columns` keeps the top bar between them (spread or as an
island capsule), `bare` removes it. `resolveShellLayout()` gives every
top-bar group exactly one home — the bar, the navigator column (`start`) or
the launcher strip (`end`) — and tablet/phone always resolve to `classic`.
`columns` and `bare` keep the Polyth mark out of the navigator column, so
that column starts with its own controls; `bare`
also docks the tools and the header actions where the account chose
(`shellToolsDock`/`shellActionsDock`, `hidden` leaves them to the command
palette). The account menu travels with the header actions to the foot of
the same column; when the actions are hidden it stays at the navigator's foot
so its menu remains reachable. A fresh install starts `bare` with
**Floating columns**, the tools in the launcher strip (`end`) and the header
actions plus the account at the foot of the navigator (`start`), where the
docked Settings stands in for the rail's own gear — one Settings button. A
saved record without these fields keeps the window it was built with
(`classic`, actions `end`). Docked groups are the
bar's own components (`CapabilityNav`, `HeaderActionsRail`, `UserMenu`)
rendered once through `ShellDock` in `Sidebar` and
`ContextRail`, so order, customisation and drag targets stay the same; a
vertical group reorders on the `y` axis and carries
`data-orientation="vertical"`. "Start"/"end" are logical: a mirrored shell or
an RTL locale swaps which screen edge they name, and the settings labels
follow. Styling contract: [styles.md → Window layout](styles.md#window-layout).

**Optional and home-surface profiles** (`workbench/profileNavigation.ts`,
`workbench/profileOffers.ts`). Two more presentation hints, again without the
host branching on a package id:

- `optional: true` makes the tab opt-in per project, exactly like Canvas. The
  switcher lists the profile only once the project offers it (or while this
  device still sits in it), and `host.workbench.activateProfile` refuses an
  unoffered one. The choice is the project presentation key
  `workbenchProfiles` (`{ [profileId]: boolean }`, localStorage
  `polyth.workbenchProfiles.v1.<projectId>`), shared through presentation sync
  like `canvasEnabled`. It is toggled from the header's view-tabs editor
  (beside Canvas, see [view tabs](#view-tabs)) and from
  `Settings → Projects → <label> tab`; choosing an unoffered tab offers it,
  withdrawing the tab this device shows returns it to Chat.
- `homeSurface: "<surface id>"` makes the profile that surface over the whole
  workspace, the way Canvas replaces Chat: entering it always presents the
  surface fullscreen (reload and session-boundary rules that return fullscreen
  to its docked home do not apply), its window offers no pin/fullscreen
  toggles and ignores Escape, and closing it for any reason (close control,
  launcher toggle, a session opening) returns the device to Chat with the
  session that is active then. The profile shows no chat, so it keeps the
  active session instead of switching to a remembered or fresh one.
- `homeSurface` together with `sessionPurpose` makes the surface the **home
  of its chat lane**: the lane's chats are the surface's documents, and the
  surface covers them. Session navigation that stays in the lane keeps the
  window up (`setSessionPaneKeeper` in `store.ts`, registered by
  `profileNavigation.ts`: `activateSession`/`showSessionChat` consult it before
  closing a non-pinned window), and any other chat boundary inside the lane — a
  new chat, the chat a first send creates, another lane chat picked while the
  window was closed — presents it again. An explicit close (its close control,
  or the surface's own "open conversation" action) only reveals the lane chat
  beneath it; the tab stays, and entering it again (`activateProfile`, the
  header tab) brings the surface back. A chat of another lane still closes the
  window and lane capture routes its profile. Pinned by
  `apps/web/test/laneHomeSurface.test.ts`.

The Tasks package (`task-trackers`) is the reference: its `tasks` profile is
`optional` with `homeSurface: "task-trackers"`, and its rail launcher only
opens the board as an ordinary window. Creative Studio is the lane-home
reference (`homeSurface` + `sessionPurpose: "creative-studio"`); it renders
its own "Back to the studio" control in the `session.composer.before` slot of
its revealed chats.

### 4.8 Store, navigation, ui, errors (`host.store`, `host.navigation`, `host.ui`, `host.errors`)

- `host.store` exposes the shell's render state: `getSnapshot()`,
  `subscribe(listener)`, `select(selector)`. Prefer `select` for reactive
  reads; the snapshot shape is `WebStoreSnapshot` in the web-sdk.
- `host.locale.get()` returns the resolved interface locale (also on
  `<html lang>`). Settings → General → Language defaults to **System**: with
  no stored `polyth.locale`, `apps/web/src/i18n/index.ts` matches
  `navigator.languages` in order against `LOCALES` (base language, `pt-BR`
  vs `pt`, Simplified Chinese only — Traditional falls through) and falls back
  to English. Only an explicit pick is stored; choosing System clears it. The
  system language is read at load, not followed live. First-run setup and the
  interface tour carry the same choice up front (`LanguagePicker.tsx`: the
  language glyph plus the current language's own name); there it switches in
  place, keeping the setup step, typed fields and tour step. The iOS app declares
  `CFBundleLocalizations` so WKWebView reports the device language instead of
  `en-US`.
- `host.navigation` — `setActiveView(view)` for built-in shell navigation,
  `openSettingsPage(pageId, target?)` (where a page-local target may carry
  `itemId` and `sectionId`),
  `openWorkspacePane(surfaceId, resource?)`, `closeWorkspacePane()`,
  `openPage(pageId, resource?, { projectId? })` and `closePage()` for package
  pages in place of Chat (§4.3), `openRailSurface(surfaceId)`,
  `setOverlay(overlay | null)`.
- `host.workbench.activateProfile(profileId)` activates `conversation` or an
  available primary-navigation profile. `getProfileSession(profileId)` reads
  that profile's remembered session (`undefined` before first entry, `null`
  for a fresh unsaved chat). Internal layout-only profiles are not activated
  through this public compatibility command.
- `host.conversation.send(sessionId, text, { delivery? })` targets an explicit
  canonical session without changing the visible profile. Use it only for an
  explicit user action such as a cross-profile handoff, or voice mode talking
  to its pinned conversation; `normal`, `queue` and `interrupt` are the
  supported delivery modes (`queue`/`interrupt` only change anything while a
  turn runs). It never dismisses a pending permission/question request.
- `host.conversation.dictate?(update)` streams a spoken transcript into the
  mounted composer as a run-scoped span (`{ runId, text, final, discard? }`,
  `text` always cumulative). It edits only the draft — never a canonical turn —
  and returns false when no composer took it. An empty `text` changes nothing;
  only `discard: true` takes the run's words back out (a spoken command), and a
  discarded run is never queued for a later composer.
- `host.conversation.submitDraft?({ delivery? })` sends the mounted composer's
  draft exactly as its Send control would (same target, new-session creation,
  model, attachments, follow-up delivery). `delivery` (`queue`, `steer`,
  `interrupt`) overrides the user's follow-up setting while a turn runs. Only
  the first mounted composer acts, an IME composition refuses, and nothing is
  queued for a later composer; a refusal surfaces in that composer. Voice mode
  is the consumer: an automatic send is reserved for an explicit hands-free
  mode the user started.
- `host.execution?.describe(tool, input)` reads a tool call the way the
  timeline cards do (`describeToolActivity`, `apps/web/src/execution.ts`):
  `{ kind, target? }`, where `kind` is the card's classification (`plan` for a
  native todo tool) and `target` a short speakable subject — a file name,
  program, plain search words, site host or MCP service, never a full path,
  command line, regex or content. Voice mode uses it for its status line and
  spoken narration; packages feature-detect it.
- `host.conversation.startNewSession(projectId, seed?)` opens an unsent draft.
  The optional seed carries `title`, `draft`, `worktreePath`, `repositoryIds`
  and `isolate`. `isolate: true` preselects a managed isolated workspace;
  neither a session nor a checkout is created until the user sends. The
  checkout choice survives scoped draft recovery and can be changed in the
  composer. An unavailable isolation origin must never fall back to creating
  an ordinary session. With isolation on, the branch picker still lists every
  local and remote-only branch: isolation merges back into a live checkout,
  so a branch without one is checked out in a linked worktree on send and
  isolated from there. Isolation is opt-in per project: until Settings >
  Projects > Session isolation sets `ProjectDefaults.isolation` to
  `workspace` (a managed Git worktree), no isolation control or menu entry
  exists and an `isolate` seed is ignored. A virtualized-environment level is
  planned and shown as "Later"; it is not a valid stored value yet. Without a
  seed choice, the project's `isolateByDefault` preselects isolation; the
  chat's own choice always wins, and the default never applies to (nor shows
  the control in) a project without a Git checkout. The legacy
  `worktreeBehavior: "fresh-worktree"` implies the `workspace` level unless
  `isolation` is explicitly `off`. Existing-checkout paths and repository IDs
  are still validated by the canonical creation boundary.
- `host.conversation.revealEvent(sessionId, eventSeq, { focus?, signal? })`
  opens the canonical conversation and reveals a visible message. Older
  history loads through the existing paged path and the render window grows
  to include the target. It resolves `false` when the message cannot be
  displayed or the bounded request expires. A newer target, cancellation,
  navigation or identity change supersedes the request. Callers can use
  `focus: false` to retain input focus; ordinary navigation focuses the
  message. This optional host seam appends no history or runtime input.
- The browser-safe `@polyth/session/conversation` export provides displayed
  user/assistant text and literal Unicode search offsets from a caller-scoped
  canonical log. It follows effective rewind history, hides internal prompts
  and leading recovery wrappers, and replaces streaming chunks with the final
  message. Callers can derive search/export content beyond the loaded UI
  window; provider/model history keeps its own derivation.
- `host.ui.icons` — the canonical icon map (`apps/web/src/icons.tsx`);
  `host.ui.Dialog` — the shared accessible dialog (use it instead of a new
  modal primitive).
- `host.errors.friendly(action, cause)` — user-presentable error strings;
  use it for action failures instead of inventing a second phrasing. It strips
  JSON envelopes and proxy/gateway HTML bodies (`errorBodyText`) so raw markup
  never reaches an error surface.
- `host.errors.show(message, action?, { kind? })` — the host's one transient
  error (`setUiError(message, action, dedupeKey?, kind?)`). It is drawn as a
  notification of the stack below (`kind` `error` by default; `warning`/`info`
  for a calm word that is no failure, e.g. "Nothing to compact yet") and keeps
  its own rules: a newer error replaces the current one, the same text raised
  again is a new occurrence (`uiErrorSeq`: re-shown, lifetime restarted), a
  keyed error (`dedupeKey`) is never replayed in the same tab, and a
  connection-loss error raised while the system is healing (`syncCatchUp.ts`)
  is held out of sight and dropped once the screen is confirmed current. While
  `ConnectionFeedback` is mounted the notification's pausable countdown is the
  error's only lifetime (`claimUiErrorLifetime`); without a presenter the
  store's 7 s fallback timer still clears it.

<a id="notifications"></a>**Notifications — the single transient standard
(`host.notifications`).** Every passing message — an error, a finished run,
a new version or its download, a hint, news — is one notification of the
host stack (`apps/web/src/notify/`: `store.ts` owns identity and lifetime,
`NotificationStack.tsx` is mounted once by `App.tsx`, `notify.css` is the one
visual standard). Do not portal a bespoke toast, banner or floating card; a
contextual status line that belongs to its control (a form error, "Saved"
beside a toolbar) stays in place.

- `show({ id?, kind, title, body?, excerpt?, icon?, actions?, progress?,
  duration?, dismissible?, dismissLabel?, data?, onDismiss? })` returns
  `{ id, update(patch), dismiss() }`; `update(id, patch)` and `dismiss(id)`
  address it by id. Showing an existing `id` again replaces it in place and
  moves it to the front; `update` changes it without moving it and restarts
  its countdown only when the patch names a `duration`. Ticks (progress, a
  running clock, a busy flag) go through `update`, a new stage through `show`.
- A package's `host.notifications` is scoped by its activation
  (`packages/activation.ts`): its ids are stored as `<package>:<id>` (the
  handle reports the package's own id), it can update or dismiss only what it
  showed, everything it left on screen is dismissed when it is disposed, and
  `show` after disposal is refused.
- `kind` (`error`, `warning`, `success`, `info`, `progress`, `update`,
  `news`, `hint`) picks the glyph and tone (shared with the notification
  centre through `notify/NotificationGlyph.tsx`) and the default lifetime
  (error/warning 7 s, success/info 5 s, hint 8 s, news 10 s, progress/update
  sticky). Tones: error red, warning amber, success green, news purple; the
  accent marks what the app itself is doing (`progress`, `update`); `info` is
  neutral (muted glyph on an 8% text wash); `hint` is teal, mixed from the
  theme's green and blue so it never reads as the accent. `icon` replaces the
  glyph (a package mark); `excerpt` is a short monospace block (output tail)
  that runs full width under the title; `progress` 0..1 draws a bar, `null`
  on `progress` shows a spinner.
- The shell (never a package) also shows the people kinds `mention` and
  `message` (10 s / 8 s). With a `conversation` record field the card draws
  `notify/ConversationCard.tsx` instead of glyph, title and body: the
  message card described in "People in a chat" (§3). Its `title`/`body`
  remain what a screen reader hears.
- Announcements: cards are labelled groups, never live regions. The stack
  keeps one polite and one assertive visually-hidden region mounted and says
  "title — body" (body as plain text) once per new notification, fresh `show`
  or kind/title change — `error` assertively, everything else politely. Body,
  excerpt and progress patches are not re-read.
- `actions[]`: `{ label, run, primary?, icon?, iconOnly?, busy?, disabled?,
  keepOpen? }` — an action closes its notification unless `keepOpen`; at
  most one is `primary`; `iconOnly` actions sit at the trailing end with
  `label` as their accessible name.
- `onDismiss(reason)` reports `user` (close button, Escape on a focused card,
  swipe toward the inline end — on phone also a flick up toward the header —,
  an action, or "Clear all"), `timeout`, `programmatic` or `overflow` (more
  than 24 records); a replacement by id is not a dismissal.
- Only the newest three are on screen; the rest wait, not counting down,
  behind a "+N more" button inside the stack that opens the deck (with
  "Clear all" past three waiting). More than one fold into a deck that opens
  while the person is on it (hover, focus, touch). Only readable cards count
  down: all visible ones while the deck is open, only the front one while it
  is folded (folded cards keep what they had left; the hairline resumes from
  `notificationRemaining`, it never restarts). Every countdown pauses while the
  person is on the stack and while the page is hidden. Phone: under the
  session header, newest on top, body one step under the title; desktop:
  bottom-trailing corner above the status bar, newest at the bottom. On touch
  the close and icon-only actions keep a 24 px look with a `--tap` hit area.
  Motion is transform/opacity only (spring enter, sibling reflow by
  transition, exit ghost) and stops under reduced motion, the in-app setting
  and low-resource desktop. `data` adds `data-*` attributes for package
  styling hooks and tests; keys must match `/^[a-z0-9-]+$/` (others dropped).
- Producers: `setUiError`/`host.errors.show` (`host.ui-error`), the desktop
  updater (`host.desktop-update`; a new stage is a fresh notification, progress
  an in-place update), a newer web build found on resume while the page is
  healthy (`host.web-update`, Reload / Later — `buildFreshness.ts`
  `offerReload`; a chunk-load failure still reloads silently), sandboxed
  packages' `ui.toast` (`sandbox.<package>.<n>`: plain text,
  `info`/`success`/`error`, at most three per runtime, under the render rate
  limit, dismissed with the runtime), custom-action runs and new actions,
  task-tracker board outcomes. There is no news
  feed today: a package or host feature announcing something new shows a
  `news` notification with a stable id from its own source of truth (for
  example a release note it fetched) — never placeholder content. Durable
  records the person must be able to find later belong to the notification
  centre (server `NotificationRecord`s), not here.

### 4.9 API transport (`createApiTransport`)

`createApiTransport({ baseUrl?, fetch?, onUnauthorized? })` gives package UI
a typed fetch wrapper over the REST surface (`get/post/put/patch/delete`,
`ApiError` with `status`/`code`). Use it for package-owned endpoints instead
of raw `fetch`.

### 4.10 Status bar (opt-in shell chrome)

The bar under the workspace is **off by default**. Settings → Appearance →
Layout → Status bar (`UiSettings.statusBar`, account-synced; the palette command
"Status bar" flips Off ↔ Always) chooses `off`, `workflows` (a slim strip only
while a contributed `statusbarStrip` widget has something to show — today the
workflow package's run segment — in any view) or `always` (the full bar). The
phone shell never mounts it. Off renders nothing and starts no Git scan.

- `components/StatusBar.tsx` is the host: it reads the mode, derives one
  `StatusbarModel` (`statusbar/useStatusbarData.ts` — one serial Git scan of the
  repositories in scope) and publishes it through
  `StatusbarModelContext`. Its two ends are widget areas,
  `app.statusbar.leading` and `app.statusbar.trailing`, each a `SlotHost` plus a
  drop target, with the shared Customize pencil (Shift over the bar, or Edit
  layout). Arrangement is per project like every other area.
- The built-in segments (`widgets/statusbarWidgets.tsx`: project + connection
  dot, Git branch, open file, changed files, model, agent, current view) are
  ordinary mini-widgets registered with `defaultVisible: true`, so they are
  added, hidden, reordered and moved between the ends the same way as any other
  widget. They only read the published model; one placed where no status bar
  provides it renders nothing. The workflow segment belongs to the workflow
  package (`packages/workflow/widgets/WorkflowStatusbarSegment.tsx`, its own
  poll and styles); it is `requiredVisible` — a run waiting on the user can
  move but not be hidden — and flagged `statusbarStrip`, which is how the
  `workflows` mode finds it without the host naming the package.
- Search, Settings, the notification bell and the workspace-tool launchers list
  both areas in their `supportedSlots`. The Customize menu also carries "Hide
  status bar". A package contributes its own segment by registering a
  mini-widget whose `supportedSlots` include the areas; it fetches its own data
  (`useStatusbarModel` is host-internal). Package segments today, all
  `defaultVisible` (at the trailing end unless noted), hideable and movable, and rendering
  nothing when they have nothing to say: `peak-pricing.statusbar` (peak /
  off-peak of the session's or new chat's route, with the pricing card on
  click) and Usage's `usage.statusbar.context` (tokens, level-coloured share,
  session spend), `usage.statusbar.cache` (prompt cache time left / idle /
  expired) and `usage.statusbar.limits` (the current route's limit that runs
  out first) and `usage.statusbar.turn` (live turn timer, then the last turn's
  time and tok/s); the Usage ones open the matching Usage view. The Todos
  package adds `todos.statusbar.progress` (done/total and the current step,
  at the leading end)
  and `todos.statusbar.background` (running sub-agents and queued messages),
  each with a detail popover. Their rules live in each package README. The
  desktop shell adds the host-owned `desktop.keep-awake` cup
  (`apps/web/src/desktopKeepAwake.tsx`; [desktop](desktop.md#background-integration)).
- Space is handled by `statusbar/fitSegments.ts`, not by truncating everything:
  an end that is too narrow drops whole segments, **last first**, and they leave
  the tab order. A segment (or any widget element) carrying `data-fit-keep` is
  dropped only after everything else, which is how a waiting workflow stays
  visible. Long names are capped with an ellipsis and a tooltip, never squeezed.
- Styling is `components/StatusBar.css` and follows the preferences: density
  (`--density-scale`), corner rounding, font size, glass (the `.statusbar` entry
  in the shared glass lists), touch hit size (`--hit-min`) and the bottom safe
  area. No border is drawn, because "Hide interface borders" is on by default;
  the workflow package's spinner is a masked arc for the same reason.

### 4.11 Markdown fence renderers (`host.markdown.registerFence`)

A package may render fenced Markdown blocks of named info-string languages
instead of the host's code frame. `@polyth/chat-blocks` uses it for the
agent-written ```` ```ui ```` fence and the ```` ```page ```` fence (a
self-contained HTML page in a script-only sandboxed iframe under a no-network
policy; format and security model: `packages/chat-blocks/README.md`).
The fence context carries `conversation: true` only for an agent's answer in
the timeline (`renderMarkdown(…, { conversation: true })`); a renderer that runs
code waits for a click everywhere else (files, issue/PR bodies, prompts).

- The registry is `apps/web/src/markdown/fenceRenderers.ts`. `CodeBlock` in
  `markdown/render.tsx` asks it first, so every Markdown surface (chat,
  multirun/fusion output, file preview) gets the renderer. The host keeps
  `mermaid` and `json`; a language owned by another package is refused; names
  are lowercase `[a-z][a-z0-9_-]{0,31}`. The scoped activation host stamps the
  owner and disposes the registration when the package is disabled, which
  restores the plain code frame.
- The renderer receives `text`, `info`, `closed` (false while the fence is still
  streaming — the host does not hold back lines inside a fence, so the
  renderer treats the trailing line as unfinished), `context` (`blockKey`
  stable per message + block position, `projectId`, `sessionId`,
  `conversation`, `reply` — below) and `source`,
  the host's own code frame for the same fence. Use `source` for a "show as
  text" toggle and for input the renderer cannot understand. A fence opener
  may carry extra info-string tokens after the language (for example a model
  writes `ui steps Plan` right after the opening ticks):
  `parseMarkdown` keeps the first token as `lang` and the rest as `info`, and
  `CodeBlock` passes the same tokens twice — as the `info` prop and folded into
  `text` as its first line, so a renderer written before `info` existed still
  sees them. `info` is the raw info string after the language, `""` when the
  opener carries nothing but the language, and `undefined` on an older host:
  prefer `info` and strip exactly one folded line from `text` rather than
  guessing from its content (a plain-text body's first line is not a title).
  When `info` is non-empty, `text` starts with exactly `info` + `"\n"` unless
  the body is empty, in which case `text` is exactly `info`. A
  language without a renderer keeps the plain code frame and drops `info` (as
  CommonMark does). A line whose text after the ticks contains a backtick stays
  a paragraph, so inline triple ticks in prose are not a fence.
- In an agent's answer, `context.reply` is the text of the first user message
  after that answer (its `raw` text when the message has one; a rewound prompt
  is no reply), absent until there is one. The timeline owns one
  `ConversationRepliesContext` store (`markdown/conversationReplies.ts`) and
  replaces its map from canonical history; `CodeBlock` subscribes to its own
  answer's entry only (keyed by the `MarkdownDoc` `keyBase`, which is the
  message id), so a new message re-renders just the fences whose reply
  changed. A renderer whose buttons send messages uses it to show itself
  answered after a reload; chat blocks match it exactly against the messages
  the block can send.
- A renderer that throws is caught by `FenceErrorBoundary` and replaced by
  `source`; the canonical message text is never lost.
- The fence text is already canonical assistant history. Renderer state
  (sort, filter, selection) is presentation-only and is never appended as an
  event. Anything model-visible goes through the normal conversation path
  (`host.conversation.send`/`insert`), triggered only by an explicit user
  action.
- Reuse the Markdown URL policy (`sanitizeImageSrc`, `sanitizeLinkHref` from
  `apps/web/src/markdown.tsx`); never render agent-supplied HTML, CSS or
  script.

### 4.12 Markdown rendering (`MarkdownDoc`)

`apps/web/src/markdown/render.tsx` renders canonical assistant text (chat,
multirun/fusion output, file preview) through one path: `parseMarkdown` → URL
sanitizing → leaves. `MarkdownDoc` takes `frontmatter`, `conversation` and
`resourceContext` flags; `CodeBlock` hands every fenced block to
`host.markdown.registerFence` first (§4.11). The fence `info` prop is the raw
opening-line info string (see §4.11) and the `conversation` flag is true only
for an agent's answer in the timeline, so a renderer that runs code waits for a
click everywhere else.

- **Grammar.** GFM-shaped, forgiving where chat output is sloppy. A list item
  owns every following line indented past its marker: continuation text, a
  nested list, a step's indented code fence (a fence it opens runs to its close
  whatever the indentation) and blank-line-separated paragraphs, so numbering
  never restarts after a code block. An ordered list keeps its first number
  (`<ol start>`); any item line, also right under a paragraph line, starts a
  list. A mixed task list keeps the plain items' bullets and hangs each task box
  in the marker gutter. A fence may be indented (stripped from its lines) and
  closes only on a run at least as long as its opener. Tables keep GFM column
  alignment (as logical `start`/`center`/`end`), `\|` inside a cell and the
  header's column count. Inline: backslash escapes, `_em_`/`__strong__` (never
  inside a word, so `snake_case` stays text), `<br>`, `<url>` autolinks, `\(…\)`
  and `\[ … \]` math; a bare URL or file path leaves the sentence's closing
  punctuation (and an unbalanced `)`) outside the link. Chat bubbles keep a
  writer's single newlines (`white-space: pre-line`); file preview keeps
  CommonMark soft breaks. A quote renders `blockquote.md-quote` and a rule
  `hr.md-hr` on every surface (styles in `styles.css`, not per package).
- **Videos.** `isVideoSource` (`markdown/sanitize.ts`) recognises video files.
  An image-syntax destination that is a video renders as a `<video controls>`
  player instead of a thumbnail, under the same image URL policy (an unsafe
  source still shows the blocked-source text). A paragraph that is exactly one
  bare http(s) autolink to a video file renders the same player plus a small
  caption link. Videos are not gallery entries: `collectImages` skips them, so
  they never appear in the lightbox.
- **Frontmatter (`MarkdownDoc frontmatter`).** In file preview only (off by
  default), `splitFrontmatter` (`markdown/parse.ts`) turns leading `---` … `---`
  frontmatter into a properties table instead of an `<hr>` and raw keys.
  Detection is strict: the very first line must be exactly `---` and a `---`/`...`
  closing fence must appear within 200 lines; every top-level line inside must be
  a simple `key: value` (or a skipped `#` comment, an indented continuation, or a
  `- item` list entry) — a block with prose between the rules is not frontmatter
  and returns `null`, so no text is ever dropped. Caps: 500 characters per value
  (a value cut short ends in `…`) and 50 properties; `splitFrontmatter` also
  returns `dropped`, the number of properties the cap left out, and `MarkdownDoc`
  renders a last muted `+N more` row (`markdown.render.moreProperties`).

## 5. Public vs internal API

**Public, package-facing (stable seams):**

- `@polyth/web-sdk` — everything in `packages/web-sdk/src/index.ts`.
- `@polyth/contracts` — types, `UiSlot`/`UI_SLOTS`, event shapes, widget
  descriptor types.
- `@polyth/plugins` — the server-side package host.

**Host implementation details (do not import from packages):**

- `apps/web/src/slots.ts`, `widgets/catalog.ts`, `surfaces.ts`,
  `workspace/surfaceRegistry.ts`, `capabilities.ts`, `settings/registry.ts`,
  `packages/*` registry internals — the web-sdk host wraps these; feature
  code goes through the host.
- `window.__polythSlots` / `__polythWidgets` / `__polythSurfaces` /
  `__polythCapabilities` — legacy out-of-tree
  browser-script seams, still exported at boot for compatibility. In-tree
  packages must not use them; use `@polyth/web-sdk`.

## 6. Generic shell imports (the documented exception)

Package web code may import a **bounded set** of generic shell modules
(shared stores, i18n, UI primitives, pure helpers, the widget catalog/layout
types). The authoritative allowlist is the `GENERIC_SHELL_IMPORTS` set in
`apps/web/test/packageContainment.test.ts` — read it before importing
anything from `apps/web/src` in a package, and never extend it to smuggle a
feature implementation into the shell. Everything else (feature views,
feature state, feature API clients, feature helpers) belongs in the package.
Reviewed generic shell services also include project presentation sync, canonical
resource navigation, session activity presentation and the shared project glyph,
and the chat's presentation primitives a package conversation reuses so it reads
like Chat: the attachment pill row (`AttachmentPills`, with `uploadInboxFile`
in `attachments.ts` for a composer that keeps its own pills), the live line swap
(`ActivityTicker`) and the step presentation and glyph (`execution.ts`,
`ExecutionIcon`).
Workflow history may observe only `listSurfaces` and `useSurfaceVersion` to wait
for its lazy surface; package code does not gain registry mutation access.
The reverse rule is enforced too: `apps/web` imports feature packages only
from the documented shell integration points. `GENERIC_PACKAGE_IMPORTS` checks
specific importer/export pairs for existing host responsibilities: account
settings sync consumes model preferences, bootstrap and package lifecycle
consume the model runtime catalog, extension command admission and dispatch
consume the commands catalog, and the response footer seeds a multirun prompt
through its public browser helper. These approvals cover only the named
exports at those call sites; other subpaths in the same files remain rejected.
They do not permit feature views or backend package roots to enter the shell.

The host's cumulative transcript editor (`composer/transcriptSpan.ts`) and
Markdown image lightbox (`markdown/ImageLightbox.tsx`) are generic primitives,
independent of the Dictation and Gallery package implementations. The lightbox
is an adapter over the shared full-screen viewer
(`components/AttachmentPreview.tsx`), which attachments and tool images also
use: close button, pinch / double-tap zoom for images, and for several items a
counter, arrows, swipe, arrow keys and a thumbnail strip.

## 7. Disposal, lifecycle, and failure isolation

- Every `host.*.register*` returns an `Unregister`. The activation scope also
  tracks host registrations and disposes them on package disable, even if a
  package author forgets one callback. Still return cleanup for timers and
  other non-host resources.
- Cross-owner collisions throw. Same-owner replacement is identity-safe; a
  superseded unregister is a no-op.
- Slot contributions and widget instances render inside their own error
  boundaries — a broken contribution disappears alone. A broken project-context
  snapshot is isolated the same way.
- Package catalog metadata loads for every installed web package; modules and
  CSS load only for enabled packages. A failed bundle logs and retries on a
  later enable without taking other packages down.

## 8. Tests expected for UI work

- Registry logic (pure, DOM-free): `apps/web/test/slots.test.ts`,
  `surfaces.test.ts`, `workspaceSurfaces.test.ts`, `widgetCatalog.test.ts`,
  `widgetLayout.test.ts`, `settingsRegistry.test.ts`, `capabilities.test.ts`.
- Entry loading: `apps/web/test/webEntries.test.ts`,
  `packageActivation.test.ts`, `packageLifecycle.test.ts`,
  `webPackageDiscovery.test.ts`, `packageRegistry.test.ts`,
  `packageContainment.test.ts` (boundaries), `packageWorkspace.test.ts`
  (filter/layout unit tests), `projectContext.test.ts`.
- Mounted-slot rendering: `slotHostMounted.test.ts`,
  `workspaceHostMounted.test.ts`, `widgetWorkspaceUx.test.ts`.
- Phone layer stack: `mobileLayerStack.test.ts` (decisions),
  `mobileLayerStackMounted.test.ts` (Workspace layer lifecycle, the
  keep-alive resume-target regression, Close forgetting the package),
  `paneCloseFocus.test.ts` (no text entry takes focus on a touch close),
  `stackNavigation.test.ts` (real
  Chromium geometry: layer order, RTL, no exposed Chat, tap swallowing),
  `edgeSwipeBack.test.ts` and `mobileGestures.test.ts` (interactive Back),
  `swipeSurface.test.ts` (claiming, yielding, release, hand-off lifetimes),
  `shellSwipe.test.ts` (gates, setting), `phoneShellSwipes.test.ts` (mounted
  Navigator/Workspace peek, open, cancel, close, setting and top-layer gates),
  `stackNavigation.test.ts` "a released swipe…" (Chromium hand-off geometry)
  and "a Workspace that settled back…" (no forwards fill under the next
  swipe), `nativeMobile.test.ts` (native Back pops one layer).
- Desktop package window motion: `packageWindowMotion.test.ts` (Chromium:
  the floating glide's geometry and compositor-only properties, the docked
  content's fixed width, one clock per window, RTL, a moved window, the
  focused split's rail side, reduced motion), `packageWindowExitMounted.test.ts`
  (kept-alive panes stay mounted through an exit), `packageWindow.test.ts`
  (the CSS and `ContextRail` contract).
- Surface motion: `surfaceMotion.test.ts` (Chromium: exit ghosts, phone
  Settings arrival edge, stages and dismissal, the covered Navigator, sheet and
  dialog edges, the toast, the RTL-mirrored tablet drawer; plus the exit
  wiring), `sheetDrag.test.ts` (drag-to-dismiss), `swipeSurface.test.ts`
  (catch-up, catching a spring-home, lost touches, owners, extent),
  `settingsNavigation.test.ts` "phone Settings knows the edge…" (origin, stage
  stack, native Back), `workspaceEditor.test.ts` "the Workspace leads with
  Back…", `attachmentPreviewGestures.test.ts` (media viewer paging,
  pull-down, and a zoomed image that never pages), `mediaZoom.test.ts` (pinch,
  double tap, pan bounds, no close click after a drag).
- Rail drag: `railDrag.test.ts` (preview and persist model, the removal
  distance and its hysteresis), `railDragRemove.test.ts` (mounted pointer drag:
  the verdict, put-back near a rail, off screen and on a rail that cannot lose
  the icon, the poof's lifecycle, reduced motion), `railExternalDrag.test.ts`
  (icons dragged in from a window), `headerRail.test.ts` (`removeRailItem`).
- Feature UI logic that is DOM-free lives in the package's own
  `packages/<feature>/test/` (plain `node:assert`, `node --test`).

## 9. Review checklist (web UI work)

- [ ] Correct owner: feature UI in `packages/<feature>/widgets/`, not `apps/web`
- [ ] Registration through `@polyth/web-sdk`, not host internals or `window.*`
- [ ] Existing `UiSlot` used; no host edits for a feature
- [ ] Existing primitive checked before creating another (see `components.md`)
- [ ] Canonical tokens used; CSS scoped to the package root (`styles.md`)
- [ ] Container/mobile behavior considered
- [ ] Focus/keyboard/error/loading/empty states considered where applicable
- [ ] Disposal implemented for every registration/subscription
- [ ] Model-visible content appended before display; UI state not logged
- [ ] Relevant tests added/updated; package containment respected
- [ ] All consumers checked after any shared contract change
